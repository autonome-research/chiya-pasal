import { describe, it, expect } from 'vitest';
import { resolve } from 'path';

import { resolveMatchaDir, resolveMatchaScriptsDir } from '../src/collection/paths.js';

// Simulate the module living at <repo>/pipelines/{src,dist}/collection/paths.ts.
const SRC_URL = 'file:///home/u/proj/repo/pipelines/src/collection/api-ingest.ts';
const DIST_URL = 'file:///home/u/proj/repo/pipelines/dist/collection/api-ingest.js';
const REPO = '/home/u/proj/repo';

describe('resolveMatchaDir', () => {
  it('resolves matcha as a child of the repo root (tsx/src layout)', () => {
    expect(resolveMatchaDir(SRC_URL, {})).toBe(resolve(REPO, 'matcha'));
  });

  it('resolves the same repo matcha dir for the compiled/dist layout', () => {
    expect(resolveMatchaDir(DIST_URL, {})).toBe(resolve(REPO, 'matcha'));
  });

  it('never escapes the repo root (regression for the ../matcha bug)', () => {
    const dir = resolveMatchaDir(SRC_URL, {});
    // The old bug produced <parent-of-repo>/matcha; assert we stay inside repo.
    expect(dir.startsWith(REPO + '/')).toBe(true);
    expect(dir).not.toBe(resolve(REPO, '..', 'matcha'));
  });

  it('honors the CHIYA_MATCHA_DIR override', () => {
    expect(resolveMatchaDir(SRC_URL, { CHIYA_MATCHA_DIR: '/custom/matcha' })).toBe('/custom/matcha');
  });
});

describe('resolveMatchaScriptsDir', () => {
  it('points at matcha/scripts under the repo root', () => {
    expect(resolveMatchaScriptsDir(SRC_URL, {})).toBe(resolve(REPO, 'matcha', 'scripts'));
  });
});
