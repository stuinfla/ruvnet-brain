// Drives one installation through every health state S6 and S11 name, calling visit(state, home)
// in each: not-installed, ok, stopped, stale (heartbeat old), damaged (index overwritten in place).
// "stopped" and "stale" come while the pack is still intact, so a doctor that ran its own search
// instead of reading the verdict would say OK there and be caught.
import fs from 'node:fs';
import path from 'node:path';
import { readPointerRaw, readStatus, sleeper, waitFor } from './helpers.mjs';

export const PROBE_INTERVAL_MS = 500;

async function liveServer(ctx, tree, home) {
  const srv = await ctx.server(tree, home);
  await waitFor(() => readStatus(home, srv.pid)?.probe?.ok, 20_000, 'the start-up self-test');
  return srv;
}

export async function walkStates(ctx, tree, visit) {
  await visit('not-installed', ctx.tmp('rb5-empty-'));

  const { home } = ctx.installed(tree, { config: { probeIntervalMs: PROBE_INTERVAL_MS } });
  const first = await liveServer(ctx, tree, home);
  await visit('ok', home);

  await first.close();
  await visit('stopped', home);

  const other = sleeper();
  const staleFile = path.join(home, 'state', 'status', `${other.pid}.json`);
  try {
    const stale = Date.now() - 10 * 60_000;
    fs.writeFileSync(staleFile, JSON.stringify({ schema: 'ruvnet-brain/status', version: 1, pid: other.pid, startedAt: stale, heartbeatAt: stale, app: 'x', pack: 'y', knowledgeDate: '2026-11-14', lanes: [{ name: 'lexical', available: true }], probe: { ok: true, at: stale, results: [] }, lastSearch: null }));
    await visit('stale', home);
  } finally {
    other.kill();
    fs.rmSync(staleFile, { force: true });
  }

  const second = await liveServer(ctx, tree, home);
  const db = path.join(home, 'packs', JSON.parse(readPointerRaw(home)).pack, 'lexical.db');
  const fd = fs.openSync(db, 'r+');
  fs.writeSync(fd, Buffer.alloc(100, 0x41), 0, 100, 0);
  fs.closeSync(fd);
  await visit('damaged', home, { damagedAt: Date.now() });
  await second.close();
}
