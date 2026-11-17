// Uninstall: list what will be removed, keep private/ unless told otherwise, remove, then look at the
// whole brain home again and report what is really still there. It never says "clean" from memory.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../contract/home.mjs';
import { acquire, recover } from './txn.mjs';

function walk(dir, skip) {
  const out = [];
  (function rec(d) {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const x = path.join(d, e.name);
      if (skip.includes(x)) continue;
      if (e.isDirectory()) {
        const before = out.length;
        rec(x);
        if (out.length === before && !fs.readdirSync(x).length) out.push(`${x}${path.sep}`);
      } else out.push(x);
    }
  })(dir);
  return out;
}

export function uninstall(home, { purgePrivate = false, out = console.log } = {}) {
  const p = paths(home);
  if (!fs.existsSync(home)) {
    out(`nothing to remove: ${home} does not exist`);
    return { left: [], kept: false };
  }
  let releaseLock = () => {};
  try {
    releaseLock = acquire(home);
    recover(home);
  } catch (e) {
    out(`uninstall refused: ${e.message}`);
    return { left: [home], kept: false, refused: true };
  }
  const plan = [p.current, p.app, p.packs, p.state, ...(purgePrivate ? [p.private] : [])].filter((x) => fs.existsSync(x));
  out(plan.length ? `will remove:\n${plan.map((x) => `  ${x}`).join('\n')}` : 'nothing to remove');
  out('host registrations: none are made by this version, so none are removed');
  const failed = [];
  for (const x of plan) {
    try {
      fs.rmSync(x, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      failed.push(`${x} (${e.code ?? e.message})`);
    }
  }
  releaseLock();
  const kept = fs.existsSync(p.private) && !purgePrivate;
  const left = walk(home, kept ? [p.private] : []);
  try {
    if (!fs.readdirSync(home).length) fs.rmdirSync(home);
  } catch {}
  for (const f of failed) out(`could not remove: ${f}`);
  if (left.length) out(`still present after removal (checked again):\n${left.map((x) => `  ${x}`).join('\n')}`);
  else out(`checked again: nothing listed remains.${kept ? ` Kept ${p.private} (use --purge-private to remove it).` : ''}`);
  return { left, kept };
}
