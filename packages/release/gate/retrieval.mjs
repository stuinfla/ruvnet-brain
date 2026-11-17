// Layer 1 of the answer gate: deterministic, no model, runs in CI on every release candidate.
// The staged bytes are installed with the real installer into a fresh home and every question of the
// frozen set is asked through the installed server's real protocol (search_ruvnet), in two separate
// server processes. For each served result:
//   hit       a gold file is cited anywhere in the result
//   size      the delivered text is within the delivery ceiling (characters and estimated tokens)
//   once      no excerpt and no citation appears twice
//   same      the two processes served the same text (the per-response fence marker aside)
//   reasons   every empty section says why ("no match: <reason>")
//   normal    the result is not an error and not served in safe mode
// plus the pack's own probes through the same server. The hit count is compared with the baseline
// recorded in the set's manifest: lower by more than its tolerance fails. Nothing here records a
// question's text or gold: only its id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { HOME_ENV } from '../../contract/constants.mjs';
import { DELIVERY, ceilingOf, estimateTokens } from '../../contract/delivery.mjs';
import { readJson } from '../../contract/home.mjs';
import { trustedPublicKey } from '../../contract/signature.mjs';
import { startServer } from '../../cli/mcp-client.mjs';
import { Refused, verifyStaged } from '../checks.mjs';

const CITE = /^\d+\. (\S+) · lines \d+-\d+ · commit \S+ · standing \S+ · date \S+ · sha256 ([0-9a-f]{64})/;
const MARKER = /(<<<passage-|passage-)([a-z]{24})(>>>)?/g;
const SECTION = /^([A-Z][A-Z ]*) \((\d+)\)(.*)$/;

/** Installs the staged release into a fresh home with the real installer. */
export function installRelease({ packagesDir, releaseDir, timeoutMs = 300_000 }) {
  let trusted;
  try {
    trusted = trustedPublicKey();
  } catch (e) {
    throw new Refused(e.message);
  }
  const { release, sha256 } = verifyStaged(releaseDir, trusted);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb5-gate-'));
  const env = { ...process.env, NODE_NO_WARNINGS: '1', [HOME_ENV]: home };
  const r = spawnSync(process.execPath, [path.join(packagesDir, 'cli', 'ruvnet-brain.mjs'), 'install', '--from', releaseDir], { env, encoding: 'utf8', timeout: timeoutMs, cwd: os.tmpdir() });
  if (r.status !== 0) {
    fs.rmSync(home, { recursive: true, force: true });
    throw new Refused(`the installer refused the staged release: ${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-2).join(' ')}`);
  }
  const packDir = path.join(home, 'packs', release.pack.generation);
  return {
    home,
    env,
    release,
    sha256,
    packDir,
    launcher: path.join(home, 'app', release.app.version, 'plugin', 'claude', 'launch.mjs'),
    remove: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

/** Every repo/path the installed pack holds (what a citation must resolve to). */
export function packFiles(packDir) {
  const pack = readJson(path.join(packDir, 'PACK.json'));
  const out = new Set();
  for (const f of pack.files.filter((x) => x.role === 'lexical-db' || x.role === 'history-db')) {
    const db = new DatabaseSync(path.join(packDir, f.path), { readOnly: true });
    try {
      for (const r of db.prepare("SELECT DISTINCT repo, path FROM units WHERE path NOT LIKE 'history/%'").all()) out.add(`${r.repo}/${r.path}`);
    } finally {
      db.close();
    }
  }
  return out;
}

async function ask(server, query, timeoutMs) {
  try {
    const res = await server.call('tools/call', { name: 'search_ruvnet', arguments: { query } }, timeoutMs);
    return { text: res?.content?.map((c) => c.text).join('') ?? '', isError: !!res?.isError };
  } catch (e) {
    return { text: '', isError: true, error: e.message };
  }
}

/** The text with the per-response fence marker replaced, so two processes can be compared. */
export const normalise = (text) => text.replace(MARKER, (_, a, _m, b) => `${a}MARKER${b ?? ''}`);

/** The hard checks on one served result. Returns { files, problems }. */
export function inspect(res, ceiling) {
  const problems = [];
  const lines = res.text.split('\n');
  if (res.isError) problems.push('error');
  else if (/^SAFE MODE/.test(lines[1] ?? '')) problems.push('safe-mode');
  if (res.text.length > ceiling.maxChars) problems.push(`size: ${res.text.length} characters above ${ceiling.maxChars}`);
  const tokens = estimateTokens(res.text);
  if (tokens > ceiling.maxTokens) problems.push(`size: ${tokens} estimated tokens above ${ceiling.maxTokens}`);
  const files = [];
  const hashes = new Set();
  const cites = new Set();
  for (const l of lines) {
    const m = CITE.exec(l);
    if (!m) continue;
    files.push(m[1]);
    const cite = l.replace(/^\d+\. /, '');
    if (hashes.has(m[2]) || cites.has(cite)) problems.push('twice: a citation appears twice');
    hashes.add(m[2]);
    cites.add(cite);
  }
  const bodies = new Set();
  for (const b of normalise(res.text).split('<<<passage-MARKER\n').slice(1).map((x) => x.split('\npassage-MARKER>>>')[0])) {
    if (b.trim() && bodies.has(b)) problems.push('twice: an excerpt appears twice');
    bodies.add(b);
  }
  lines.forEach((l, i) => {
    const s = SECTION.exec(l);
    if (!s || (i > 0 && lines[i - 1] !== '')) return;
    if (Number(s[2]) === 0 && !/^ · no match: \S/.test(s[3])) problems.push(`reasons: section ${s[1]} is empty and does not say why`);
  });
  return { files: [...new Set(files)], problems: [...new Set(problems)] };
}

/**
 * Runs layer 1. Returns { release, sha256, ok, hit, of, baseline, tolerance, probes, problems, questions }.
 * `ok` is false when the count is below the baseline by more than the tolerance, when any probe
 * misses, or when any served result fails a hard check.
 */
export async function retrievalLayer({ packagesDir, releaseDir, set, timeoutMs = 120_000 }) {
  const inst = installRelease({ packagesDir, releaseDir });
  const servers = [];
  try {
    const recipe = readJson(path.join(inst.packDir, 'RECIPE.json'));
    const wanted = set.manifest.layer1.delivery ?? DELIVERY;
    const fromRecipe = ceilingOf(recipe);
    const ceiling = { maxChars: Math.min(fromRecipe.maxChars, wanted.maxChars), maxTokens: Math.min(fromRecipe.maxTokens, wanted.maxTokens) };
    const start = async () => {
      const s = startServer(inst.launcher, inst.env);
      servers.push(s);
      await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v5-answer-gate', version: '1' } }, timeoutMs);
      return s;
    };
    const first = await start();
    const probes = readJson(path.join(inst.packDir, 'PROBES.json')).probes;
    let probesPassed = 0;
    for (const p of probes) if (inspect(await ask(first, p.question, timeoutMs), ceiling).files.includes(p.expect)) probesPassed++;
    const a = [];
    for (const q of set.questions) a.push(await ask(first, q.question, timeoutMs));
    const second = await start();
    const b = [];
    for (const q of set.questions) b.push(await ask(second, q.question, timeoutMs));
    const questions = set.questions.map((q, i) => {
      const { files, problems } = inspect(a[i], ceiling);
      if (normalise(a[i].text) !== normalise(b[i].text)) problems.push('same: two processes served different results');
      return { id: q.id, group: q.group, hit: q.gold.some((g) => files.includes(g)), chars: a[i].text.length, tokens: estimateTokens(a[i].text), problems };
    });
    const hit = questions.filter((q) => q.hit).length;
    const { baseline, tolerance } = set.manifest.layer1;
    const problems = [];
    if (hit < baseline.hit - tolerance) problems.push(`${hit} of ${questions.length} questions served a gold file, below the baseline ${baseline.hit} of ${baseline.of} by more than the tolerance ${tolerance}`);
    if (probesPassed !== probes.length || !probes.length) problems.push(`${probesPassed} of ${probes.length} probes found their file`);
    const bad = questions.filter((q) => q.problems.length);
    if (bad.length) problems.push(`${bad.length} of ${questions.length} served results failed a hard check (first: ${bad[0].id}: ${bad[0].problems[0]})`);
    return { release: inst.release, sha256: inst.sha256, ok: problems.length === 0, hit, of: questions.length, baseline, tolerance, ceiling, probes: { passed: probesPassed, of: probes.length }, problems, questions };
  } finally {
    for (const s of servers) await s.close().catch(() => {});
    inst.remove();
  }
}
