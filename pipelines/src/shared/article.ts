/**
 * Parser for the matcha-pipeline articles file format.
 *
 * Format (matches /home/velvet/vault/raw/inbox/YYYY-MM-DD-articles.md):
 *
 *   ---
 *   <YAML frontmatter>
 *   ---
 *
 *   # Raw Articles — YYYY-MM-DD
 *
 *   > blurb
 *
 *   ---
 *   ### Collected at HH:MM
 *   ### N new articles
 *
 *   #### Field Name
 *   - [Title](url) *(Source)* — optional snippet
 *   - [Title](url) *(Source)*
 *   ...
 *
 *   #### Another Field
 *   - ...
 */

export interface Article {
  title: string;
  url: string;
  source: string | null;
  field: string;
  snippet: string | null;
}

const FIELD_HEADING = /^####\s+(.+?)\s*$/;
// - [title](url) *(source)* — snippet
//   Snippet is optional; source is optional; URL may be a bare DOI.
const ARTICLE_LINE = /^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+\*\(([^)]+)\)\*)?(?:\s+—\s+(.*))?$/;

export function parseArticles(markdown: string): Article[] {
  const lines = markdown.split('\n');
  const articles: Article[] = [];
  let currentField = 'Uncategorized';
  let inFrontmatter = false;
  let pastFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Frontmatter block: first line `---` opens, next `---` closes.
    if (!pastFrontmatter && line === '---') {
      if (!inFrontmatter && i === 0) {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        inFrontmatter = false;
        pastFrontmatter = true;
        continue;
      }
    }
    if (inFrontmatter) continue;

    const fieldMatch = FIELD_HEADING.exec(line);
    if (fieldMatch) {
      currentField = fieldMatch[1]!.trim();
      continue;
    }

    const articleMatch = ARTICLE_LINE.exec(line);
    if (articleMatch) {
      articles.push({
        title: articleMatch[1]!.trim(),
        url: articleMatch[2]!.trim(),
        source: articleMatch[3]?.trim() ?? null,
        field: currentField,
        snippet: articleMatch[4]?.trim() ?? null,
      });
    }
  }

  return articles;
}
