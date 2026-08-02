#!/usr/bin/env node
// scripts/release-vector.mjs — the release gate as a CRITICAL-INVARIANT VECTOR, never an average.
//
// ADR-058 §"The release gate", DDD-0013 aggregate CandidateVerdict. Eight named invariants, each
// PASS | FAIL | UNKNOWN **on the exact candidate SHA**. The verdict is the vector MINIMUM.
//
// WHY A VECTOR AND NOT A SCORE — the failure this file exists to make impossible:
// on 2026-07-27 this product scored 18/100 on a stranger's machine while README.md advertised
// "L1–L4 behavioral harness — all pass" on the same commit. Both statements were derived from real
// checks. A composite absorbed the 18: average enough green cells and the worst one disappears.
// So there is deliberately NO averaging operation on this aggregate. Not "we don't call it" — no
// method computes one, and tests/unit/release-vector.test.mjs asserts the module exposes none.
// If a future reader wants a percentage, they have to add the capability first, and the mutation
// test will make them look at this comment while they do it.
//
// THE OTHER LAW — UNKNOWN IS NEVER PASS. `behavioral-l1-l4.mjs --levels L5` once selected zero
// checks and printed `OVERALL: PASS`, exit 0: a run that measured nothing certified itself. Here a
// detector that cannot tell returns UNKNOWN, UNKNOWN ranks BELOW pass, and the minimum carries it
// all the way to the verdict. Silence is not consent.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Ordered worst -> best. The verdict is the minimum, so the ORDER of this array IS the policy.
export const RANK = ['FAIL', 'UNKNOWN', 'PASS'];

/** The vector minimum. Deliberately the only aggregation in this module. */
export function verdictOf(results) {
  if (!results.length) return 'UNKNOWN'; // an empty vector measured nothing — see the L5 incident
  return results.reduce((worst, r) => (RANK.indexOf(r.state) < RANK.indexOf(worst) ? r.state : worst), 'PASS');
}

export function candidateLineage(root = ROOT) {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  return {
    sha: git(['rev-parse', 'HEAD']) || 'UNKNOWN-SHA',
    tree: git(['rev-parse', 'HEAD^{tree}']) || 'UNKNOWN-TREE',
    dirty: Boolean(git(['status', '--porcelain'])),
  };
}

export function verdictWithLineage(results, lineage) {
  return lineage?.dirty ? 'FAIL' : verdictOf(results);
}

/** Run a command; UNKNOWN (not FAIL) when the runner itself could not execute. */
function runAt(root, cmd, args, timeoutMs = 120_000, env = process.env) {
  // npm installs `npm.cmd` / `npx.cmd` command shims on Windows. Direct spawn does not resolve the
  // extension through PATHEXT, and .cmd files require cmd.exe, so a healthy detector otherwise
  // reads UNKNOWN with ENOENT. Invoke the command interpreter explicitly rather than `shell:true`;
  // the latter concatenates arguments into a shell string and is deprecated for that reason.
  const windowsCommandShim = process.platform === 'win32' && /^(?:npm|npx)$/i.test(cmd);
  const executable = windowsCommandShim ? (process.env.ComSpec || 'cmd.exe') : cmd;
  const spawnArgs = windowsCommandShim ? ['/d', '/c', `${cmd}.cmd`, ...args] : args;
  const r = spawnSync(executable, spawnArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env,
  });
  if (r.error || r.status === null) return { state: 'UNKNOWN', why: `runner did not complete: ${r.error?.code || 'killed/timeout'}` };
  return { state: r.status === 0 ? 'PASS' : 'FAIL', why: r.status === 0 ? 'exit 0' : `exit ${r.status}`, out: r.stdout };
}

/** An explicit detector root makes destructive mutants isolated and concurrency-safe. */
function detectorScope({ root = ROOT, runCommand = null } = {}) {
  return {
    root,
    exists: (relative) => fs.existsSync(path.join(root, relative)),
    read: (relative) => {
      try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch { return null; }
    },
    run: runCommand || ((cmd, args, timeoutMs, env) => runAt(root, cmd, args, timeoutMs, env)),
  };
}

// ─── the eight invariants ────────────────────────────────────────────────────────────────────
// Each names the dimension it gates and the dated failure it descends from. A detector with no
// incident behind it is a checkbox; every one of these was bought with a real defect.

export const INVARIANTS = [
  {
    name: 'INSTALL-FAILS-LOUD',
    dimension: 'D8',
    incident: 'verifyInstall() warned and continued; a stranger scored 18/100 on an install that could not fail',
    detect(options) {
      const { exists, read } = detectorScope(options);
      if (!exists('.github/workflows/stranger-matrix.yml')) return { state: 'FAIL', why: 'no stranger matrix' };
      const inst = read('bin/install.mjs');
      if (inst === null) return { state: 'UNKNOWN', why: 'bin/install.mjs unreadable' };
      // The substance, not the ceremony: the selfcheck verdict must reach the PROCESS EXIT CODE.
      // A workflow that runs a check whose result evaporates is the 40/100 defect with extra YAML.
      return /process\.exitCode\s*=\s*selfcheck/.test(inst)
        ? { state: 'PASS', why: 'matrix present and selfcheck verdict reaches process.exitCode' }
        : { state: 'FAIL', why: 'selfcheck verdict never reaches process.exitCode' };
    },
  },
  {
    name: 'INTERFACE-CORPUS',
    dimension: 'D7',
    incident: 'shell-parsing defects recurred across issues #12/#13/#41/#44, then three stale ADRs reached main because document currency was outside every release gate',
    detect(options) {
      const { exists, run } = detectorScope(options);
      if (!exists('tests/regression/interface-gate-corpus.test.mjs')) return { state: 'FAIL', why: 'no incident corpus' };
      if (!exists('scripts/doc-currency.mjs')) return { state: 'FAIL', why: 'no document-currency gate' };
      const corpus = run('npx', ['vitest', 'run', 'tests/regression/interface-gate-corpus.test.mjs', '--reporter=dot']);
      if (corpus.state !== 'PASS') return { ...corpus, why: `interface corpus: ${corpus.why}` };
      const currency = run('node', ['scripts/doc-currency.mjs', '--check'], 180_000);
      return currency.state === 'PASS'
        ? { state: 'PASS', why: 'interface incident corpus and document currency both exit 0' }
        : { ...currency, why: `document currency: ${currency.why}` };
    },
  },
  {
    name: 'LATENCY-DECISION-LANE',
    dimension: 'D6',
    incident: 'latency breaches only warned; timing regressions did not block shipping',
    detect(options) {
      const { exists, run } = detectorScope(options);
      return exists('scripts/qe/card-lane-gate.mjs')
        ? run('node', ['scripts/qe/card-lane-gate.mjs'])
        : { state: 'FAIL', why: 'no decision-lane gate' };
    },
  },
  {
    name: 'COEXIST-BYTE-EQUAL',
    dimension: 'D5',
    incident: 'the merged-registry lint found 63 findings across 42 registrations; the prior suite saw 15',
    detect(options) {
      const { exists, run } = detectorScope(options);
      return exists('tests/mesh/coexistence.test.mjs')
        ? run('npx', ['vitest', 'run', 'tests/mesh', '--reporter=dot'])
        : { state: 'FAIL', why: 'no coexistence suite' };
    },
  },
  {
    name: 'LEARNING-REPLAY',
    dimension: 'D4',
    incident: 'L4 asserted the hook\'s own prose contained words — it proved the brain SPOKE, never that anything LISTENED',
    async detect(options = {}) {
      // DELEGATED to scripts/learning-replay.mjs's own checkArtifact(), not reimplemented here.
      //
      // This detector originally required `artifact.sha === HEAD`, which is WRONG in a way worth
      // recording: committing the artifact necessarily changes HEAD, so a strict-equality rule can
      // never be satisfied by its own commit and would read UNKNOWN forever. The trap's own rule
      // binds to SUBSTANCE instead — `git diff <artifactSha>..HEAD -- LOAD_BEARING` — so a verdict
      // stays valid until code that could actually change the outcome moves. Same ADR-055 design
      // law as everywhere else: bind to the thing that can invalidate the claim, not to a
      // convenient token that merely correlates with it. Two gates disagreeing about what "current"
      // means is how a product ends up with two truths.
      let mod;
      try { mod = await import(new URL('./learning-replay.mjs', import.meta.url).href); }
      catch { return { state: 'UNKNOWN', why: 'counterfactual replay harness absent' }; }
      let r;
      try {
        r = options.checkReplay ? options.checkReplay() : mod.checkPortfolio({ repo: options.root || ROOT });
      } catch (e) { return { state: 'UNKNOWN', why: `replay portfolio unreadable: ${e.message}` }; }
      // `.status` is the field checkArtifact() actually returns — read, not assumed. Reaching for
      // `.verdict` (the name used INSIDE the nested artifact) silently yielded undefined and made a
      // real PASS read UNKNOWN: the delegation "worked" while reporting the opposite of the truth.
      const v = String(r?.status ?? r?.verdict ?? 'UNKNOWN').toUpperCase();
      // INCONCLUSIVE never rounds up (DDD-0013 invariant 6): a trap whose CONTROL arm also produced
      // the token measured nothing about the brain, and measuring nothing is not passing.
      if (v === 'INCONCLUSIVE' || v === 'SKIP') return { state: 'UNKNOWN', why: r?.why || 'trap invalid — control also succeeded' };
      if (v !== 'PASS' && v !== 'FAIL') return { state: 'UNKNOWN', why: r?.why || `unrecognised verdict ${v}` };
      return { state: v, why: r?.why || v };
    },
  },
  {
    name: 'SIGNAL-WATCH-FIRES',
    dimension: 'D3',
    incident: 'the OWNER had to report that CI was red — every local surface stayed calm',
    detect(options) {
      const { exists, read, run } = detectorScope(options);
      if (!exists('scripts/signal-watch.mjs')) return { state: 'FAIL', why: 'no signal watcher' };
      const raw = read('plugin/hooks/hooks.json');
      if (raw === null) return { state: 'UNKNOWN', why: 'plugin/hooks/hooks.json unreadable' };
      let doc;
      try { doc = JSON.parse(raw); } catch { return { state: 'UNKNOWN', why: 'hooks.json unparseable' }; }
      // Built-but-unregistered is the F5 class: the capability exists on disk and never fires. So
      // check the REGISTRATION — the door it actually walks through.
      //
      // AND CHECK IT BY PARSING, NOT BY SUBSTRING. The first version of this detector asked
      // `raw.includes('signal-watch')`, and its own mutant renamed the handler to
      // `signal-watch-DISABLED-BY-MUTANT` — which still CONTAINS 'signal-watch', so the gate stayed
      // green on a registration that could no longer fire. A substring is not a registration; it
      // would equally match a mention inside a comment, a `_note` field, or a disabled entry.
      const commands = Object.values(doc.hooks || {})
        .flatMap((groups) => (Array.isArray(groups) ? groups : []))
        .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
        .map((h) => String(h?.command || ''));
      // the shim dispatches by a bare handler id, so match the id as a WHOLE argument token
      const fires = commands.some((c) => /(^|[\s"'/])signal-watch($|[\s"'|;])/.test(c));
      if (!fires) {
        return { state: 'FAIL', why: 'watcher exists but is not registered as a dispatchable handler — it will never fire' };
      }

      // Registration is necessary but not sufficient. The first release gate stopped here and
      // certified a named handler without proving that a real red verdict reached the maintainer.
      // Execute the whole shipped path: push debt → poller → red surface → dedupe → green close →
      // silence. The paired mutation suite deletes the consumer, breaks dedupe, converts UNKNOWN
      // to green, and blinds the observer; every mutant must remain killed for D3 to pass.
      const behavior = run('npx', [
        'vitest', 'run',
        'tests/unit/signal-lifecycle.test.mjs',
        'tests/mutation/signal-watch-mutation.test.mjs',
        '--reporter=dot',
      ]);
      return behavior.state === 'PASS'
        ? {
            state: 'PASS',
            why: `registered in ${commands.length} shipped registration(s); executable red→surface→green→silence lifecycle and 4 mutants pass`,
          }
        : {
            state: behavior.state,
            why: `signal-watch behavioral lifecycle or mutant proof failed (${behavior.why})`,
          };
    },
  },
  {
    name: 'SCENARIOS-CURRENT',
    dimension: 'D2',
    incident: 'ADR-053 specified a mental-model scenario list; it was simply absent',
    detect(options) {
      const { exists, run } = detectorScope(options);
      return exists('tests/experience/report.mjs')
        ? run('node', ['tests/experience/report.mjs'])
        : { state: 'FAIL', why: 'no scenario report' };
    },
  },
  {
    name: 'GUARANTEE-RUNS',
    dimension: 'D1',
    incident: 'the product guarantee skipped on every CI runner; REQUIRE_BRAIN=1 was set nowhere in the repo',
    detect(options) {
      const { read, run } = detectorScope(options);
      const ci = read('.github/workflows/ci.yml');
      if (ci === null) return { state: 'UNKNOWN', why: 'ci.yml unreadable' };
      if (!/REQUIRE_BRAIN/.test(ci)) {
        return { state: 'FAIL', why: 'REQUIRE_BRAIN set nowhere; the guarantee skips' };
      }
      const live = run(
        'npx',
        [
          'vitest', 'run',
          '--config', 'tests/qe/gpt56/vitest.config.mjs',
          'tests/qe/gpt56/live-brain-search.test.mjs',
          '--reporter=dot',
        ],
        90_000,
        { ...process.env, REQUIRE_BRAIN: '1', RUVNET_QE_LIVE: '1' },
      );
      return live.state === 'PASS'
        ? { state: 'PASS', why: 'REQUIRE_BRAIN is wired and the real search_ruvnet MCP returns cited source under concurrency' }
        : { ...live, why: `live search_ruvnet guarantee: ${live.why}` };
    },
  },
];

export function headSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'UNKNOWN-SHA';
}

/** Strings a non-PASS verdict mechanically bans from release surfaces (ADR-058). */
export const BANNED_WHEN_DEGRADED = ['healthy', 'proven', 'all pass'];

export async function evaluate(invariants = INVARIANTS, options = {}) {
  const lineage = candidateLineage(options.root || ROOT);
  const sha = lineage.sha;
  const results = [];
  for (const inv of invariants) {
    const r = await inv.detect(options);
    results.push({ name: inv.name, dimension: inv.dimension, state: r.state, why: r.why, sha });
  }
  return { sha, lineage, results, verdict: verdictWithLineage(results, lineage) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { sha, lineage, results, verdict } = await evaluate();
  const json = process.argv.includes('--json');
  if (json) {
    console.log(JSON.stringify({ sha, lineage, verdict, results }, null, 2));
  } else {
    const mark = { PASS: '✓', FAIL: '✗', UNKNOWN: '?' };
    console.log(`\n  release vector @ ${sha.slice(0, 7)}\n`);
    for (const r of results) {
      console.log(`  ${mark[r.state]} ${r.state.padEnd(7)} ${r.dimension.padEnd(3)} ${r.name.padEnd(22)} ${r.why}`);
    }
    console.log(`  lineage: tree ${lineage.tree.slice(0, 12)} · ${lineage.dirty ? 'DIRTY (release-blocking)' : 'clean'}`);
    console.log(`\n  verdict: ${verdict}   (vector MINIMUM over ${results.length} invariants — never an average)`);
    if (verdict !== 'PASS') {
      console.log(`  release metadata must read DEGRADED; these strings are banned: ${BANNED_WHEN_DEGRADED.map((s) => `"${s}"`).join(', ')}\n`);
    } else {
      console.log('');
    }
  }
  process.exitCode = verdict === 'PASS' ? 0 : 1;
}
