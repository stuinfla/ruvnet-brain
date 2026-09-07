#!/usr/bin/env node
// scripts/verify-channels.mjs — the release-channel protocol. WALK EVERY PATH A USER WALKS.
//
// WHY (2026-07-17, Stuart, after a real client hit a broken install): "whenever you push it, you are
// verifying all the aspects — the explainer page, the GitHub repo, the npm, the npx — all are working
// flawlessly. Having people find out the experience is lousy because you didn't track it is 100%
// unacceptable." He is right. The root failure was assuming the repo state equals the user experience
// (see AgentDB lesson: YOUR ASSUMPTIONS = FAILURE). CI green != it works; committed != shipped;
// pushed != the npm package is current.
//
// This script asserts, against the LIVE endpoints (never the repo, never a guess), that every channel
// is current AND reachable. Exit 0 = all channels good. Exit 1 = at least one is broken/stale — and
// the word "shipped" MUST NOT be uttered until this passes.
//
// Usage:
//   node scripts/verify-channels.mjs            # check all channels against the local plugin version
//   node scripts/verify-channels.mjs --json     # machine-readable
//
// Checks (each hits the real thing):
//   1. npm registry     — `ruvnet-brain` latest dist-tag == the shipping plugin version (not stale)
//   2. self-update path — the bundle's canonicalManifestUrl actually resolves (no 404 — Jan's bug)
//   3. release bundle   — releases/latest/download/ruvnet-brain.zip is downloadable (HTTP 200)
//   4. release signature— the .sig asset exists next to the bundle (auto-apply needs it)
//   5. explainer (live) — isovision.ai serves the current major.minor AND the update one-liner
//   6. git remote       — local HEAD is pushed to origin/main (no unpushed shipped code)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JSON_OUT = process.argv.includes('--json');
const PRE_PUSH = process.argv.includes('--pre-push'); // git pre-push hook mode: block only on what is KNOWABLE before the push
const REPO = 'stuinfla/ruvnet-brain';
const NPM_PKG = 'ruvnet-brain';
const EXPLAINER = 'https://isovision.ai/ruvnet-brain/';

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
const pluginVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')).version;
const mm = (v) => (String(v).match(/^(\d+\.\d+)/) || [, '?'])[1];

async function head(url, timeout = 20000) {
  const ctl = AbortSignal.timeout(timeout);
  try { const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl, headers: { 'user-agent': 'ruvnet-brain-verify' } }); return { ok: r.ok, status: r.status, r }; }
  catch (e) { return { ok: false, status: 0, error: e.message }; }
}

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };

async function run() {
  const V = pluginVersion();

  // ── PRE-PUSH MODE ──────────────────────────────────────────────────────────
  // Runs from the git pre-push hook. It can ONLY block on things knowable BEFORE the push —
  // i.e. what I am about to ship. npm-latest and the live explainer are DOWNSTREAM of a push
  // (publish + Vercel deploy happen after), so blocking on them here would refuse every honest
  // push. The two things that stranded Jan and are 100% knowable now: (a) the version surfaces
  // disagree, (b) the self-update manifest in the SOURCE.json I'm shipping 404s. Block on those.
  if (PRE_PUSH) {
    // a) version single-source-of-truth
    const sv = execFileSync(process.execPath, [path.join(ROOT, 'scripts/sync-version.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('version surfaces agree', /agree|✓/i.test(sv), sv.trim().split('\n').pop());
    // b) the self-update manifest URL in the bundle SOURCE.json resolves (the exact 404 that broke --update)
    let manifestUrl = null;
    try { const sj = JSON.parse(fs.readFileSync(path.join(ROOT, 'kb/SOURCE.json'), 'utf8'));
      const find = (o) => { if (!o || typeof o !== 'object') return null; if (o.canonicalManifestUrl) return o.canonicalManifestUrl; for (const k of Object.keys(o)) { const r = find(o[k]); if (r) return r; } return null; };
      manifestUrl = find(sj); } catch { /* */ }
    if (!manifestUrl) check('self-update manifest URL present', false, 'no canonicalManifestUrl in kb/SOURCE.json');
    else { const h = await head(manifestUrl); check('self-update manifest resolves (no 404)', h.ok, `${manifestUrl} → HTTP ${h.status}${h.ok ? '' : '  ← would strand every --update user, exactly like Jan'}`); }

    const failed = results.filter((r) => !r.pass);
    console.log(`\n  ${c.b('pre-push gate')} ${c.dim('· shipping ' + V + ' · (npm/explainer are verified post-publish by `release.mjs --publish`)')}`);
    for (const r of results) console.log(`   ${r.pass ? c.g('✓') : c.r('✗')} ${r.name}  ${c.dim(r.detail || '')}`);
    if (failed.length) { console.log(`\n  ${c.r('✗ pre-push gate FAILED — push refused. Fix the above; do not --no-verify around it.')}\n`); process.exit(1); }
    console.log(`\n  ${c.g('✓ version/channel checks passed — document currency runs next.')}\n`);
    process.exit(0);
  }

  // 1) npm registry latest == shipping version. npm's read replicas lag a few seconds behind a fresh
  // publish, so a single immediate `npm view` right after `release.mjs` publishes can still return the
  // PRIOR version — a false STALE that fails an otherwise-perfect ship (hit exactly this 2026-07-18:
  // publish succeeded, `+ ruvnet-brain@3.4.9-dev`, yet the immediate view read 3.4.8-dev). Retry with a
  // short backoff so propagation lag is absorbed, while a publish that genuinely never landed still
  // fails after the window. A gate that false-fails teaches you to distrust the gate — the worst outcome.
  {
    let latest = '', ok = false, lastErr = '';
    const ATTEMPTS = 6; // up to ~6×5s = 30s of propagation tolerance
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        latest = execFileSync('npm', ['view', NPM_PKG, 'dist-tags.latest'], { encoding: 'utf8', timeout: 30000 }).trim();
        if (latest === V) { ok = true; break; }
      } catch (e) { lastErr = e.message.split('\n')[0]; }
      if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 5000));
    }
    check('npm latest matches shipping version', ok,
      ok ? `npm latest=${latest} · shipping=${V}`
        : `npm latest=${latest || '(view failed: ' + lastErr + ')'} · shipping=${V}${latest && latest !== V ? '  ← STILL STALE after ~' + (ATTEMPTS * 5) + 's: dispatch the protected-release workflow for the exact candidate SHA' : ''}`);
  }

  // 2) the self-update manifest URL actually resolves (the 404 that stranded users)
  let manifestUrl = null;
  try {
    const sj = JSON.parse(fs.readFileSync(path.join(ROOT, 'kb/SOURCE.json'), 'utf8'));
    const find = (o) => { if (!o || typeof o !== 'object') return null; if (o.canonicalManifestUrl) return o.canonicalManifestUrl; for (const k of Object.keys(o)) { const r = find(o[k]); if (r) return r; } return null; };
    manifestUrl = find(sj);
  } catch { /* */ }
  if (!manifestUrl) check('self-update manifest URL present', false, 'no canonicalManifestUrl in kb/SOURCE.json');
  else { const h = await head(manifestUrl); check('self-update manifest resolves (no 404)', h.ok, `${manifestUrl} → HTTP ${h.status}${h.ok ? '' : '  ← the exact 404 that broke --update'}`); }

  // 3) release bundle downloadable
  const bundleUrl = `https://github.com/${REPO}/releases/latest/download/ruvnet-brain.zip`;
  { const h = await head(bundleUrl); check('release bundle downloads', h.ok, `releases/latest/…/ruvnet-brain.zip → HTTP ${h.status}`); }

  // 3b) …AND IT IS THE VERSION WE ARE SHIPPING. Reachability is not currency.
  //
  // MEASURED 2026-07-24, and this gate reported SHIPPED while it was false. npm was moved to
  // 3.9.50-dev by `release.mjs --publish`; the GitHub Release stayed at v3.9.18-dev from 2026-07-23,
  // THIRTY-TWO versions behind. Every check above passed — the manifest resolved, the bundle
  // downloaded, the signature was present — because they all ask "does the latest release respond?"
  // and none asked "is the latest release the one we just built?" A 32-version-old bundle answers
  // HTTP 200 perfectly well.
  //
  // WHY THE GAP EXISTED AT ALL: the ship path is SPLIT and nothing said so. `release.mjs --publish`
  // publishes to npm and contains zero `gh release` calls; GitHub Releases are cut only by
  // `self-update.mjs`, which runs from the NIGHTLY. The nightly had been aborting since 2026-07-23 on
  // its (correct) main-only branch guard, so releases silently froze while npm advanced. Two channels,
  // two owners, one of them broken, and a verifier that could not tell.
  //
  // This is the same defect shape this repo has now fixed four times in one day: a proxy measured in
  // place of the thing (receipt-count for "is routing running", backlog-remaining for "is promotion in
  // force", cache-exists for "is this measurement current"). Reachability is the proxy; version is the
  // thing. Users updating via the release bundle get whatever THIS says, not whatever npm says.
  {
    let tag = null, err = null;
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': 'ruvnet-brain-verify-channels' },
      });
      if (r.ok) tag = (await r.json()).tag_name || null; else err = `HTTP ${r.status}`;
    } catch (e) { err = String(e && e.message || e); }
    // Tags carry a leading `v`; the version does not. Compare the bare versions.
    const bare = (s) => String(s || '').replace(/^v/, '');
    check('GitHub Release IS the shipping version', tag != null && bare(tag) === bare(V),
      tag == null
        ? `could not read releases/latest (${err}) — release currency NOT verified`
        : `release=${tag} · shipping=${V}${bare(tag) === bare(V) ? '' : `  ← ${bare(tag) !== bare(V) ? 'STALE: the release channel is behind npm. Cut the release, or users on --update stay on ' + tag : ''}`}`);
  }

  // 4) release signature present (auto-apply verifies against it)
  { const h = await head(`${bundleUrl}.sig`); check('release signature present', h.ok, `ruvnet-brain.zip.sig → HTTP ${h.status}`); }

  // 5) explainer live shows current major.minor AND the update command
  { const h = await head(EXPLAINER);
    if (!h.ok) check('explainer live + current', false, `${EXPLAINER} → HTTP ${h.status}`);
    else { const html = await h.r.text().catch(() => '');
      const bare = html.replace(/<[^>]+>/g, '').replace(/&(?:rsquo|apos|#8217|#39);/gi, "'");
      const newIn = [...bare.matchAll(/what[’']?s new in (\d+\.\d+)/gi)].map((m) => m[1]);
      const stale = newIn.filter((x) => x !== mm(V));
      const hasCmd = /ruvnet-brain@latest --update --auto/.test(bare);
      check('explainer live shows current version', stale.length === 0, stale.length ? `live still says "What's new in ${stale.join(', ')}" while ${mm(V)} ships` : `"What's new in ${mm(V)}" ✓`);
      check('explainer live shows the update command', hasCmd, hasCmd ? 'update one-liner present' : 'the --update --auto command is MISSING from the live page');
    }
  }

  // 6) local HEAD pushed to origin/main (no unpushed shipped code)
  try {
    const local = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const remote = execFileSync('git', ['-C', ROOT, 'ls-remote', 'origin', 'main'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    check('local HEAD pushed to origin/main', local === remote, local === remote ? 'in sync' : `local ${local.slice(0, 7)} != origin ${(remote || '').slice(0, 7)} — unpushed commits`);
  } catch (e) { check('local HEAD pushed to origin/main', false, `git check failed: ${e.message.split('\n')[0]}`); }

  const failed = results.filter((r) => !r.pass);
  if (JSON_OUT) { console.log(JSON.stringify({ version: V, ok: failed.length === 0, results }, null, 2)); process.exit(failed.length ? 1 : 0); }

  console.log(`\n  ${c.b('RuvNet Brain — channel verification')} ${c.dim('· shipping ' + V)}\n`);
  for (const r of results) console.log(`   ${r.pass ? c.g('✓') : c.r('✗')} ${r.name}\n      ${c.dim(r.detail || '')}`);
  if (failed.length) { console.log(`\n  ${c.r('✗ ' + failed.length + ' channel(s) BROKEN or STALE — this is NOT shipped. Fix, then re-run.')}\n`); process.exit(1); }
  console.log(`\n  ${c.g('✓ every channel is current and reachable — a user on any path gets the working, current build.')}\n`);
  process.exit(0);
}
run();
