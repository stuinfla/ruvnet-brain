// Install and update are one transaction (architecture 2.3): verify the signature and every file,
// stage, run the probes on the new pack, switch the one pointer file, probe again through the real
// server, and put the pointer back by itself if that second check fails.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { check } from '../contract/validate.mjs';
import { trustedPublicKey, verify } from '../contract/signature.mjs';
import { paths, readJson, sha256File, writeJsonAtomic } from '../contract/home.mjs';
import { HOME_ENV } from '../contract/constants.mjs';
import { verdict } from '../contract/verdict.mjs';
import { readEvidence } from '../health/status.mjs';
import { startServer } from './mcp-client.mjs';

export class Refused extends Error {}

function within(dir, rel) {
  const p = path.resolve(dir, ...rel.split('/'));
  if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Refused(`${rel} points outside the release`);
  return p;
}

function verifyFiles(dir, files, what) {
  for (const f of files) {
    const p = within(dir, f.path);
    let size = -1;
    try {
      size = fs.statSync(p).size;
    } catch {}
    if (size !== f.size || sha256File(p) !== f.sha256) throw new Refused(`${what} file ${f.path} does not match the signed release (missing, changed or damaged)`);
  }
}

/** Copies exactly the listed files into dest (via a staging folder and a rename). True if created. */
function stage(fromDir, files, dest) {
  if (fs.existsSync(dest)) {
    verifyFiles(dest, files, `installed ${path.basename(dest)}`);
    return false;
  }
  const tmp = `${dest}.staging-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const to = within(tmp, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(within(fromDir, f.path), to);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(tmp, dest);
  return true;
}

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
  const srv = startServer(path.join(appDir, 'plugin', 'claude', 'launch.mjs'), { ...process.env, [HOME_ENV]: home });
  try {
    await srv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ruvnet-brain-installer', version: '5' } });
    const [probe] = readJson(path.join(packDir, 'PROBES.json')).probes;
    const res = await srv.call('tools/call', { name: 'search_ruvnet', arguments: { query: probe.question } }, 60_000);
    const text = res?.content?.[0]?.text ?? '';
    const found = !res?.isError && text.split('\n')[1] === 'MODE · normal' && text.includes(`. ${probe.expect} · lines`);
    const v = verdict({ ...readEvidence(home, { pids: [srv.child.pid] }), update: null });
    if (!found) return { ok: false, verdict: v, reason: `the real server did not return ${probe.expect} for its probe` };
    return { ok: v.state === 'ok', verdict: v, reason: v.reason };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    await srv.close();
  }
}

function writeRawAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

/** Keeps the active generation and exactly one earlier one; removes the rest. */
function prune(home, cur) {
  const keep = { app: [cur.app, cur.previous?.app], packs: [cur.pack, cur.previous?.pack] };
  for (const kind of ['app', 'packs']) {
    for (const name of fs.readdirSync(paths(home)[kind])) {
      if (!keep[kind].includes(name)) fs.rmSync(path.join(paths(home)[kind], name), { recursive: true, force: true });
    }
  }
}

export async function install({ home, from }) {
  let release;
  try {
    release = check('release', readJson(path.join(from, 'release.json')), 'release.json');
  } catch (e) {
    throw new Refused(e instanceof SyntaxError || e.code === 'ENOENT' ? `no readable release.json in ${from}` : e.message);
  }
  if (!verify(release, trustedPublicKey())) throw new Refused('release.json is not signed by the RuvNet Brain release key');
  verifyFiles(path.join(from, 'app'), release.app.files, 'app');
  verifyFiles(path.join(from, 'pack'), release.pack.files, 'pack');
  if (readJson(path.join(from, 'pack', 'PACK.json')).generation !== release.pack.generation) throw new Refused('the pack is not the one the release names');

  const p = paths(home);
  const curRaw = fs.existsSync(p.current) ? fs.readFileSync(p.current) : null;
  const cur = curRaw ? JSON.parse(curRaw) : null;
  if (cur && release.releaseNumber < cur.releaseNumber) throw new Refused(`release ${release.releaseNumber} is older than the installed release ${cur.releaseNumber}`);
  const to = { app: release.app.version, pack: release.pack.generation };
  const appDir = path.join(p.app, to.app);
  const packDir = path.join(p.packs, to.pack);
  const created = [];
  if (stage(path.join(from, 'app'), release.app.files, appDir)) created.push(appDir);
  if (stage(path.join(from, 'pack'), release.pack.files, packDir)) created.push(packDir);
  const unstage = () => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

  const pre = await probeInProcess(appDir, packDir);
  if (!pre.ok) {
    unstage();
    const reason = pre.error ?? `${pre.results.filter((r) => !r.pass).length} of ${pre.results.length} probes did not find their file`;
    writeJsonAtomic(p.update, { result: 'refused', stage: 'pre-switch-probes', rolledBack: false, at: Date.now(), to, reason });
    throw new Refused(`the new pack failed its probes before the switch (${reason}); nothing was changed`);
  }

  const next = { schema: 'ruvnet-brain/current', version: 1, app: to.app, pack: to.pack, releaseNumber: release.releaseNumber, previous: cur ? { app: cur.app, pack: cur.pack, releaseNumber: cur.releaseNumber } : null, switchedAt: new Date().toISOString() };
  writeJsonAtomic(p.current, next);
  const post = await probeThroughServer(home, appDir, packDir);
  if (!post.ok) {
    if (curRaw) writeRawAtomic(p.current, curRaw);
    else fs.rmSync(p.current, { force: true });
    unstage();
    writeJsonAtomic(p.update, { result: 'rolled-back', stage: 'post-switch', rolledBack: true, at: Date.now(), from: cur && { app: cur.app, pack: cur.pack }, to, reason: post.reason });
    throw new Refused(`the new version failed its check through the real server after the switch (${post.reason}); the previous version was put back`);
  }
  writeJsonAtomic(p.update, { result: 'installed', rolledBack: false, at: Date.now(), from: cur && { app: cur.app, pack: cur.pack }, to });
  prune(home, next);
  return { current: next, verdict: post.verdict };
}
