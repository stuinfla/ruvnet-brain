// console-receipts-endpoint.test.mjs — the real Console server answers every mutating click with a
// receipt whose before/after are RE-READS of the machine, and keeps them where a repaint cannot lose
// them (GET /api/receipts). Owner, 2026-10-30: "Even if they work, they're not showing me that
// they've worked." Before this change none of these endpoints returned `receipt`, and /api/receipts
// answered with the static 404 — every assertion below fails on that code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { consoleFixtureEnvironment } from '../helpers/console-fixture-environment.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENTRY = path.join(ROOT, 'scripts/onboarding-console.mjs');
let child; let port; let token; let root; let project;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.once('error', reject);
});
const post = async (url, body, tok = token) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok, ...body }) });
  return { status: r.status, body: await r.json() };
};
const get = async (url) => (await fetch(`http://127.0.0.1:${port}${url}`)).json();
const fact = (receipt, name) => receipt.facts.find((f) => f.fact.startsWith(name));

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-receipts-')));
  project = path.join(root, 'Code', 'receipts-project');
  fs.mkdirSync(project, { recursive: true });
  const requested = await freePort();
  child = spawn(process.execPath, [ENTRY, '--serve'], {
    cwd: project,
    env: { ...consoleFixtureEnvironment(root), CONSOLE_PORT: String(requested), RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`console did not start: ${out}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  token = page.match(/window\.__CONSOLE_TOKEN__="([a-f0-9]{48})"/)?.[1];
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  // The page loads the receipts client; without it nothing renders the evidence.
  expect(page).toContain('src="receipts.js"');
}, 60_000);

afterAll(() => {
  try { child?.kill('SIGTERM'); } catch { /* already gone */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('every mutating endpoint returns a before → after receipt read back from the machine', () => {
  it('brain power: off is "changed", the switch file is really there, and repeating it is "no-change"', async () => {
    const off = await post('/api/save-brain-power', { values: { brainEnabled: false } });
    expect(off.body.ok).toBe(true);
    expect(off.body.receipt.verdict).toBe('changed');
    expect(fact(off.body.receipt, 'Brain')).toMatchObject({ before: 'on', after: 'off', changed: true });
    // Independent check: the sentinel the receipt claims is present is on disk.
    expect(fs.existsSync(path.join(root, '.config', 'ruvnet-brain', 'brain-off'))).toBe(true);
    const again = await post('/api/save-brain-power', { values: { brainEnabled: false } });
    expect(again.body.receipt.verdict).toBe('no-change');
    const on = await post('/api/save-brain-power', { values: { brainEnabled: true } });
    expect(fact(on.body.receipt, 'Brain')).toMatchObject({ before: 'off', after: 'on', changed: true });
    expect(fs.existsSync(path.join(root, '.config', 'ruvnet-brain', 'brain-off'))).toBe(false);
  });

  it('settings: the saved field moves from "not chosen" to its value, the undo reverses it, and history marks the undo spent', async () => {
    const saved = await post('/api/save-config', { values: { routing: 'off' } });
    expect(saved.body.ok).toBe(true);
    expect(saved.body.receipt.verdict).toBe('changed');
    expect(fact(saved.body.receipt, 'Token-smart routing')).toMatchObject({ before: 'not chosen', after: 'off' });
    expect(saved.body.receipt.undoToken).toBe(saved.body.undoToken);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'ruvnet-brain', 'config.json'), 'utf8')).routing).toBe('off');

    const undone = await post('/api/undo', { undoToken: saved.body.undoToken });
    expect(undone.body.ok).toBe(true);
    expect(undone.body.receipt.title).toBe('Undo — Save settings (config.json)');
    expect(fact(undone.body.receipt, 'Token-smart routing')).toMatchObject({ before: 'off', after: 'not chosen' });

    const history = await get('/api/receipts');
    const original = history.receipts.find((r) => r.undoToken === saved.body.undoToken);
    expect(original.undoUsed).toBe(true);
    expect(history.receipts[0].id).toBe(undone.body.receipt.id);   // newest first
  });

  it('a save followed by another save no longer offers the first one\'s undo (the server would refuse it)', async () => {
    const first = await post('/api/save-config', { values: { qeFleet: true } });
    const second = await post('/api/save-config', { values: { qeFleet: false } });
    const rows = (await get('/api/receipts')).receipts;
    expect(rows.find((r) => r.undoToken === first.body.undoToken).undoSuperseded).toBe(true);
    expect(rows.find((r) => r.undoToken === second.body.undoToken).undoSuperseded).toBe(false);
    const refused = await post('/api/undo', { undoToken: first.body.undoToken });
    expect(refused.body.ok).toBe(false);
    expect(refused.body.receipt.verdict).toBe('failed');
  });

  it('a refused save is "failed" and says nothing changed', async () => {
    const bad = await post('/api/save-config', { values: { routing: 'banana' } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.receipt.verdict).toBe('failed');
    expect(bad.body.receipt.headline).toMatch(/Nothing on your machine changed/);
  });

  it('a bad token changes nothing and records no receipt', async () => {
    const before = (await get('/api/receipts')).receipts.length;
    const forged = await post('/api/save-brain-power', { values: { brainEnabled: false } }, 'f'.repeat(48));
    expect(forged.status).toBe(403);
    expect(forged.body.receipt).toBeUndefined();
    expect((await get('/api/receipts')).receipts.length).toBe(before);
    expect(fs.existsSync(path.join(root, '.config', 'ruvnet-brain', 'brain-off'))).toBe(false);
  });
});
