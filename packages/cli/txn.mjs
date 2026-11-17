// The storage transaction's bookkeeping: one lock that install, update, clean and uninstall all
// take, one journal that says what a running transaction has changed, and the recovery that puts
// the home back to its last working state when a transaction was killed part-way.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, readJson, writeJsonAtomic } from '../contract/home.mjs';
import { isAlive } from '../health/status.mjs';
import { Refused } from './source.mjs';

export const txnPaths = (home) => ({ lock: path.join(home, 'state', 'lock.json'), journal: path.join(home, 'state', 'journal.json') });

export function writeRawAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

/** Takes the home's one lock, or refuses while a live process holds it. Returns the release call. */
export function acquire(home) {
  const { lock } = txnPaths(home);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return () => {
        if (readJson(lock, null)?.pid === process.pid) fs.rmSync(lock, { force: true });
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readJson(lock, null);
      let young = false;
      try {
        young = Date.now() - fs.statSync(lock).mtimeMs < 5000;
      } catch {}
      if (held?.pid === process.pid) throw new Refused('an install or update is already running in this process');
      if (held ? isAlive(held.pid) : young) throw new Refused(`another install, update or uninstall is running (process ${held?.pid ?? 'starting'}); try again when it ends`);
      fs.rmSync(lock, { force: true }); // its owner is gone (killed or crashed): the lock is stale
    }
  }
  throw new Refused('could not take the install lock');
}

export const rel = (home, abs) => path.relative(home, abs).split(path.sep).join('/');
const abs = (home, r) => path.join(home, ...r.split('/'));

/** Keeps the active generation and exactly one earlier one; removes every other entry. */
export function pruneTargets(home, cur) {
  const keep = { app: [cur.app, cur.previous?.app], packs: [cur.pack, cur.previous?.pack] };
  const out = [];
  for (const kind of ['app', 'packs']) {
    let names = [];
    try {
      names = fs.readdirSync(paths(home)[kind]);
    } catch {}
    for (const name of names) if (!keep[kind].includes(name)) out.push(`${kind}/${name}`);
  }
  return out;
}

export function prune(home, cur) {
  for (const r of pruneTargets(home, cur)) fs.rmSync(abs(home, r), { recursive: true, force: true, maxRetries: 3 });
}

export function newJournal(home, kind, beforeBytes, to) {
  return { kind, phase: 'staging', step: 'begin', pid: process.pid, at: Date.now(), to, before: beforeBytes ? beforeBytes.toString('base64') : null, created: [], aside: [], record: null, next: null };
}

/** A first web install records its address as the update source, unless one is set already. */
export function recordUpdateUrl(home, url) {
  const file = paths(home).config;
  const cfg = readJson(file, {});
  if (url && !cfg.updateUrl) writeJsonAtomic(file, { ...cfg, updateUrl: url });
}

export const saveJournal = (home, j) => writeJsonAtomic(txnPaths(home).journal, j);

/** Undo an unfinished transaction: the pointer back byte for byte, its new folders removed. */
export function undo(home, j) {
  const p = paths(home);
  if (j.before === null) fs.rmSync(p.current, { force: true });
  else writeRawAtomic(p.current, Buffer.from(j.before, 'base64'));
  for (const r of j.created) fs.rmSync(abs(home, r), { recursive: true, force: true, maxRetries: 3 });
  for (const a of j.aside) if (fs.existsSync(abs(home, a.to)) && !fs.existsSync(abs(home, a.from))) fs.renameSync(abs(home, a.to), abs(home, a.from));
}

/**
 * Called with the lock held, before any new work. A transaction that never committed is undone; one
 * that committed is finished (its record written, older generations pruned). Returns what it did.
 */
export function recover(home) {
  const j = readJson(txnPaths(home).journal, null);
  if (!j) return null;
  let did;
  if (j.phase === 'committed' && j.next) {
    if (j.record) writeJsonAtomic(paths(home).update, j.record);
    recordUpdateUrl(home, j.updateUrl);
    prune(home, j.next);
    did = `finished an interrupted ${j.kind} of ${j.to?.app} (it had already passed its checks)`;
  } else {
    undo(home, j);
    did = `undid an interrupted ${j.kind} of ${j.to?.app} (stopped at step "${j.step}"); the previous state is back`;
  }
  fs.rmSync(txnPaths(home).journal, { force: true });
  return did;
}
