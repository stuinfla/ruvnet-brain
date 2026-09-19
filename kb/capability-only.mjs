import fs from 'node:fs';
import path from 'node:path';

export const isCapabilityOnly = name => String(name).toLowerCase() === 'cognitum-ruos';
export const CAPABILITY_RETIRED_SUFFIXES = [
  '.symbols.json', '.rvf', '.rvf.idmap.json', '.rvf.embed.json', '.big.passages.jsonl', '.big.meta.json',
];

// Reject historical source-bearing stores at the final packaging boundary, even
// when their upstream SHA and signed generation receipt are otherwise current.
export function assertCapabilityOnlyStore(dir, name) {
  if (!isCapabilityOnly(name)) return;
  const expected = fs.readFileSync(new URL('./capability-summaries/cognitum-ruos/CAPABILITIES.md', import.meta.url), 'utf8');
  const rows = fs.readFileSync(path.join(dir, `${name}.passages.jsonl`), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  if (rows.length !== 1 || rows[0].path !== 'CAPABILITIES.md' || rows[0].text !== expected) {
    throw new Error(`${name}: capability-only policy requires the current curated summary, without source passages`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.meta.json`), 'utf8'));
  const entries = Object.values(meta.entries || {});
  if (entries.length !== 1 || entries[0].path !== 'CAPABILITIES.md' || entries[0].kind !== 'doc') {
    throw new Error(`${name}: capability-only metadata contains unexpected source paths`);
  }
  if (CAPABILITY_RETIRED_SUFFIXES.some(suffix => fs.existsSync(path.join(dir, `${name}${suffix}`)))) {
    throw new Error(`${name}: capability-only store must not carry a symbol index or legacy source sidecar`);
  }
}
