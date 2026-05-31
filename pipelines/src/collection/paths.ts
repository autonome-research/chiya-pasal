/**
 * Path resolution for the collection layer.
 *
 * The TypeScript api-ingest writes `api-articles.jsonl` / `api-digest.md`
 * into matcha/scripts/ (consumed by matcha/scripts/filter_matcha.py) and
 * reads matcha/interests.yaml. Both live under the repo's `matcha/`
 * directory, which is a SIBLING of `pipelines/`:
 *
 *   <repo>/
 *     matcha/scripts/...        <- output + interests live here
 *     pipelines/src/collection/ <- this module (tsx run)
 *     pipelines/dist/collection/<- this module (compiled run)
 *
 * Walking up three levels from the collection dir lands on <repo> for BOTH
 * the tsx (`src/`) and compiled (`dist/`) layouts, since `src/` and `dist/`
 * are each a single directory under `pipelines/`. `matcha/` is then a child
 * of <repo>.
 *
 * A previous version used `resolve(repoRoot, '../matcha')`, which escaped the
 * repo entirely (writing to a sibling-of-repo `matcha/` that filter_matcha.py
 * never reads) — the collector's output silently never reached the vault.
 *
 * `CHIYA_MATCHA_DIR` overrides the computed location (tests, non-standard
 * deployments).
 */

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/** Absolute path to the repo's `matcha/` directory for a collection module. */
export function resolveMatchaDir(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CHIYA_MATCHA_DIR && env.CHIYA_MATCHA_DIR.trim()) {
    return resolve(env.CHIYA_MATCHA_DIR.trim());
  }
  const collectionDir = dirname(fileURLToPath(moduleUrl));
  const repoRoot = resolve(collectionDir, '..', '..', '..');
  return resolve(repoRoot, 'matcha');
}

/** matcha/scripts/ — where api-articles.jsonl + api-digest.md are written. */
export function resolveMatchaScriptsDir(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(resolveMatchaDir(moduleUrl, env), 'scripts');
}
