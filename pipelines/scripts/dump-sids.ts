/**
 * Dev helper: read URLs from stdin (id|url per line), print id, stable id, and
 * source page filename. Used during smoke prep to know which scratch files to
 * clear so the v3 librarian's idempotency check doesn't short-circuit.
 */
import { readFileSync } from 'fs';
import { stableIdForUrl, stableIdToFilename } from '../src/phases/page-templates.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: tsx scripts/dump-sids.ts <id-url-file>');
  process.exit(1);
}
const lines = readFileSync(path, 'utf8').trim().split('\n');
for (const ln of lines) {
  const [id, url] = ln.split('|');
  const sid = stableIdForUrl(url);
  if (!sid) {
    console.log(`${id}\tNO-SID\t${url}`);
    continue;
  }
  console.log(`${id}\t${sid}\t${stableIdToFilename(sid)}`);
}
