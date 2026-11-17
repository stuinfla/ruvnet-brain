// Install and update are one transaction (architecture 2.3): read and check the signed release,
// check the disk, take the lock, stage every file by streaming it through its hash, run the probes
// on the new pack, switch the one pointer file, probe again through the real server, and put the
// pointer back by itself if that second check fails. A journal records each step, so a run killed at
// any step is undone (or finished, once committed) by the next run. Every write is checked against
// the plan that `install --plan` prints.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from '../contract/validate.mjs';
import { trustedPublicKey, verify } from '../contract/signature.mjs';
import { paths, readConfig, readJson, writeJsonAtomic } from '../contract/home.mjs';
import { HOME_ENV, SHIM_VERSION } from '../contract/constants.mjs';
import { assess } from '../health/assess.mjs';
import { readEvidence } from '../health/status.mjs';
import { startServer } from './mcp-client.mjs';
import { Refused, copyVerified, matches, openSource, within } from './source.mjs';
import { acquire, newJournal, prune, pruneTargets, recover, rel, saveJournal, txnPaths, undo } from './txn.mjs';
import { freeBytes, HEADROOM } from './disk.mjs';

export { Refused };

async function probeInProcess(appDir, packDir) {
  const engine = await import(pathToFileURL(path.join(appDir, 'engine', 'index.mjs')).href);
  let h = null;
  try {
    h = engine.open(packDir);
    return engine.selfTest(h);
  } catch (e) {
    return { ok: false, error: e.message, results: [] };
  } finally {
    if (h) engine.close(h);
  }
}

async function probeThroughServer(home, appDir, packDir) {
  let srv;
  try {
    srv = startServer(path.join(appDir, 'plugin', 'claude', 'launch.mjs'), { ...process.env, [HOME_ENV]: home });
    await srv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ruvnet-brain-installer', version: '5' } });
    const [probe] = JSON.parse(fs.readFileSync(path.join(packDir, 'PROBES.json'), 'utf8')).probes;
    const res = await srv.call('tools/call', { name: 'search_ruvnet', arguments: { query: probe.question } }, 60_000);
    const text = res?.content?.[0]?.text ?? '';
    const found = !res?.isError && text.split('\n')[1] === 'MODE · normal' && text.includes(`. ${probe.expect} · lines`);
    const v = assess({ ...readEvidence(home, { pids: [srv.child.pid] }), update: null });
    if (!found) return { ok: false, verdict: v, reason: `the real server did not return ${probe.expect} for its probe` };
    return { ok: v.state === 'ok', verdict: v, reason: v.reason };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    await srv?.close();
  }
}

/** Reads, schema-checks and signature-checks release.json. Writes nothing. */
export async function readRelease(src) {
  let release;
  try {
    release = check('release', JSON.parse(await src.releaseText()), 'release.json');
  } catch (e) {
    throw e instanceof Refused ? e : new Refused(e instanceof SyntaxError ? `release.json in ${src.where} is not valid JSON` : e.message);
  }
  if (!verify(release, trustedPublicKey())) throw new Refused('release.json is not signed by the RuvNet Brain release key');
  if (release.minShim > SHIM_VERSION) throw new Refused(`this release needs shim version ${release.minShim}; this installer carries version ${SHIM_VERSION}. Update the RuvNet Brain plugin first`);
  return release;
}

/** The generation kept as "previous": the active one, unless the same release is being installed again. */
const earlier = (cur, to) => {
  if (!cur) return null;
  if (cur.app === to.app && cur.pack === to.pack) return cur.previous ?? null;
  return { app: cur.app, pack: cur.pack, releaseNumber: cur.releaseNumber };
};

const sizeOf = (files) => files.reduce((n, f) => n + f.size, 0);
const partialBytes = (dir) => {
  let n = 0;
  (function walk(d) {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of ents) e.isDirectory() ? walk(path.join(d, e.name)) : (n += fs.statSync(path.join(d, e.name)).size);
  })(dir);
  return n;
};

/**
 * Everything the transaction will do, worked out before it writes anything: the files it will leave
 * (`write`), the temporary names it may use and removes before it ends (`temporary`), what it will
 * remove (`remove`), and the bytes it needs. `install --plan` prints exactly this.
 */
export async function makePlan(home, release, src = null) {
  const p = paths(home);
  let cur = null;
  try {
    cur = JSON.parse(fs.readFileSync(p.current, 'utf8'));
  } catch {}
  if (cur && release.releaseNumber < cur.releaseNumber) throw new Refused(`release ${release.releaseNumber} is older than the installed release ${cur.releaseNumber}`);
  const to = { app: release.app.version, pack: release.pack.generation };
  const parts = [
    { part: 'app', what: 'app', files: release.app.files, dest: path.join(p.app, to.app) },
    { part: 'pack', what: 'pack', files: release.pack.files, dest: path.join(p.packs, to.pack) },
  ];
  const write = ['current.json', 'state/update.json'];
  // A first install from a web address records it as the update address, unless one is set.
  const recordSource = src?.kind === 'web' && !readConfig(home).updateUrl ? src.where : null;
  if (recordSource) write.push('state/config.json');
  let need = 0;
  for (const s of parts) {
    s.fresh = !fs.existsSync(s.dest) || !(await matches(s.dest, s.files));
    if (!s.fresh) continue;
    for (const f of s.files) write.push(rel(home, within(s.dest, f.path)));
    need += Math.max(0, sizeOf(s.files) - partialBytes(`${s.dest}.partial`));
  }
  const next = { app: to.app, pack: to.pack, previous: earlier(cur, to) };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const temporary = [
    'state/lock.json', 'state/journal.json', `app/${to.app}.partial/**`, `packs/${to.pack}.partial/**`, `app/${to.app}.damaged-*/**`, `packs/${to.pack}.damaged-*/**`,
    '*.tmp', 'state/*.tmp', 'state/status/<pid>.json', 'state/status/*.tmp',
  ];
  const temporaryRx = [
    /^state\/(lock|journal)\.json$/, new RegExp(`^app/${esc(to.app)}\\.(partial|damaged-\\d+)/`), new RegExp(`^packs/${esc(to.pack)}\\.(partial|damaged-\\d+)/`),
    /^[^/]+\.\d+\.[0-9a-f]{8}\.tmp$/, /^state\/[^/]+\.\d+\.[0-9a-f]{8}\.tmp$/, /^state\/status\/\d+\.json(\.\d+\.[0-9a-f]{8}\.tmp)?$/,
  ];
  const free = freeBytes(home);
  return { home, release, cur, to, parts, write, recordSource, temporary, temporaryRx, remove: pruneTargets(home, next).filter((r) => !/\.partial$/.test(r)), need, free, next };
}

export function printPlan(plan, src, out = console.log, hostFiles = []) {
  const r = plan.release;
  const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  out(`plan: ${plan.cur ? 'update' : 'install'} to release ${r.releaseNumber}: app ${plan.to.app} (${r.app.files.length} files), pack ${plan.to.pack} (${r.pack.files.length} files)`);
  out(`source: ${src.where} (${src.kind === 'web' ? `downloads ${mb(plan.need)}` : `copies ${mb(plan.need)}`})`);
  out(`disk: needs ${mb(plan.need + HEADROOM)} including ${mb(HEADROOM)} headroom; ${plan.free === null ? 'free space unknown' : `${mb(plan.free)} free`}`);
  out(`brain home: ${plan.home}`);
  out('will write:');
  for (const w of plan.write) out(`  ${w}`);
  out('temporary (removed before the command ends):');
  for (const t of plan.temporary) out(`  ${t}`);
  out('will remove:');
  for (const x of plan.remove) out(`  ${x}`);
  if (!hostFiles.length) out('outside the brain home: nothing (no host registration, no scheduled job, no settings file)');
  else {
    out('outside the brain home (host registration, --register-hosts):');
    for (const f of hostFiles) out(`  ${f}`);
  }
}

function guard(plan) {
  return (abs) => {
    const r = rel(plan.home, abs);
    if (plan.write.includes(r) || plan.temporaryRx.some((rx) => rx.test(r))) return abs;
    throw new Error(`internal error: ${r} is not in the install plan; nothing outside the plan is written`);
  };
}

function step(j, name, phase) {
  j.step = name;
  if (phase) j.phase = phase;
  saveJournal(j.home, j);
}

async function stageDir(src, s, j, ok) {
  if (!s.fresh) return;
  const home = j.home;
  if (fs.existsSync(s.dest)) {
    // An installed copy of this exact release that no longer matches its hashes: set it aside.
    const aside = `${s.dest}.damaged-${Date.now()}`;
    j.aside.push({ from: rel(home, s.dest), to: rel(home, aside) });
    step(j, `${s.part}-set-aside`);
    fs.renameSync(s.dest, aside);
  }
  const partial = `${s.dest}.partial`;
  step(j, `${s.part}-staging`);
  const listed = new Set(s.files.map((f) => within(partial, f.path)));
  (function sweep(d) {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of ents) {
      const x = path.join(d, e.name);
      if (e.isDirectory()) sweep(x);
      else if (!listed.has(x)) fs.rmSync(x, { force: true });
    }
  })(partial);
  let first = true;
  for (const f of s.files) {
    await copyVerified(src, s.part, f, ok(within(partial, f.path)), s.what);
    if (first) step(j, `${s.part}-first-file`);
    first = false;
  }
  j.created.push(rel(home, s.dest));
  step(j, `${s.part}-rename`);
  fs.renameSync(partial, s.dest);
}

/**
 * Installs or updates from `from` (a release folder or web address). With planOnly, returns the plan
 * and writes nothing. Throws Refused with one plain sentence when the release is not installed.
 */
export async function install({ home, from, planOnly = false, log = () => {} }) {
  const src = typeof from === 'string' ? openSource(from) : from;
  const release = await readRelease(src);
  const first = await makePlan(home, release, src);
  if (planOnly) return { plan: first, src };
  if (first.free !== null && first.need + HEADROOM > first.free) {
    const short = first.need + HEADROOM - first.free;
    throw new Refused(`not enough free disk: this needs ${first.need + HEADROOM} bytes (${(first.need / 1e9).toFixed(2)} GB plus headroom) and ${first.free} bytes are free; short by ${short} bytes (${(short / 1e9).toFixed(2)} GB). Nothing was written`);
  }
  const p = paths(home);
  const release_ = acquire(home);
  try {
    const did = recover(home);
    if (did) log(did);
    const plan = did ? await makePlan(home, release, src) : first;
    const ok = guard(plan);
    const curRaw = fs.existsSync(p.current) ? fs.readFileSync(p.current) : null;
    const cur = plan.cur;
    const to = plan.to;
    const j = Object.assign(newJournal(home, cur ? 'update' : 'install', curRaw, to), { home });
    for (const s of plan.parts) {
      for (const stale of fs.existsSync(path.dirname(s.dest)) ? fs.readdirSync(path.dirname(s.dest)) : []) {
        if (stale.endsWith('.partial') && stale !== `${path.basename(s.dest)}.partial`) fs.rmSync(path.join(path.dirname(s.dest), stale), { recursive: true, force: true });
      }
    }
    ok(txnPaths(home).journal);
    step(j, 'begin');
    try {
      for (const s of plan.parts) await stageDir(src, s, j, ok);
    } catch (e) {
      undo(home, j);
      if (e instanceof Refused) for (const s of plan.parts) fs.rmSync(`${s.dest}.partial`, { recursive: true, force: true });
      fs.rmSync(txnPaths(home).journal, { force: true });
      throw e;
    }
    const appDir = path.join(p.app, to.app);
    const packDir = path.join(p.packs, to.pack);

    step(j, 'pre-probe');
    const pre = await probeInProcess(appDir, packDir);
    if (!pre.ok) {
      step(j, 'refuse');
      undo(home, j);
      const reason = pre.error ?? `${pre.results.filter((r) => !r.pass).length} of ${pre.results.length} probes did not find their file`;
      writeJsonAtomic(ok(p.update), { result: 'refused', stage: 'pre-switch-probes', rolledBack: false, at: Date.now(), to, reason });
      fs.rmSync(txnPaths(home).journal, { force: true });
      throw new Refused(`the new pack failed its probes before the switch (${reason}); nothing was changed`);
    }

    const next = { schema: 'ruvnet-brain/current', version: 1, app: to.app, pack: to.pack, releaseNumber: release.releaseNumber, minShim: release.minShim, previous: earlier(cur, to), switchedAt: new Date().toISOString() };
    step(j, 'switch');
    writeJsonAtomic(ok(p.current), next);
    step(j, 'post-probe', 'switched');
    const post = await probeThroughServer(home, appDir, packDir);
    if (!post.ok) {
      step(j, 'rollback');
      undo(home, j);
      writeJsonAtomic(ok(p.update), { result: 'rolled-back', stage: 'post-switch', rolledBack: true, at: Date.now(), from: cur && { app: cur.app, pack: cur.pack }, to, reason: post.reason });
      fs.rmSync(txnPaths(home).journal, { force: true });
      throw new Refused(`the new version failed its check through the real server after the switch (${post.reason}); the previous version was put back`);
    }
    j.next = next;
    j.record = { result: 'installed', rolledBack: false, at: Date.now(), from: cur && { app: cur.app, pack: cur.pack }, to };
    step(j, 'commit', 'committed');
    writeJsonAtomic(ok(p.update), j.record);
    if (plan.recordSource) writeJsonAtomic(ok(p.config), { ...readJson(p.config, {}), updateUrl: plan.recordSource });
    step(j, 'prune');
    prune(home, next);
    step(j, 'done');
    fs.rmSync(txnPaths(home).journal, { force: true });
    return { current: next, verdict: post.verdict, plan };
  } finally {
    release_();
  }
}

/** Finishes or undoes an interrupted transaction and removes everything prune would. */
export function clean(home) {
  const p = paths(home);
  if (!fs.existsSync(home)) return { did: null };
  const release_ = acquire(home);
  try {
    const did = recover(home);
    let cur = null;
    try {
      cur = JSON.parse(fs.readFileSync(p.current, 'utf8'));
    } catch {}
    const removed = cur ? pruneTargets(home, cur) : [];
    if (cur) prune(home, cur);
    return { did, removed };
  } finally {
    release_();
  }
}

