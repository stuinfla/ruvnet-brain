// The per-prompt recall must surface the NEWEST project-state checkpoint by the epoch-ms in its key, whatever
// namespace spelling holds it, whatever its semantic score, and however many lessons share the read budget.
// Measured 2026-10-13 in AppealArmor: today's checkpoints live in namespace `appealarmor` while the recall read
// only `AppealArmor`, so it showed project-state-current-1786376123058 (2026-08-10).
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recall, checkpointMs, newestCheckpoint, checkpointNamespaces, pickRows } from '../../plugin/scripts/agentdb-recall.mjs';

const NOW = Date.UTC(2026, 9, 13, 18);
const OLD = 'project-state-current-1786376123058'; // 2026-08-10
const MID = 'project-state-current-1791813555000'; // 2026-10-12
const NEW = 'project-state-current-1791912547000'; // 2026-10-13

function world(dirName, rows) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-ckpt-')));
  const proj = path.join(dir, dirName);
  fs.mkdirSync(path.join(proj, '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.swarm', 'memory.db'), '');
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(rows));
  const bin = path.join(dir, 'ruflo');
  // Namespace filters are case-sensitive, exactly like live `ruflo memory list -n` (verified against 3.56.9).
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2), get = (f) => a[a.indexOf(f) + 1];
fs.appendFileSync(process.env.RECALL_LOG, JSON.stringify({ args: a }) + '\\n');
const rows = JSON.parse(fs.readFileSync(process.env.RECALL_ROWS, 'utf8'));
const ns = a.includes('--namespace') ? get('--namespace') : get('-n'), key = a.includes('--key') ? get('--key') : get('-k');
if (a[1] === 'retrieve') console.log(rows.find(r => r.key === key && r.namespace === ns)?.content || '');
else if (a[1] === 'list') console.log(JSON.stringify(rows.filter(r => r.namespace === ns).map(r => ({ key: r.key, namespace: r.namespace }))));
else console.log(JSON.stringify({ results: rows.filter(r => r.namespace === ns && Number.isFinite(r.score)) }));
`, { mode: 0o755 });
  const env = { ...process.env, HOME: path.join(dir, 'home'), RUFLO_BIN: bin, RUVNET_BRAIN_HOME: path.join(dir, 'brain'),
    RUVNET_BRAIN_METER: '0', RECALL_ROWS: path.join(dir, 'rows.json'), RECALL_LOG: path.join(dir, 'calls.jsonl') };
  return { proj, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const state = (namespace, key, status, extra = {}) => ({ namespace, key, content: JSON.stringify({ status }), ...extra });

it('reads epoch-ms from the key and rejects non-epoch, seconds, future and malformed keys', () => {
  expect(checkpointMs(NEW, NOW)).toEqual({ family: 'current', ms: 1791912547000 });
  expect(checkpointMs('project-state-auto-1791920000000-abcdef12', NOW)).toEqual({ family: 'auto', ms: 1791920000000 });
  expect(checkpointMs('project-state-current-1791064981895-release454', NOW)?.ms).toBe(1791064981895);
  for (const bad of ['project-state-current-20260802193600', 'project-state-current-1787437421-pr160', 'project-state-current-17888753303N',
    'project-state-current', 'project-state-current-1891912547000', 'xproject-state-current-1791912547000']) expect(checkpointMs(bad, NOW), bad).toBeNull();
  expect(checkpointNamespaces('/x/AppealArmor')).toEqual(['AppealArmor', 'appealarmor', 'default']);
  expect(checkpointNamespaces('/x/ruvnet-brain')).toEqual(['ruvnet-brain', 'default']);
});

it('picks the newest curated checkpoint across namespaces; an automatic one never displaces it', () => {
  const keys = { AppealArmor: [OLD, 'project-state-current', 'project-state-auto-1791920000000-abcdef12'],
    appealarmor: [NEW, 'project-state-current-20260802193600'], default: [MID] };
  expect(newestCheckpoint(keys, checkpointNamespaces('/x/AppealArmor'), NOW)).toMatchObject({ namespace: 'appealarmor', key: NEW });
  expect(newestCheckpoint({ AppealArmor: ['project-state-auto-1791920000000-abcdef12', 'project-state-auto-1791000000000-00000000'] },
    ['AppealArmor'], NOW)).toMatchObject({ key: 'project-state-auto-1791920000000-abcdef12' });
  expect(newestCheckpoint({ AppealArmor: ['project-state-current'] }, ['AppealArmor'], NOW)).toBeNull();
});

it('ranked search never re-surfaces a checkpoint: state comes only from the newest exact read', () => {
  const picks = pickRows([{ namespace: 'proj', rows: [{ key: OLD, namespace: 'proj', score: 0.99 }, { key: 'decision-x', namespace: 'proj', score: 0.6 }] }]);
  expect(picks.map(p => p.key)).toEqual(['decision-x']);
});

it('prompt recall surfaces the newest checkpoint held in the lowercase dirname namespace, not the older dirname one', async () => {
  const w = world('AppealArmor', [
    state('AppealArmor', OLD, 'OLD august appeal parser state'),
    state('appealarmor', NEW, 'NEWEST october appeal parser state'),
    state('appealarmor', 'project-state-current-20260802193600', 'BOGUS yyyymmdd appeal parser state'),
    state('default', MID, 'MIDDLE default appeal parser state'),
  ]);
  try {
    const r = await recall({ prompt: 'Fix the appeal parser', projectDir: w.proj, env: w.env });
    expect(r.block).toContain(NEW); expect(r.block).toContain('NEWEST october');
    for (const stale of [OLD, MID, 'BOGUS']) expect(r.block).not.toContain(stale);
  } finally { w.cleanup(); }
});

it('an older checkpoint with a higher semantic score cannot appear beside or instead of the newest', async () => {
  const w = world('proj', [
    state('proj', OLD, 'OLD parser state fix parser parser parser', { score: 0.97 }),
    state('proj', NEW, 'NEWEST parser state', { score: 0.46 }),
  ]);
  try {
    const r = await recall({ prompt: 'Fix parser', projectDir: w.proj, env: w.env });
    expect(r.block).toContain(NEW); expect(r.block).not.toContain(OLD); expect(r.block).not.toContain('OLD parser');
  } finally { w.cleanup(); }
});

it('more lessons than the exact-read budget still surfaces the newest state and marks lessons unavailable', async () => {
  const lessons = Array.from({ length: 40 }, (_, i) => ({ namespace: 'lessons', key: `lesson-${i}`, content: '{}' }));
  const w = world('proj', [state('proj', OLD, 'OLD parser state'), state('proj', NEW, 'NEWEST parser state'), ...lessons]);
  try {
    const r = await recall({ prompt: 'Fix parser', projectDir: w.proj, env: w.env, consequential: true });
    expect(r.picks.map(p => p.key)).toEqual([NEW]);
    expect(r.categories.state).toBe('ok-with-results'); expect(r.categories.lessons).toBe('unavailable');
    expect(r.outcome).toBe('unavailable'); // honest: lessons were not read, so this is not a complete-history claim
  } finally { w.cleanup(); }
});

it('a history of only unorderable checkpoint keys is unavailable, never an empty-state claim', async () => {
  const w = world('proj', [state('proj', 'project-state-current-17888753303N', 'malformed'), state('proj', 'project-state-current', 'bare')]);
  try {
    const r = await recall({ prompt: 'Fix parser', projectDir: w.proj, env: w.env, consequential: true });
    expect(r.categories.state).toBe('unavailable'); expect(r.picks).toEqual([]);
  } finally { w.cleanup(); }
});
