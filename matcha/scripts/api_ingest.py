#!/usr/bin/env python3
"""api_ingest.py - Fast API ingestion for matcha's curated digest."""
import sys, re, time, json, os, urllib.request, urllib.parse, urllib.error
from datetime import datetime
from collections import defaultdict
from difflib import SequenceMatcher
from concurrent.futures import ThreadPoolExecutor
import xml.etree.ElementTree as ET

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MATCHA_DIR = os.path.dirname(SCRIPT_DIR)
API_OUT = os.path.join(SCRIPT_DIR, "api-articles.jsonl")
DIGEST_OUT = os.path.join(SCRIPT_DIR, "api-digest.md")
API_MAX_RESULTS = int(os.environ.get("API_MAX_RESULTS", "6"))
MIN_OUTPUT_ABSTRACT_CHARS = int(os.environ.get("MIN_OUTPUT_ABSTRACT_CHARS", "80"))
MAX_OUTPUT_ABSTRACT_CHARS = int(os.environ.get("MAX_OUTPUT_ABSTRACT_CHARS", "1200"))

CORE_QUERIES = [
    ("large language models transformer reinforcement learning", "AI/ML",
     ["OpenAlex", "arXiv", "Crossref", "NCBI"]),
    ("synthetic biology drug discovery biotech AI", "Biotech",
     ["Europe PMC", "OpenAlex", "NCBI"]),
    ("quantum computing quantum information physics", "Physics",
     ["INSPIRE-HEP", "arXiv", "OpenAlex"]),
    ("semiconductor chip EUV lithography nanotech", "Semiconductor",
     ["Crossref", "OpenAlex"]),
    ("climate energy storage battery renewable", "Energy/Climate",
     ["Zenodo", "OpenAlex"]),
    ("deep learning computer vision AI architecture", "AI/ML",
     ["arXiv", "Crossref", "OSF"]),
    ("cybersecurity cryptography threat intelligence", "Cybersecurity",
     ["INSPIRE-HEP", "arXiv", "Crossref"]),
    ("robotics autonomous systems reinforcement", "Robotics",
     ["arXiv", "OpenAlex", "OSF"]),
    ("space technology aerospace satellite", "Space/Aerospace",
     ["arXiv", "Zenodo", "OpenAlex"]),
    ("nuclear fusion energy technology", "Nuclear/Fusion",
     ["INSPIRE-HEP", "OpenAlex"]),
    ("materials science MOF nanomaterial", "Materials Science",
     ["Zenodo", "Crossref", "OpenAlex"]),
]

INTERESTS = {
    "core": ["large language model", "llm", "gpt", "transformer", "reinforcement",
             "neural", "deep learning", "ai", "agi", "alignment", "robotics",
             "synthetic biolo", "drug discovery", "quantum com", "semiconductor",
             "chip", "EUV", "lithography", "climate", "battery", "energy storage",
             "renewable", "nanotech", "fusion", "nuclear", "space"],
    "people": ["lecun", "hinton", "schulman"],
    "companies": ["deepmind", "google", "meta", "microsoft", "openai", "anthropic"],
}


def req(url, timeout=15):
    try:
        r = urllib.request.Request(url, headers={"User-Agent": "Matcha/1.0"})
        resp = urllib.request.urlopen(r, timeout=timeout)
        return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def req_with_retry(url, max_retries=2, base_delay=2.0, timeout=15):
    """Fetch with exponential backoff for rate-limited APIs."""
    for attempt in range(max_retries + 1):
        try:
            r = urllib.request.Request(url, headers={"User-Agent": "Matcha/1.0"})
            resp = urllib.request.urlopen(r, timeout=timeout)
            return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                delay = base_delay * (2 ** attempt)
                print(f"  ⏳ RATE LIMITED: {url.split('/')[2]} — retrying in {delay:.1f}s")
                time.sleep(delay)
            else:
                return ""
        except Exception:
            return ""
    print(f"  ⚠️ GAVE UP: {url.split('/')[2]} after {max_retries + 1} attempts")
    return ""


def parse_scholar(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("data", [])
    arts = []
    for d in items:
        t = d.get("title", "")
        if isinstance(t, list):
            t = t[0] if t else ""
        if not t or t in ("None", ""):
            continue
        t = str(t)[:200]
        url = d.get("url", "") or ""
        if isinstance(url, list) and url:
            url = url[0]
        if isinstance(url, dict) and url:
            url = list(url.values())[0] if url else ""
        date_s = str(d.get("year", "") or "")
        date = None
        if date_s and len(date_s) == 4:
            date = datetime.strptime(date_s, "%Y")
        cats = d.get("fieldsOfStudy", [])
        domain = cats[0] if cats else "AI/ML"
        arts.append({"title": t, "abstract": "", "url": url, "date": date,
                     "source": "Semantic Scholar", "domain": domain,
                     "citations": int(d.get("citationCount") or 0),
                     "year": date_s, "abstract_short": ""})
    return arts


def parse_openalex(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("results", [])
    arts = []
    for d in items:
        t = d.get("title", "") or ""
        if not t or t in ("None", ""):
            continue
        t = str(t)[:200]
        url = d.get("open_access_url", "") or d.get("oai_url", "") or ""
        pub = d.get("publication_date", "")
        date = None
        if pub and len(pub) == 10:
            try:
                date = datetime.strptime(pub, "%Y-%m-%d")
            except ValueError:
                pass
        cats = d.get("best_oa_location", {}).get("host_type", "") if d.get("best_oa_location") else ""
        fields = d.get("topics", [])
        domain = fields[0].get("display_name", "uncategorized") if fields else "uncategorized"
        abstract = d.get("abstract_inverted_index", {}) or {}
        ab = " ".join(w for w in abstract.keys() for _ in abstract.get(w, [])) if abstract else ""
        arts.append({"title": t, "abstract": ab[:2000], "url": url, "date": date,
                     "source": "OpenAlex", "domain": domain,
                     "citations": int(d.get("cited_by_count", 0) or 0),
                     "year": str(date.year) if date else "", "abstract_short": ab[:100]})
    return arts


def parse_crossref(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("message", {}).get("items", [])
    arts = []
    for d in items:
        # Crossref may have title as string or list
        t = d.get("title", "")
        if isinstance(t, list):
            t = t[0] if t else ""
        if not t or t in ("None", ""):
            continue
        t = str(t)[:200]
        url = d.get("DOI", "") or d.get("link", [{}])[0].get("URL", "") or ""
        if isinstance(d.get("link"), list):
            url = d["link"][0].get("URL", "") if d["link"] else url
        pub = d.get("published-print", d.get("published-online", d.get("created", {})))
        date_s = str(pub.get("date-parts", [[]])[0][0] if isinstance(pub, dict) else pub)[:10]
        date = None
        if date_s and len(date_s) == 10:
            try:
                date = datetime.strptime(date_s, "%Y-%m-%d")
            except ValueError:
                pass
        abstract = d.get("abstract", "") or ""
        arts.append({"title": t, "abstract": abstract, "url": url, "date": date,
                     "source": "Crossref", "domain": d.get("category", ["uncategorized"])[0],
                     "citations": int(d.get("is-referenced-by-count", 0) or 0),
                     "year": str(date.year) if date else "", "abstract_short": abstract[:100]})
    return arts


def parse_arxiv(raw):
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return []
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    arts = []
    for entry in root.findall("atom:entry", ns):
        title_elm = entry.find("atom:title", ns)
        summary_elm = entry.find("atom:summary", ns)
        pub_elm = entry.find("atom:published", ns)
        id_elm = entry.find("atom:id", ns)
        title = (title_elm.text or "").strip().replace("\n", " ")
        abstract = (summary_elm.text or "").strip() if summary_elm is not None else ""
        pub = (pub_elm.text or "")[:10] if pub_elm is not None else ""
        url = (id_elm.text or "").strip() if id_elm is not None else ""
        date = None
        if pub and len(pub) == 10:
            try:
                date = datetime.strptime(pub, "%Y-%m-%d")
            except ValueError:
                pass
        arts.append({"title": title[:200], "abstract": abstract, "url": url,
                     "date": date, "source": "arXiv", "domain": "arxiv",
                     "citations": 0, "year": str(date.year) if date else "",
                     "abstract_short": abstract[:100]})
    return arts


def parse_zenodo(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("hits", {}).get("hits", [])
    arts = []
    for d in items:
        meta = d.get("metadata", {})
        t = meta.get("title", "")
        if not t or t in ("None", ""):
            continue
        t = str(t)[:200]
        url = d.get("id", meta.get("doi", "")) or ""
        date_s = meta.get("publication_date", meta.get("created", "2020-01-01")) or "2020-01-01"
        date = None
        if date_s and len(date_s) == 10:
            try:
                date = datetime.strptime(date_s, "%Y-%m-%d")
            except ValueError:
                pass
        abstract = meta.get("description", "") or ""
        concepts = [(c.get("description", ""), 1) for c in meta.get("related_doi", [])]
        domain = "uncategorized"
        arts.append({"title": t, "abstract": abstract, "url": url, "date": date,
                     "source": "Zenodo", "domain": domain,
                     "citations": int(d.get("stats", {}).get("downloads", 0) or 0),
                     "year": str(date.year) if date else "", "abstract_short": abstract[:100]})
    return arts


def parse_doaj(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("results", [])
    arts = []
    for d in items:
        bib = d.get("bibliographic", "")
        if not bib:
            continue
        t = bib.split(":", 1)[0] if ":" in bib else bib
        if not t or t in ("None", ""):
            continue
        t = str(t)[:200]
        doi = d.get("doi", "")
        url = f"https://doaj.org/article/{doi}" if doi else ""
        arts.append({"title": t, "abstract": "", "url": url, "date": None,
                     "source": "DOAJ", "domain": "scientific_journal",
                     "citations": 0, "year": "", "abstract_short": ""})
    return arts


def fetch_api(source_name, query, max_results=12):
    """Fetch from a specific API source."""
    if source_name == "Semantic Scholar":
        url = (f"https://api.semanticscholar.org/graph/v1/paper/search?"
               f"query={urllib.parse.quote(query)}&limit={min(max_results,50)}&fields=title,url,year,fieldsOfStudy,citationCount")
        raw = req_with_retry(url, max_retries=2, base_delay=3.0)
        return parse_scholar(raw) if raw else []
    elif source_name == "OpenAlex":
        url = (f"https://api.openalex.org/works?"
               f"search={urllib.parse.quote(query)}&per_page={min(max_results,50)}&mailto=velvetmoon222999@gmail.com")
        raw = req(url)
        return parse_openalex(raw) if raw else []
    elif source_name == "Crossref":
        url = (f"https://api.crossref.org/works?"
               f"query={urllib.parse.quote(query)}&rows={min(max_results,50)}&mailto=velvetmoon222999@gmail.com")
        raw = req(url)
        return parse_crossref(raw) if raw else []
    elif source_name == "arXiv":
        url = f"http://export.arxiv.org/api/query?search_query={urllib.parse.quote(query)}&start=0&max_results={min(max_results,50)}"
        raw = req(url)
        return parse_arxiv(raw) if raw else []
    elif source_name == "Zenodo":
        url = f"https://zenodo.org/api/records?q={urllib.parse.quote(query)}&size={min(max_results,50)}"
        raw = req(url)
        return parse_zenodo(raw) if raw else []
    elif source_name == "DOAJ":
        # DOAJ v2 API
        url = f"https://doaj.org/api/search/articles/bibliographic?q={urllib.parse.quote(query)}&size={min(max_results,50)}"
        raw = req(url)
        return parse_doaj(raw) if raw else []
    elif source_name == "Europe PMC":
        # Europe PMC is rate-limited - use retry with backoff
        url = (f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?"
               f"query={urllib.parse.quote(query)}&format=json&resultType=core&pageSize={min(max_results,20)}")
        raw = req_with_retry(url, max_retries=2, base_delay=3.0)
        return parse_europe_pmc(raw) if raw else []
    elif source_name == "INSPIRE-HEP":
        url = (f"https://inspirehep.net/api/literature?"
               f"query={urllib.parse.quote(query)}&size={min(max_results,50)}")
        raw = req(url)
        return parse_inspire(raw) if raw else []
    elif source_name == "NCBI":
        # NCBI E-utilities rate-limited (3 req/sec) - use retry
        url = (f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
               f"db=pubmed&term={urllib.parse.quote(query)}&retmax={min(max_results,50)}"
               f"&retmode=json")
        raw = req_with_retry(url, max_retries=2, base_delay=2.0)
        return parse_ncbi(raw) if raw else []
    elif source_name == "OSF":
        url = (f"https://api.osf.io/v2/preprints/?filter={urllib.parse.quote(query)}"
               f"&page[size]={min(max_results,50)}")
        raw = req(url)
        return parse_osf(raw) if raw else []
    elif source_name == "Core.ac.uk":
        # DISABLED - requires API key, rate-limits without one
        return []
    elif source_name == "OpenReview":
        # DISABLED - requires auth token, returns empty without it
        return []
    elif source_name == "PapersWithCode":
        # DISABLED - TLS handshake failure on server side
        return []
    elif source_name == "Semantic Scholar":
        # DISABLED - rate-limited, will revisit later
        return []
    return []


def parse_europe_pmc(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("resultList", {}).get("result", [])
    arts = []
    for d in items:
        t = d.get("title", "") or ""
        if not t or t in ("None", ""):
            continue
        t = str(t)[:200]
        date_s = d.get("publishDate", "") or ""
        date = None
        if date_s and len(date_s) == 10:
            try:
                date = datetime.strptime(date_s, "%Y-%m-%d")
            except ValueError:
                pass
        abstract = d.get("abstractText", "") or d.get("openAccessPdf", {}).get("textContent", "") or ""
        url = d.get("pmc", "") or d.get("isOpenAccess", False)
        url_str = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{url}" if url and str(url) != "False" else ""
        arts.append({"title": t, "abstract": abstract, "url": url_str, "date": date,
                     "source": "Europe PMC", "domain": "biomedical",
                     "citations": int(d.get("pmcRefCount", d.get("journalVolume", 0)) or 0),
                     "year": str(date.year) if date else "", "abstract_short": abstract[:100]})
    return arts


def parse_inspire(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return []
    hits = data.get("hits", {}).get("hits", [])
    arts = []
    for h in hits:
        meta = h.get("metadata", {})
        if not isinstance(meta, dict):
            continue
        # Title: metadata.title can be [], None, str, or nested dict
        raw_t = meta.get("title", None)
        if isinstance(raw_t, list) and raw_t:
            raw_t = raw_t[0] if isinstance(raw_t[0], str) else (raw_t[0].get("title", "") if isinstance(raw_t[0], dict) else "")
        if isinstance(raw_t, dict):
            raw_t = raw_t.get("title", "")
        t = raw_t or h.get("record_metadata", {}).get("title", {}).get("title", "INSPIRE Record #" + str(h.get("id", "???")))
        if not t or t in ("None", "", "N/A"):
            t = "INSPIRE Record #" + str(h.get("id", "???"))
        t = str(t)[:200]
        # DOI from metadata or links
        doi = meta.get("doi", "") or (h.get("record_metadata", {}).get("inspire_ids", {}).get("journal", {}).get("issue", "") or h.get("record_metadata", {}).get("inspire_ids", {}).get("doi", {}).get("value", "") or "")
        url = "https://inspirehep.net/literature/" + str(h.get("id", "")) if h.get("id") else ""
        # Year from publication_info
        pub_info = meta.get("publication_info", [])
        date_s = "2020"
        if isinstance(pub_info, list) and len(pub_info) > 0 and isinstance(pub_info[0], dict):
            year = pub_info[0].get("year") or pub_info[0].get("year", "")
            date_s = str(year) if year else "2020"
        date = None
        if date_s and len(str(date_s)) == 4:
            try:
                date = datetime.strptime(str(date_s), "%Y")
            except ValueError:
                date = None
        # Abstract
        abstracts = meta.get("abstracts", [])
        abstract = ""
        if isinstance(abstracts, list) and len(abstracts) > 0 and isinstance(abstracts[0], dict):
            abstract = abstracts[0].get("value", "") or ""
        citations = meta.get("citation_count", 0)
        citations = int(citations) if isinstance(citations, (int, float)) else 0
        arts.append({"title": t, "abstract": abstract, "url": url, "date": date,
                     "source": "INSPIRE-HEP", "domain": "physics",
                     "citations": citations,
                     "year": str(date.year) if date else "", "abstract_short": abstract[:100]})
    return arts


def parse_ncbi(raw):
    """Parse NCBI E-utilities search results."""
    try:
        data = json.loads(raw)
    except Exception:
        return []
    ids = data.get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []
    arts = []
    for pid in ids[:min(50, len(ids))]:
        summary_url = f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id={pid}&retmode=json"
        summ_raw = req(summary_url)
        if not summ_raw:
            continue
        try:
            summ = json.loads(summ_raw)
        except Exception:
            continue
        docs = summ.get("result", {})
        if str(pid) not in docs:
            continue
        d = docs[str(pid)]
        t = d.get("title", "No Title")
        ab = d.get("abstract", "")
        pub_date = d.get("pubdate", "")
        date = None
        if pub_date and pub_date != "":
            try:
                date = datetime.strptime(pub_date, "%Y")
            except ValueError:
                pass
        arts.append({"title": t, "abstract": ab, "url": f"https://pubmed.ncbi.nlm.nih.gov/{pid}/",
                     "date": date, "source": "NCBI", "domain": "biomedical",
                     "citations": 0, "year": str(date.year) if date else "",
                     "abstract_short": ab[:100]})
    return arts


def parse_osf(raw):
    """Parse OSF preprint results."""
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("data", [])
    arts = []
    for d in items:
        attrs = d.get("attributes", {})
        t = attrs.get("title", "") or attrs.get("name", "")
        if not t or t in ("None", ""):
            continue
        t = str(t)[:200]
        ab = attrs.get("description", "") or ""
        date_s = attrs.get("date_created", "") or attrs.get("date_published", "")
        date = None
        if date_s and len(date_s) >= 10:
            try:
                date = datetime.strptime(date_s[:10], "%Y-%m-%d")
            except ValueError:
                pass
        url = d.get("links", {}).get("self", "") or attrs.get("url", "")
        category = attrs.get("subjects", ["preprint"])
        if isinstance(category, list) and len(category) > 0:
            s = category[0]
            if isinstance(s, dict):
                category = s.get("full", s.get("text", "preprint"))
            elif isinstance(s, str):
                category = s
            else:
                category = "preprint"
        elif isinstance(attrs.get("subjects"), str):
            category = attrs["subjects"]
        else:
            category = attrs.get("category", "preprint")
        arts.append({"title": t, "abstract": ab[:2000], "url": url, "date": date,
                     "source": "OSF", "domain": category,
                     "citations": 0, "year": str(date.year) if date else "",
                     "abstract_short": ab[:100]})
    return arts


def parse_core(raw):
    """Parse Core.ac.uk search results."""
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("data", [])
    if not items:
        # Try alternative response shape
        items = data.get("results", [])
    arts = []
    for d in items:
        t = d.get("title", "") or ""
        if not t or t == "None":
            continue
        t = str(t)[:200]
        ab = (d.get("abstract", "") or "")[:2000]
        url = d.get("full_text_url", "") or d.get("doi_url", "") or ""
        if not url and d.get("doi", ""):
            url = f"https://doi.org/{d['doi']}"
        pub = d.get("publication_year", "") or d.get("year", "")
        date = None
        if pub:
            try:
                date = datetime.strptime(str(pub)[:4], "%Y")
            except ValueError:
                pass
        subjects = d.get("subjects", [])
        domain = subjects[0] if subjects else "academic"
        arts.append({"title": t, "abstract": ab, "url": url, "date": date,
                     "source": "Core.ac.uk", "domain": str(domain),
                     "citations": int(d.get("citation_count", 0) or 0),
                     "year": str(pub), "abstract_short": ab[:100]})
    return arts


def parse_openreview(raw):
    """Parse OpenReview search results (NeurIPS/ICLR/ICML papers)."""
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("notes", [])
    arts = []
    for d in items:
        content = d.get("content", {})
        t = content.get("title", "") or ""
        if not t or t == "None":
            continue
        t = str(t)[:200]
        ab = (content.get("abstract", "") or content.get("tl;dr", "") or "")[:2000]
        url = d.get("forum", "") or ""
        if url and not url.startswith("http"):
            url = f"https://openreview.net/forum?id={url}"
        pub = d.get("cdate", "") or d.get("tcdate", "") or d.get("date", "")
        date = None
        if pub:
            # OpenReview uses Unix timestamps (ms)
            try:
                pub_ts = float(pub) / 1000
                date = datetime.fromtimestamp(pub_ts)
            except (ValueError, OSError, OverflowError):
                pass
        venue = content.get("venue", d.get("venueid", "OpenReview"))
        arts.append({"title": t, "abstract": ab, "url": url, "date": date,
                     "source": "OpenReview", "domain": str(venue),
                     "citations": 0, "year": str(date.year) if date else "",
                     "abstract_short": ab[:100]})
    return arts


def parse_paperswithcode(raw):
    """Parse Papers With Code results (ML papers with code + benchmarks)."""
    try:
        data = json.loads(raw)
    except Exception:
        return []
    items = data.get("results", [])
    arts = []
    for d in items:
        t = d.get("title", "") or ""
        if not t or t == "None":
            continue
        t = str(t)[:200]
        ab = (d.get("abstract", "") or "")[:2000]
        url = d.get("paper_link", "") or d.get("open_review_paper_link", "") or ""
        if d.get("arxiv_id", ""):
            url = f"https://arxiv.org/abs/{d['arxiv_id']}"
        pub = d.get("year", "") or d.get("month", "")
        date = None
        if pub:
            try:
                date = datetime.strptime(str(pub)[:4], "%Y")
            except ValueError:
                pass
        tasks = d.get("tasks", [])
        domain = tasks[0].get("task", {}).get("name", "ML") if tasks else "ML"
        code_url = d.get("github_link", "") or d.get("primary_site_link", "")
        if code_url:
            ab = f"[Code: {code_url}] " + ab
        arts.append({"title": t, "abstract": ab, "url": url, "date": date,
                     "source": "PapersWithCode", "domain": str(domain),
                     "citations": 0, "year": str(pub), "abstract_short": ab[:100]})
    return arts


def score_article(a, interests):
    title = a.get("title", "").lower()
    rel = 0
    for kw in interests["core"]:
        if kw in title:
            rel += 10
    rel = min(rel, 100)
    recency = 80
    d = a.get("date")
    if d:
        days = (datetime.now() - d).days
        recency = max(10, 100 - days * 10)
    return 0.6 * rel + 0.3 * recency + 0.1 * 50


def dedup_articles(articles):
    scored = sorted(articles, key=lambda a: a.get("total_score", 0), reverse=True)
    unique = []
    seen = set()
    for a in scored:
        key = a["title"].lower().strip()
        dup = any(SequenceMatcher(None, key, s).ratio() > 0.85 for s in seen if s)
        if not dup and key:
            seen.add(key)
            unique.append(a)
    return unique


def output_abstract(article):
    abstract = article.get("abstract", "") or article.get("abstract_short", "") or ""
    abstract = re.sub(r"\s+", " ", str(abstract)).strip()
    return abstract[:MAX_OUTPUT_ABSTRACT_CHARS]


def has_usable_abstract(article):
    return len(output_abstract(article)) >= MIN_OUTPUT_ABSTRACT_CHARS


def main():
    start = time.time()
    print("=" * 50)
    print("api_ingest.py  (fast mode)")
    print("=" * 50)

    all_articles = []
    source_stats = defaultdict(int)

    # Collect from all source+query combinations
    for query, domain, sources in CORE_QUERIES:
        for source_name in sources:
            t0 = time.time()
            try:
                articles = fetch_api(source_name, query, max_results=API_MAX_RESULTS)
                elapsed = time.time() - t0
                print(f"  {source_name:20s} | {query[:30]:30s} -> {len(articles):3d} articles ({elapsed:5.1f}s)", flush=True)
                for a in articles:
                    a["domain"] = domain
                    a["query"] = query
                source_stats[source_name] += len(articles)
                all_articles.extend(articles)
            except Exception as e:
                print(f"  {source_name} failed: {e}", file=sys.stderr)

    # Score and dedup
    scored = []
    for a in all_articles:
        s = score_article(a, INTERESTS)
        scored.append({**a, "relevance": s, "total_score": s})

    filtered = dedup_articles(scored)
    filtered = [a for a in filtered if a["total_score"] >= 10]
    filtered = [a for a in filtered if has_usable_abstract(a)]

    # Also merge RSS digest if available
    rss_path = os.path.join(MATCHA_DIR, "output", "filtered-digest.md")
    if os.path.isfile(rss_path):
        with open(rss_path) as f:
            rss_content = f.read()
        rss_articles = []
        for line in rss_content.split("\n"):
            m = re.search(r'(\S+) \[\S+\](\S+) \((\S+)\)', line)
            if m:
                rss_title = m.group(1)
                rss_url = m.group(3)
                rss_articles.append({"title": rss_title, "url": rss_url,
                                     "abstract": "", "date": None,
                                     "source": "matcha-feed", "domain": "existing",
                                     "citations": 0, "year": "",
                                     "abstract_short": "", "relevance": 40,
                                     "total_score": 45})
        combined = scored + rss_articles
        filtered = dedup_articles(combined)
        filtered = [a for a in filtered if a["total_score"] >= 10]
        filtered = [a for a in filtered if has_usable_abstract(a)]

    # Write JSONL output
    with open(API_OUT, "w") as f:
        for a in filtered:
            entry = {
                "title": a["title"],
                "url": a.get("url", ""),
                "abstract": output_abstract(a),
                "date": str(a["date"]) if isinstance(a.get("date"), datetime) else str(a.get("date", "")),
                "source": a["source"],
                "domain": a["domain"],
                "relevance": a.get("relevance", 0),
                "total_score": a.get("total_score", 0),
            }
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    # Write digest
    lines = [
        "# API-INGESTED DAILY DIGEST",
        f"{len(filtered)} unique articles across {len(source_stats)} sources",
        "---",
    ]
    by_domain = defaultdict(list)
    for a in filtered:
        by_domain[a["domain"]].append(a)

    for domain in sorted(by_domain.keys()):
        arts = sorted(by_domain[domain], key=lambda a: a["total_score"], reverse=True)[:5]
        top_sc = arts[0]["total_score"] if arts else 0
        lines.append("")
        lines.append(f"{domain} (Top: {round(top_sc, 1)})")
        for i, a in enumerate(arts):
            sc = round(a["total_score"], 1)
            lines.append(f"{i+1}. {a['title'][:70]}")
            lines.append(f"   [{a['source'][:15]}] Score:{sc}")

    lines.append(f"\n---\nAPI articles ({len(filtered)}) -> {API_OUT}")
    with open(DIGEST_OUT, "w") as f:
        f.write("\n".join(lines))

    elapsed = time.time() - start
    print(f"\nTotal: {len(filtered)} articles from {len(source_stats)} sources ({' + '.join(f'{s}={c}' for s,c in source_stats.items())})")
    print(f"Time: {elapsed:.1f}s")
    print(f"\n{'='*50}")
    print("TOP 10:")
    print(f"{'='*50}")
    top = sorted(filtered, key=lambda a: a["total_score"], reverse=True)[:10]
    for i, a in enumerate(top):
        sc = round(a["total_score"], 1)
        src = a["source"][:15]
        url = a.get("url", "")
        print(f"{i+1}. Score:{sc:<6} [{src:<15}] {a['title'][:60]}")
        if url:
            print(f"   {url[:80]}")
    print(f"\nAPI articles -> {API_OUT}")
    print("API digest   -> {DIGEST_OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
