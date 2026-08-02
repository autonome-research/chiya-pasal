/** Classify articles into digest buckets using the fast inference tier. */

import { requireCtx, runAgentWithTools, type Phase } from 'thread-phase';
import { boundedFanout } from 'thread-phase/patterns';
import type OpenAI from 'openai';

import { type Article } from '../../shared/article.js';
import type {
  Bucket,
  ClassifiedArticle,
  DigestCtx,
  VaultContext,
} from '../../shared/digest-types.js';
import {
  invalid,
  isRecord,
  parseAndValidateJson,
  stringArray,
  valid,
  type Validator,
} from '../../shared/llm-schema.js';
import { FAST_MAX_TOKENS, noTools } from './common.js';

const CLASSIFIER_BUCKETS = `Buckets:
- "focus":     directly hits one of the user's listed focuses or active research projects.
- "followup":  extends a topic that already has a wiki page (give the page slugs in wikilinks).
- "notable":   genuinely new, broadly interesting topic not yet covered in the wiki.
- "skip":      noise, paywalled boilerplate, irrelevant, or off-domain.`;

export function buildClassifierSystemPrompt(vault: VaultContext): string {
  const focuses = vault.focuses.length
    ? vault.focuses.map((f) => `${f.path}:\n${f.content.trim().slice(0, 600)}`).join('\n---\n')
    : '(none)';
  const research = vault.research.length
    ? vault.research.map((r) => `${r.path}:\n${r.content.trim().slice(0, 600)}`).join('\n---\n')
    : '(none)';
  const taste = vault.tasteMd.trim().slice(0, 1500) || '(empty)';
  // Registry interests are additive: absent → this section vanishes and the
  // prompt matches the vault-signals-only shape.
  const interestsSection = vault.interestParagraphs.length
    ? `\n\n## User interests (from tenant registry)\n${vault.interestParagraphs
        .map((p) => p.slice(0, 600))
        .join('\n\n')}`
    : '';
  const topics = vault.topicSlugs.length ? vault.topicSlugs.join(', ') : '(none)';

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
${taste}${interestsSection}

## Existing wiki topics (for the followup bucket + wikilinks)
${topics}`;
}

function buildClassifierUserMessage(article: Article): string {
  return `Title: ${article.title}
URL: ${article.url}
Field: ${article.field}${article.snippet ? `\nSnippet: ${article.snippet}` : ''}`;
}

function isBucket(value: unknown): value is Bucket {
  return value === 'focus' || value === 'notable' || value === 'followup' || value === 'skip';
}

interface ParsedClassifierOutput {
  bucket: Bucket;
  reason: string;
  wikilinks: string[];
}

const validateClassifierOutput: Validator<ParsedClassifierOutput> = (value) => {
  if (!isRecord(value)) return invalid('not-an-object');
  if (!isBucket(value.bucket)) return invalid(`invalid-bucket:${String(value.bucket).slice(0, 40)}`);
  return valid({
    bucket: value.bucket,
    reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : 'no-reason',
    wikilinks: stringArray(value.wikilinks, 8),
  });
};

function classifierSkip(article: Article, reason: string): ClassifiedArticle {
  return { article, bucket: 'skip', reason, wikilinks: [] };
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

      const systemPrompt = buildClassifierSystemPrompt(vault);
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
              maxTokens: FAST_MAX_TOKENS,
            },
            [{ role: 'user', content: buildClassifierUserMessage(article) }],
            { client, toolExecutor: noTools, cache: ctx.cache, signal: ctx.signal },
          );

          if (r.finishReason === 'error') return classifierSkip(article, 'classifier-error');
          if (r.finishReason === 'length') return classifierSkip(article, 'classifier-truncated');
          const parsed = parseAndValidateJson(r.text, validateClassifierOutput);
          if (!parsed.ok) return classifierSkip(article, parsed.reason);

          return {
            article,
            bucket: parsed.value.bucket,
            reason: parsed.value.reason,
            wikilinks: parsed.value.wikilinks,
          };
        },
        onItemDone: ({ index, result }) => {
          itemEvents.push({ index, bucket: result.bucket });
        },
      });

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

      // Transport failures degrade to per-article skips, which is right for a
      // flaky endpoint — but when EVERY call failed the inference layer is
      // down, and "0 highlights from N articles" would silently email an
      // empty digest and squash-push. Fail the job so the outage is visible
      // and the run retries once inference is back.
      const errored = results.filter((c) => c.reason === 'classifier-error').length;
      if (errored === results.length) {
        throw new Error(
          `prioritize: all ${errored} classifier calls failed — inference ` +
            `endpoint down? Failing the digest instead of emailing an empty one.`,
        );
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
