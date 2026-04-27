/**
 * Digest pipeline phases.
 *
 * Composed in src/digest-pipeline.ts. Order:
 *   loadContext → loadArticles → prioritize → draftSections
 *     → assemble → appendLog → commitDigest → squashAndPush → emailSend
 *
 * All phases mutate the shared DigestCtx. Pure-code phases call helper
 * modules in tools/. LLM phases call thread-phase's runAgentWithTools with
 * a no-op tool executor — the digest doesn't need any callable tools.
 */

import {
  loadInferenceConfig,
  parseJSON,
  requireCtx,
  runAgentWithTools,
  type Phase,
  type ToolExecutor,
} from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';
import type OpenAI from 'openai';

import { parseArticles, type Article } from '../shared/article.js';
import type {
  Bucket,
  ClassifiedArticle,
  DigestCtx,
  DigestSection,
  VaultContext,
} from '../shared/digest-types.js';
import type { ChiyaEnv } from '../shared/env.js';
import { GitOps } from '../tools/git.js';
import { gwsEmailSend } from '../tools/email.js';
import { VaultFs } from '../tools/vault.js';

// ---------------------------------------------------------------------------
// no-op tool executor (digest agents are pure classifiers/writers)
// ---------------------------------------------------------------------------

const noTools: ToolExecutor = {
  async execute() {
    return { toolCallId: '', content: '' };
  },
};

// ---------------------------------------------------------------------------
// loadContext — read vault context (CLAUDE.md, TASTE.md, index, log tail,
// user focuses, research statuses, profile/interests if present)
// ---------------------------------------------------------------------------

export const loadContext = (vault: VaultFs): Phase<DigestCtx> => ({
  name: 'load-context',
  async *run(ctx) {
    const [claudeMd, tasteMd, indexMd, logTail, focuses, research, profile, interests] =
      await Promise.all([
        vault.read('CLAUDE.md'),
        vault.read('wiki/TASTE.md'),
        vault.read('index.md'),
        vault.readTail('log.md', 30),
        vault.listAndRead('wiki/user/focuses/*.md'),
        vault.listAndRead('wiki/research/*/STATUS.md'),
        vault.readOptional('wiki/user/profile.md'),
        vault.readOptional('wiki/user/interests.md'),
      ]);

    const vc: VaultContext = {
      claudeMd,
      tasteMd,
      indexMd,
      logTail,
      focuses,
      research,
      profile,
      interests,
    };
    ctx.vault = vc;

    yield {
      type: 'phase',
      phase: 'load-context',
      detail: `${focuses.length} focus(es), ${research.length} active research project(s)`,
      counts: { focuses: focuses.length, research: research.length },
    };
  },
});

// ---------------------------------------------------------------------------
// loadArticles — find today's articles file and parse it
// ---------------------------------------------------------------------------

export const loadArticles = (vault: VaultFs): Phase<DigestCtx> => ({
  name: 'load-articles',
  async *run(ctx) {
    const candidates: string[] = [];
    // Today's fresh inbox file (preferred)
    candidates.push(`raw/inbox/${ctx.date}-articles.md`);
    // Today's processed file (digest fallback)
    candidates.push(`raw/${ctx.date}-articles.md`);

    let chosenPath: string | null = null;
    for (const c of candidates) {
      if (await vault.exists(c)) {
        chosenPath = c;
        break;
      }
    }

    // Fallback: most recent *-articles.md anywhere in raw/inbox/ or raw/
    if (!chosenPath) {
      const all = [
        ...(await vault.list('raw/inbox/*-articles.md')),
        ...(await vault.list('raw/*-articles.md')),
      ];
      if (all.length > 0) {
        all.sort();
        chosenPath = all[all.length - 1]!;
      }
    }

    if (!chosenPath) {
      yield {
        type: 'agent_activity',
        agent: 'load-articles',
        action: 'no-articles',
        detail: 'no articles file found in raw/inbox/ or raw/',
      };
      ctx.articles = [];
      ctx.articlesPath = '';
      return;
    }

    const text = await vault.read(chosenPath);
    const articles = parseArticles(text);
    ctx.articlesPath = chosenPath;
    ctx.articles = articles;

    yield {
      type: 'phase',
      phase: 'load-articles',
      detail: `${articles.length} articles from ${chosenPath}`,
      counts: { articles: articles.length },
    };
  },
});

// ---------------------------------------------------------------------------
// prioritize — classify each article into a bucket via cheap LLM call
//
// Vault context lives in the system prompt so vLLM's prefix cache can fully
// reuse it across the (up to) hundreds of classifier calls in one run. The
// per-call user message contains only the article. Result: ~200 input tokens
// per call instead of ~3000.
//
// Concurrency is capped via boundedFanout to match vLLM's --max-num-seqs.
// ---------------------------------------------------------------------------

const CLASSIFIER_BUCKETS = `Buckets:
- "focus":     directly hits one of the user's listed focuses or active research projects.
- "followup":  extends a topic that already has a wiki page (give the page slugs in wikilinks).
- "notable":   genuinely new, broadly interesting topic not yet covered in the wiki.
- "skip":      noise, paywalled boilerplate, irrelevant, or off-domain.`;

function buildClassifierSystemPrompt(vault: VaultContext): string {
  const focuses = vault.focuses.length
    ? vault.focuses.map((f) => `${f.path}:\n${f.content.trim().slice(0, 600)}`).join('\n---\n')
    : '(none)';
  const research = vault.research.length
    ? vault.research.map((r) => `${r.path}:\n${r.content.trim().slice(0, 600)}`).join('\n---\n')
    : '(none)';
  const taste = vault.tasteMd.trim().slice(0, 1500) || '(empty)';
  const indexExcerpt = vault.indexMd.trim().slice(0, 2000);

  return `You are a research-digest classifier. Given a single article and the user context below, decide which digest section the article belongs in.

Reply ONLY with JSON of the form:
{"bucket": "focus" | "notable" | "followup" | "skip", "reason": "<one short clause>", "wikilinks": ["<page-slug>", ...]}

${CLASSIFIER_BUCKETS}

Be selective: most articles are "skip" — only mark "focus" or "notable" if the article is genuinely interesting. Use "wikilinks" only for "followup".

================================================================================
USER CONTEXT (same across every article in this run — cached by inference layer)
================================================================================

## User Focuses
${focuses}

## Active Research
${research}

## TASTE preferences
${taste}

## Wiki index (first 2k chars — to detect followups)
${indexExcerpt}`;
}

function buildClassifierUserMessage(article: Article): string {
  return `Title: ${article.title}
URL: ${article.url}
Field: ${article.field}${article.snippet ? `\nSnippet: ${article.snippet}` : ''}`;
}

export const prioritize =
  (client: OpenAI, model: string, concurrency: number = 4): Phase<DigestCtx> =>
  ({
    name: 'prioritize',
    async *run(ctx) {
      const articles = requireCtx(ctx, 'articles', 'prioritize');
      const vault = requireCtx(ctx, 'vault', 'prioritize');

      if (articles.length === 0) {
        ctx.classified = [];
        yield { type: 'phase', phase: 'prioritize', detail: 'no articles' };
        return;
      }

      yield {
        type: 'phase',
        phase: 'prioritize',
        detail: `classifying ${articles.length} articles (concurrency=${concurrency})`,
      };

      // Build system prompt once — shared across all classifier calls so the
      // inference layer's prefix cache hits.
      const systemPrompt = buildClassifierSystemPrompt(vault);

      // Buffer per-item events here, yield them after boundedFanout returns
      // (an async generator can't yield from a synchronous callback).
      const itemEvents: Array<{ index: number; bucket: Bucket }> = [];

      const results = await boundedFanout({
        items: articles,
        concurrency,
        runner: async (article): Promise<ClassifiedArticle> => {
          const r = await runAgentWithTools(
            {
              name: 'classifier',
              systemPrompt,
              model,
              tools: [],
              maxToolRounds: 1,
              // No reasoning needed for a JSON classification — saves ~30s/call.
              // ~50 tokens output instead of ~1000+.
              maxTokens: 200,
              extraBody: { chat_template_kwargs: { enable_thinking: false } },
            },
            [{ role: 'user', content: buildClassifierUserMessage(article) }],
            { client, toolExecutor: noTools, cache: ctx.cache },
          );

          const parsed = parseJSON<{ bucket: Bucket; reason: string; wikilinks?: string[] }>(
            r.text,
            { bucket: 'skip', reason: 'parse-failed', wikilinks: [] },
          );

          return {
            article,
            bucket: parsed.bucket,
            reason: parsed.reason,
            wikilinks: parsed.wikilinks ?? [],
          };
        },
        onItemDone: ({ index, result }) => {
          itemEvents.push({ index, bucket: result.bucket });
        },
      });

      // Emit progress events at chunk boundaries so journalctl shows life.
      const total = articles.length;
      const milestones = new Set([
        Math.floor(total * 0.25),
        Math.floor(total * 0.5),
        Math.floor(total * 0.75),
        total - 1,
      ]);
      itemEvents.sort((a, b) => a.index - b.index);
      for (const { index, bucket } of itemEvents) {
        if (milestones.has(index)) {
          yield {
            type: 'agent_activity',
            agent: 'prioritize',
            action: 'progress',
            detail: `${index + 1}/${total} (latest: ${bucket})`,
          };
        }
      }

      ctx.classified = results;

      const counts = results.reduce<Record<Bucket, number>>(
        (acc, c) => {
          acc[c.bucket] = (acc[c.bucket] ?? 0) + 1;
          return acc;
        },
        { focus: 0, notable: 0, followup: 0, skip: 0 },
      );
      yield {
        type: 'phase',
        phase: 'prioritize',
        detail: `focus=${counts.focus} notable=${counts.notable} followup=${counts.followup} skip=${counts.skip}`,
        counts,
      };
    },
  });

// ---------------------------------------------------------------------------
// draftSections — one agent call per section (focus/notable/followup) +
// pure-code library-updates section from log tail.
// ---------------------------------------------------------------------------

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

      // Three article-driven sections drafted in parallel via cheap LLM
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

      // Library updates section — pure-code from log tail (no LLM needed)
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
  if (classified.length === 0) {
    return '_Nothing this cycle._';
  }
  const r = await runAgentWithTools(
    {
      name: `drafter:${bucketLabel}`,
      systemPrompt: SECTION_SYSTEM,
      model,
      tools: [],
      maxToolRounds: 1,
      // Headroom for Qwen3.6's reasoning trace + the actual section body
      // (sections can run dozens of bullets when the bucket is large).
      maxTokens: 2500,
    },
    [{ role: 'user', content: buildSectionUserMessage(bucketLabel, bucketRole, classified, vault) }],
    { client, toolExecutor: noTools, cache: ctx.cache },
  );
  return r.text.trim();
}

function extractLibraryUpdates(logTail: string): string {
  // Pull recent ingest entries from the log tail. Each entry is roughly:
  //   ## [YYYY-MM-DD HH:MM] ingest | queue NNNN — title
  // Surface the unique page paths that were created/updated, with a brief note.
  const lines = logTail.split('\n');
  const ingestLines = lines.filter((l) => /\bingest\b/i.test(l));
  if (ingestLines.length === 0) return '_No librarian activity in the recent log._';
  const recent = ingestLines.slice(-10);
  return recent.map((l) => '- ' + l.replace(/^##\s*/, '').trim()).join('\n');
}

// ---------------------------------------------------------------------------
// assemble — format the final digest message
// ---------------------------------------------------------------------------

export const assemble: Phase<DigestCtx> = {
  name: 'assemble',
  async *run(ctx) {
    const sections = requireCtx(ctx, 'sections', 'assemble');
    const articles = requireCtx(ctx, 'articles', 'assemble');
    const classified = requireCtx(ctx, 'classified', 'assemble');
    const highlighted = classified.filter((c) => c.bucket !== 'skip').length;

    const body = sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');
    ctx.digest =
      `🍵 Chiya Daily Digest — ${ctx.date} (${ctx.direction})\n\n` +
      body +
      `\n\n---\nTotal articles collected: ${articles.length} | Curated highlights: ${highlighted}\n`;

    yield {
      type: 'data',
      key: 'digest-summary',
      value: { articles: articles.length, highlighted },
    };
  },
};

// ---------------------------------------------------------------------------
// appendLog — record the digest in vault/log.md
// ---------------------------------------------------------------------------

export const appendLog = (vault: VaultFs): Phase<DigestCtx> => ({
  name: 'append-log',
  async *run(ctx) {
    const articles = requireCtx(ctx, 'articles', 'append-log');
    const classified = requireCtx(ctx, 'classified', 'append-log');
    const highlighted = classified.filter((c) => c.bucket !== 'skip').length;

    const entry = `## [${ctx.date}] digest | ${ctx.direction} digest curated — ${highlighted} highlights from ${articles.length} articles\n`;
    await vault.append('log.md', '\n' + entry);
    ctx.logEntry = entry;
    yield { type: 'agent_activity', agent: 'append-log', action: 'appended', detail: entry.trim() };
  },
});

// ---------------------------------------------------------------------------
// commitDigest — local commit of the log entry (no push)
// ---------------------------------------------------------------------------

export const commitDigest = (git: GitOps): Phase<DigestCtx> => ({
  name: 'commit-digest',
  async *run(ctx) {
    const entry = requireCtx(ctx, 'logEntry', 'commit-digest');
    const summary = entry.trim().replace(/^##\s*/, '');
    // Digest only writes to log.md.
    const result = await git.commit(`digest: ${summary}`, ['log.md']);
    if (result.committed) {
      yield { type: 'agent_activity', agent: 'commit-digest', action: 'committed', detail: result.sha };
    } else {
      yield { type: 'agent_activity', agent: 'commit-digest', action: 'noop', detail: 'no changes' };
    }
  },
});

// ---------------------------------------------------------------------------
// squashAndPush — fetch, squash all unpushed commits, push to origin
// ---------------------------------------------------------------------------

export const squashAndPush = (git: GitOps): Phase<DigestCtx> => ({
  name: 'squash-and-push',
  async *run(ctx) {
    const result = await git.squashAndPush(
      (count) => `chiya: ${count} runs since last push (digest ${ctx.date} ${ctx.direction})`,
    );
    ctx.pushed = result;
    if (result.pushed) {
      yield {
        type: 'agent_activity',
        agent: 'squash-and-push',
        action: 'pushed',
        detail: `${result.squashedCount} commits → ${result.sha?.slice(0, 7)}`,
      };
    } else {
      yield {
        type: 'agent_activity',
        agent: 'squash-and-push',
        action: 'noop',
        detail: 'nothing to push',
      };
    }
  },
});

// ---------------------------------------------------------------------------
// emailSend — fire the digest to the configured recipient
// ---------------------------------------------------------------------------

export const emailSend = (env: ChiyaEnv): Phase<DigestCtx> => ({
  name: 'email-send',
  async *run(ctx) {
    const digest = requireCtx(ctx, 'digest', 'email-send');
    const result = await gwsEmailSend({
      to: env.emailTo,
      subject: `🍵 Chiya Daily Digest — ${ctx.date} (${ctx.direction})`,
      body: digest,
    });
    ctx.emailed = result;
    if (!result.ok) {
      ctx.stop = { reason: `email-failed: ${result.output.slice(0, 200)}` };
    }
    yield {
      type: 'agent_activity',
      agent: 'email-send',
      action: result.ok ? 'sent' : 'failed',
      detail: result.output.slice(0, 200),
    };
  },
});
