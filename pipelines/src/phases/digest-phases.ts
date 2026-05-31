/**
 * Digest pipeline phase exports.
 *
 * The implementation is split by responsibility under `phases/digest/` while
 * this module preserves the public import surface used by `src/digest.ts` and
 * older tests/scripts.
 */

export { loadContext } from './digest/context.js';
export { loadArticles } from './digest/load-articles.js';
export { prioritize } from './digest/classify.js';
export { draftSections } from './digest/draft.js';
export { assemble } from './digest/assemble.js';
export { appendLog, commitDigest, squashAndPush, emailSend } from './digest/publish.js';
