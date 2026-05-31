/** Draft article-driven digest sections plus the library-updates section. */

import { requireCtx, runAgentWithTools, type Phase } from 'thread-phase';
import type OpenAI from 'openai';

import type {
  ClassifiedArticle,
  DigestCtx,
  DigestSection,
  VaultContext,
} from '../../shared/digest-types.js';
import { FAST_MAX_TOKENS, noTools } from './common.js';

const SECTION_SYSTEM = `You are a research-digest writer. Given a list of pre-classified articles for ONE section, write a tight scannable list of 1-line entries.

Output ONLY the markdown body for the section (no heading). Each entry one line:
- [Title](url) — one-line why-it-matters (no trailing period needed) [field-tag]

Constraints:
- One bullet per article. No grouping, no nested bullets.
- "Why it matters" must be specific to the article — don't restate the title.
- For "followup" articles, mention the wiki page they extend in [[brackets]].
- If the input list is empty, output exactly: _Nothing this cycle._`;

function buildSectionUserMessage(
  bucketLabel: string,
  bucketRole: string,
  classified: ClassifiedArticle[],
  vault: VaultContext,
): string {
  if (classified.length === 0) {
    return `Section: ${bucketLabel}
Role: ${bucketRole}
Articles: (none)`;
  }
  const articleList = classified
    .map(
      (c, i) =>
        `${i + 1}. ${c.article.title} (${c.article.url}) [${c.article.field}]\n   why: ${c.reason}${
          c.wikilinks.length ? `\n   extends: ${c.wikilinks.join(', ')}` : ''
        }${c.article.snippet ? `\n   snippet: ${c.article.snippet.slice(0, 200)}` : ''}`,
    )
    .join('\n\n');

  return `Section: ${bucketLabel}
Role: ${bucketRole}

Articles to format:
${articleList}

Write the section body in markdown. ${classified.length} bullet lines.`;
}

export const draftSections =
  (client: OpenAI, model: string): Phase<DigestCtx> =>
  ({
    name: 'draft-sections',
    async *run(ctx) {
      const classified = requireCtx(ctx, 'classified', 'draft-sections');
      const vault = requireCtx(ctx, 'vault', 'draft-sections');

      const focus = classified.filter((c) => c.bucket === 'focus');
      const notable = classified.filter((c) => c.bucket === 'notable');
      const followup = classified.filter((c) => c.bucket === 'followup');

      yield {
        type: 'phase',
        phase: 'draft-sections',
        detail: `drafting 3 article sections (${focus.length}/${notable.length}/${followup.length}) + library-updates`,
      };

      const sections: DigestSection[] = [];

      const [focusBody, notableBody, followupBody] = await Promise.all([
        draftOneSection(client, model, ctx, '🔭 Current Focus Hits',
          'Articles relevant to the user\'s active focuses and research projects', focus, vault),
        draftOneSection(client, model, ctx, '📚 New & Notable',
          'Fresh topics emerging in the literature, not yet well-covered in the wiki', notable, vault),
        draftOneSection(client, model, ctx, '🔄 Follow-ups',
          'Developments on topics already in the wiki — cite the existing page in [[brackets]]', followup, vault),
      ]);

      sections.push({ heading: '🔭 Current Focus Hits', body: focusBody });
      sections.push({ heading: '📚 New & Notable', body: notableBody });
      sections.push({ heading: '🔄 Follow-ups', body: followupBody });
      sections.push({ heading: '🏗️ Library Updates', body: extractLibraryUpdates(vault.logTail) });

      ctx.sections = sections;
    },
  });

async function draftOneSection(
  client: OpenAI,
  model: string,
  ctx: DigestCtx,
  bucketLabel: string,
  bucketRole: string,
  classified: ClassifiedArticle[],
  vault: VaultContext,
): Promise<string> {
  if (classified.length === 0) return '_Nothing this cycle._';

  const r = await runAgentWithTools(
    {
      name: `drafter:${bucketLabel}`,
      systemPrompt: SECTION_SYSTEM,
      model,
      tools: [],
      maxToolRounds: 1,
      maxTokens: FAST_MAX_TOKENS,
    },
    [{ role: 'user', content: buildSectionUserMessage(bucketLabel, bucketRole, classified, vault) }],
    { client, toolExecutor: noTools, cache: ctx.cache, signal: ctx.signal },
  );
  if (r.finishReason === 'length') {
    throw new Error(`digest section draft truncated: ${bucketLabel}`);
  }
  return r.text.trim();
}

function extractLibraryUpdates(logTail: string): string {
  const lines = logTail.split('\n');
  const ingestLines = lines.filter((l) => /\bingest\b/i.test(l));
  if (ingestLines.length === 0) return '_No librarian activity in the recent log._';
  const recent = ingestLines.slice(-10);
  return recent.map((l) => '- ' + l.replace(/^##\s*/, '').trim()).join('\n');
}
