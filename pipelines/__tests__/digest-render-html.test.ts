import { describe, expect, it } from 'vitest';

import { escapeHtml, renderDigestEmailHtml, sourceHref } from '../src/phases/digest/render-html.js';
import type { ClassifiedArticle } from '../src/shared/digest-types.js';

function item(overrides: Partial<ClassifiedArticle> = {}): ClassifiedArticle {
  return {
    bucket: 'focus',
    reason: 'directly useful for the current research plan',
    wikilinks: [],
    article: {
      title: 'A useful paper',
      url: 'https://example.org/paper',
      source: 'arXiv',
      field: 'AI / ML',
      snippet: null,
    },
    ...overrides,
  };
}

describe('renderDigestEmailHtml', () => {
  it('renders article titles as links to the original source URL', () => {
    const html = renderDigestEmailHtml({
      date: '2026-06-03',
      direction: 'AM',
      articles: [item().article],
      classified: [item()],
      vault: undefined,
    });

    expect(html).toContain('🍵 Chiya Daily Digest');
    expect(html).toContain('2026-06-03 · Morning edition');
    expect(html).toContain('href="https://example.org/paper"');
    expect(html).toContain('A useful paper');
    expect(html).toContain('arXiv · AI / ML');
  });

  it('escapes user/model/article text before inserting into HTML', () => {
    const html = renderDigestEmailHtml({
      date: '2026-06-03',
      direction: 'PM',
      articles: [],
      classified: [
        item({
          reason: 'contains <script>alert("x")</script> & quotes',
          article: {
            title: 'Title <b>bold</b> & more',
            url: 'https://example.org/?q=a&x=<bad>',
            source: 'Source <unsafe>',
            field: 'Field & Tag',
            snippet: null,
          },
        }),
      ],
      vault: undefined,
    });

    expect(html).toContain('Title &lt;b&gt;bold&lt;/b&gt; &amp; more');
    expect(html).toContain('contains &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; quotes');
    expect(html).toContain('Source &lt;unsafe&gt; · Field &amp; Tag');
    expect(html).not.toContain('<script>');
  });

  it('does not create fake links when source URL is missing', () => {
    const html = renderDigestEmailHtml({
      date: '2026-06-03',
      direction: 'AM',
      articles: [],
      classified: [
        item({
          article: { title: 'No URL item', url: '', source: 'OpenAlex', field: 'Science', snippet: null },
        }),
      ],
      vault: undefined,
    });

    expect(html).toContain('No URL item');
    expect(html).toContain('No source URL available');
    expect(html).not.toContain('href=""');
  });

  it('renders empty sections and library update fallback cleanly', () => {
    const html = renderDigestEmailHtml({
      date: '2026-06-03',
      direction: 'AM',
      articles: [],
      classified: [],
      vault: { logTail: '', claudeMd: '', tasteMd: '', indexMd: '', focuses: [], research: [], profile: null, interests: null },
    });

    expect(html).toContain('Nothing this cycle.');
    expect(html).toContain('No librarian activity in the recent log.');
  });
});

describe('sourceHref', () => {
  it('accepts http/https URLs and normalizes DOI values to doi.org links', () => {
    expect(sourceHref('https://example.org/a')).toBe('https://example.org/a');
    expect(sourceHref('http://example.org/a')).toBe('http://example.org/a');
    expect(sourceHref('10.1234/example')).toBe('https://doi.org/10.1234/example');
    expect(sourceHref('doi:10.1234/example')).toBe('https://doi.org/10.1234/example');
    expect(sourceHref('javascript:alert(1)')).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('escapes core HTML metacharacters', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
