#!/usr/bin/env node
// scripts/falsify.mjs — THE ADVERSARY. Ask the questions Stuart has to keep asking me.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY (2026-07-13). Stuart: "Why the fuck do you still keep needing me to call you on these things?
// Ru would not miss stuff like this. You are supposed to be acting like Ru."
//
// He is right, and the defect is mechanical, not motivational:
//
//     I VERIFY WHAT I BUILT. I DO NOT VERIFY WHETHER IT SHOULD EXIST.
//
// Tests I wrote passing is circular evidence — I wrote them to pass. Every miss tonight has that
// shape: the router worked (but rUv already shipped one); the jobs were "watched" (but nothing checked
// they ran); the gong was "complete" (but it never covered liveness). In each case my own artifacts
// said green, and the only thing that said otherwise was Stuart.
//
// Look at how rUv actually writes: every ADR carries an "Honest guardrail" and a measured number, and
// ADR-043 literally reports a TIE against the baseline rather than dressing it as a win. He starts from
// "this is probably wrong" and hunts for the thing that would prove it. I start from "this works."
//
// So this file is the missing step: BEFORE declaring done, run the questions an adversary would ask.
// Not a linter for code — a linter for CLAIMS.
//
// Usage:  node scripts/falsify.mjs            # run every check; exit 1 if any claim is unproven
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuflo, RUFLO_MISSING } from '../plugin/scripts/ruflo-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });

/**
 * Each check is a question Stuart had to ask me, turned into code so he never has to ask it again.
 * A check FAILS when the claim is unproven — not when the code is broken. That distinction is the
 * whole point: "it works" and "it should exist / it actually ran / it is really rUv's" are different
 * claims, and only the first one had any gate on it.
 */
export const CHECKS = [
  {
    id: 'am-i-impersonating-ruv',
    asked: '"You wrote a bunch of code and told me it\'s Ruv\'s code?"',
    why: 'I hand-rolled a router and called it MetaHarness while @metaharness/router sat on npm.',
    run: () => {
      const r = sh('node', ['scripts/no-silent-substitution.mjs']);
      return { ok: r.status === 0, detail: r.status === 0 ? 'no local code wears a rUv tool\'s name' : r.stderr.trim().split('\n').slice(-2).join(' ') };
    },
  },
  {
    id: 'did-the-jobs-actually-run',
    asked: '"Is the nightly actually running, or are you just telling me it is?"',
    why: 'launchd reports exit 0 for a job that NEVER RAN. Silence was being read as health.',
    run: () => {
      const r = sh('node', ['scripts/nightly-watchdog.mjs', '--json']);
      try {
        const { results } = JSON.parse(r.stdout);
        const bad = results.filter((x) => x.state !== 'OK');
        return { ok: bad.length === 0, detail: bad.length ? `${bad.length} job(s) unproven: ${bad.map((b) => `${b.label}=${b.state}`).join(', ')}` : `all ${results.length} jobs produced a fresh successful receipt` };
      } catch { return { ok: false, detail: 'watchdog produced no readable verdict — that is itself a failure' }; }
    },
  },
  {
    id: 'is-the-router-actually-routing',
    asked: '"Why am I still burning my Fable/Opus quota if the router exists?"',
    why: 'The router\'s entire lifetime output was 3 test pings and $0.018 — because the rule was advisory.',
    run: () => {
      const f = path.join(process.env.HOME, '.claude', 'metaharness', 'routing-receipts.jsonl');
      let rows = [];
      try { rows = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      const subagent = rows.filter((r) => r.source === 'claude-subagent');
      const saved = rows.reduce((s, r) => s + (r.saved || 0), 0);
      // The honest bar: routing must be VISIBLY happening, not merely possible.
      return {
        ok: subagent.length > 0,
        detail: subagent.length
          ? `${rows.length} routed task(s), ${subagent.length} subagent, est. $${saved.toFixed(2)} saved`
          : 'ZERO subagent dispatches routed — the router is decorative again',
      };
    },
  },
  {
    id: 'does-the-repo-ship-what-it-claims',
    asked: '"Are people actually getting the current version?"',
    why: 'Version drift across surfaces is a visible, credibility-destroying mistake.',
    run: () => {
      const r = sh('node', ['scripts/sync-version.mjs', '--check']);
      return { ok: r.status === 0, detail: (r.stdout + r.stderr).trim().split('\n').pop() };
    },
  },
  {
    id: 'does-the-package-ship-what-it-promises',
    asked: '"Are users actually GETTING the thing you told them shipped?"',
    why: 'v2.5.1 headline was "it uses rUv\'s real router" — and scripts/metaharness-router.mjs was NOT in the npm tarball. The dependency shipped; the code that calls it did not. Every gate was green and this adversary itself missed it, because it only ever checked whether the REPO was honest — never whether the ARTIFACT USERS RECEIVE contains what the README promises.',
    run: () => {
      // The npm `files` whitelist is opt-IN, so a NEW file is invisible to users unless someone
      // remembers to list it. A shipped script that relative-imports an UNSHIPPED one is broken for
      // every user while working perfectly in the repo — green CI, green tests, broken product.
      //
      // My FIRST version of this check derived the file list from bin/install.mjs and therefore did
      // NOT catch metaharness-router.mjs — the very bug it was written for. It reported ✅ on the
      // broken state. A check that passes on the bug it was written for is worse than no check, so:
      // follow the ACTUAL relative imports of every shipped file, transitively.
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      const shipped = new Set(pkg.files || []);
      const covered = (f) => shipped.has(f) || [...shipped].some((s) => s.endsWith('/') && f.startsWith(s));

      const seeds = [...shipped].filter((f) => f.endsWith('.mjs') && fs.existsSync(path.join(ROOT, f)));
      const missing = new Set();
      const seen = new Set();
      const walkImports = (rel) => {
        if (seen.has(rel)) return;
        seen.add(rel);
        let src;
        try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return; }
        for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
          const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
          if (!fs.existsSync(path.join(ROOT, dep))) continue; // not a real file (or an npm pkg) — skip
          if (!covered(dep)) missing.add(`${dep} (imported by ${rel})`);
          walkImports(dep);
        }
      };
      seeds.forEach(walkImports);

      return {
        ok: missing.size === 0,
        detail: missing.size
          ? `${missing.size} file(s) are IMPORTED BY SHIPPED CODE but are NOT in the npm package — the feature is broken for every user: ${[...missing].join('; ')}`
          : `every file imported by shipped code is itself shipped (${seen.size} files reachable from ${shipped.size} whitelist entries)`,
      };
    },
  },
  {
    id: 'does-the-engine-really-use-ruvs-router',
    asked: '"Is the router users actually RUN really rUv\'s, or still your hand-roll?"',
    why: 'v2.5 shipped with the wrapper written, tested, and CI-gated — while model-router-engine.mjs, the file that actually executes, never imported it. An honest artifact sitting next to a lying claim is still a lie.',
    run: () => {
      const engine = fs.readFileSync(path.join(ROOT, 'scripts/model-router-engine.mjs'), 'utf8');
      const wired = /metaharness-router\.mjs/.test(engine);
      const declares = /routedBy/.test(engine); // and it must SAY who decided, every time
      return {
        ok: wired && declares,
        detail: wired && declares
          ? 'the engine consults @metaharness/router first and reports routedBy on every decision'
          : `the ENGINE USERS RUN does not ${!wired ? 'import rUv\'s router' : 'declare who decided'} — the README\'s claim is false`,
      };
    },
  },
  {
    id: 'does-memory-actually-recall',
    asked: '"Is AgentDB actually storing AND recalling, or is it just small bits?"',
    why: 'I reported AgentDB as broken THREE times. It was never broken. I called `memory search` positionally when the CLI wants -q, then broke my own canary test with a bad grep, and reported MY test defects as PRODUCT defects. This check does the round trip so I can never again mistake my own sloppiness for a broken tool.',
    run: () => {
      // MEMORY_DB override exists so this check can be TESTED AGAINST A BROKEN STATE. A check nobody
      // has watched fail is not a check. (My first two attempts to test it were themselves broken —
      // which is the entire reason this check exists.)
      const db = process.env.MEMORY_DB || path.join(ROOT, '.swarm', 'memory.db');
      if (!fs.existsSync(db)) return { ok: false, detail: 'no memory.db — memory is not initialised' };

      // 1. Is it COLLECTING? (rows, embedded, current)
      const q = (sql) => (spawnSync('sqlite3', [db, sql], { encoding: 'utf8' }).stdout || '').trim();
      const total = Number(q('SELECT COUNT(*) FROM memory_entries;'));
      const embedded = Number(q("SELECT SUM(embedding IS NOT NULL AND LENGTH(embedding)>50) FROM memory_entries;"));
      const ageH = (Date.now() - Number(q('SELECT MAX(created_at) FROM memory_entries;'))) / 3600_000;

      // 2. Does it SURVIVE compaction / session end? (the whole point)
      const pre = Number(q("SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'session-precompact%';"));
      const end = Number(q("SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'session-sessionend%';"));

      // 3. Does it RECALL? A real semantic round-trip through the REAL CLI — not a DB peek.
      // `npx ruflo@latest` was here before (Rule 21 violation: it resolves ITS OWN cached copy,
      // masking drift from the global install — see ~/.claude/CLAUDE.md Rule 21) and, separately,
      // ran with no RUFLO_DAEMON_AUTOSTART guard — every `ruflo` invocation auto-starts a project
      // background daemon unless that is set (verified live: ~/.npm-global/lib/node_modules/ruflo/
      // node_modules/@claude-flow/cli/dist/src/services/daemon-autostart.js:85). This falsifier
      // must not itself leave a daemon running as a side effect of checking whether memory works.
      const rufloBin = resolveRuflo();
      const r = rufloBin
        ? spawnSync(rufloBin, ['memory', 'search', '-q', 'nightly job supervision heartbeat receipts'], {
          cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
        })
        : { error: new Error(RUFLO_MISSING), stdout: '' };
      const recalled = /Found\s+\d+\s+results/.test(r.stdout || '') && !/Found\s+0\s+results/.test(r.stdout || '');

      const problems = [];
      if (total < 10) problems.push(`only ${total} entries stored`);
      if (embedded / Math.max(total, 1) < 0.9) problems.push(`only ${embedded}/${total} entries are embedded — semantic recall will be partial`);
      if (ageH > 48) problems.push(`newest entry is ${ageH.toFixed(0)}h old — capture may have stopped`);
      if (pre === 0) problems.push('ZERO PreCompact snapshots — context will NOT survive a compaction');
      if (end === 0) problems.push('ZERO SessionEnd snapshots — context will NOT survive a session restart');
      if (!recalled) problems.push('semantic search returned NOTHING — recall is dead');

      return {
        ok: problems.length === 0,
        detail: problems.length
          ? problems.join('; ')
          : `${total} entries (${embedded} embedded), ${pre} PreCompact + ${end} SessionEnd snapshots, semantic recall returns results`,
      };
    },
  },
  {
    id: 'is-ci-actually-green',
    asked: '"Why am I getting failure notifications from GitHub?"',
    why: 'I declared green from LOCAL gates while CI had never passed — 25 straight failures.',
    run: () => {
      const r = sh('gh', ['run', 'list', '--workflow', 'ci.yml', '--limit', '1', '--json', 'conclusion,status']);
      try {
        const [run] = JSON.parse(r.stdout);
        if (!run) return { ok: false, detail: 'could not read CI status — do not claim green' };
        if (run.status !== 'completed') return { ok: false, detail: `CI is still ${run.status} — "pending" is not "green"` };
        return { ok: run.conclusion === 'success', detail: `latest ci run: ${run.conclusion}` };
      } catch { return { ok: false, detail: 'gh unavailable — CI state UNKNOWN, which is not the same as green' }; }
    },
  },
];

export function runAll(checks = CHECKS) {
  return checks.map((c) => ({ ...c, ...c.run() }));
}

function main() {
  console.log('falsify — the questions Stuart should not have to keep asking\n');
  const results = runAll();
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.asked}`);
    console.log(`   ${r.detail}`);
    if (!r.ok) console.log(`   why this check exists: ${r.why}`);
    console.log('');
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`${failed.length} claim(s) UNPROVEN. Do not report success. Fix or say plainly what is not verified.`);
    process.exit(1);
  }
  console.log('Every claim above is proven by something other than my own opinion.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
