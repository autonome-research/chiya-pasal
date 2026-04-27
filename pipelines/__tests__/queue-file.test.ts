import { describe, it, expect } from 'vitest';
import { parseQueueFile } from '../src/shared/queue-file.js';

// Real on-disk format: NO leading ---, frontmatter runs from line 1 until
// the first --- separator, then the body follows.
const SAMPLE_WITH_SNIPPET = `title: International Coordination and Support for SmallSat-enabled Space Weather Activities
source: arXiv
url: http://arxiv.org/abs/2011.04759v1
date:
batch: Space/Aerospace
---
# International Coordination and Support for SmallSat-enabled Space Weather Activities

**Source:** [arXiv](http://arxiv.org/abs/2011.04759v1)

— Advances in space weather science and small satellite (SmallSat) technology have proceeded in parall

---
*Collected: Space/Aerospace*
`;

const SAMPLE_NO_SNIPPET = `title: Quantum cryptography and cybersecurity
source: Crossref
url: 10.1201/9781003597414-7
date:
batch: Cybersecurity
---
# Quantum cryptography and cybersecurity

**Source:** [Crossref](10.1201/9781003597414-7)

---
*Collected: Cybersecurity*
`;

const SAMPLE_EMPTY_URL = `title: A title with no URL
source: OpenAlex
url:
date:
batch: AI/ML
---
# A title with no URL

**Source:** [OpenAlex]()

---
*Collected: AI/ML*
`;

describe('parseQueueFile', () => {
  it('parses frontmatter + snippet', () => {
    const a = parseQueueFile(SAMPLE_WITH_SNIPPET)!;
    expect(a.title).toBe('International Coordination and Support for SmallSat-enabled Space Weather Activities');
    expect(a.url).toBe('http://arxiv.org/abs/2011.04759v1');
    expect(a.source).toBe('arXiv');
    expect(a.field).toBe('Space/Aerospace');
    expect(a.snippet).toMatch(/^Advances in space weather/);
  });

  it('parses snippet-less files', () => {
    const a = parseQueueFile(SAMPLE_NO_SNIPPET)!;
    expect(a.title).toBe('Quantum cryptography and cybersecurity');
    expect(a.url).toBe('10.1201/9781003597414-7');
    expect(a.snippet).toBeNull();
  });

  it('handles empty url field as null', () => {
    const a = parseQueueFile(SAMPLE_EMPTY_URL)!;
    expect(a.url).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseQueueFile('not a queue file')).toBeNull();
    expect(parseQueueFile('---\nno title here\n---\n')).toBeNull();
  });

  it('also accepts the leading-`---` variant for safety', () => {
    const withLeading = '---\n' + SAMPLE_NO_SNIPPET;
    const a = parseQueueFile(withLeading)!;
    expect(a.title).toBe('Quantum cryptography and cybersecurity');
  });
});
