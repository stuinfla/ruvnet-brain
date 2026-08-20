// tests/unit/selfcheck-battery.test.mjs — the post-install self-check, proven red-first.
//
// ── RED FIRST: THE VERBATIM STATE OF THE CODE BEFORE THIS SUITE EXISTED ─────────────────────────
// An independent grader scored this repo 40/100 because nothing mechanical ran after install on a
// stranger's machine and could fail. Both halves of that were measured on the worktree at
// origin/main (5464881) BEFORE any fix, and recorded here verbatim so the fix cannot be
// retro-justified:
//
//   RED 1 — `--doctor` cannot fail. A deliberately broken install (zero .rvf stores, no reader
//   deps, an empty forge-mcp-all.mjs):
//
//     $ RUVNET_BRAIN_KB=/tmp/wt-d8b-brokenkb node bin/install.mjs --doctor
//         ! no .rvf stores found in /tmp/wt-d8b-brokenkb — the brain may be incomplete
//         ! reader deps missing — every search WILL fail until fixed: cd … && npm i
//         ✓ search_ruvnet server present
//       ! Needs attention. Re-run the installer to fix the warnings above.
//     $ node bin/install.mjs --doctor >/dev/null 2>&1; echo $?
//     0                              ← "Needs attention" and a SUCCESS exit code, together
//
//   RED 2 — the flag did not exist at all:
//     $ grep -c "FLAG_HOOKS" bin/install.mjs
//     0
//
// The cause in both cases was CONSUMPTION, not detection: install.mjs's `verifyInstall()` and
// `smokeQuery()` both RETURN a verdict, and the installer called them as statements and discarded
// both (`verifyInstall(cacheDir); await smokeQuery(cacheDir);`). doctor() computed `allGreen` and
// printed it, then returned undefined. Facts were gathered and dropped on the floor.
//
// ── WHAT IS REUSED vs HAND-ROLLED (the elegance constraint) ─────────────────────────────────────
// Reused: scripts/hook-registry.mjs (merged census, shim-TABLE parsing, hook-contracts.json,
// lintM1 double-registration) and `ruflo metaharness mcp-scan` (rUv's shipped static MCP audit).
// Hand-rolled: ONLY the external process-group watchdog + four stdin regimes — rUv's scanners are
// static by their own documentation ("Pure-read, no dispatch"), so nothing upstream can observe a
// hook that hangs on a held-open pipe. That gap is the sole reason any new code exists here.
//
// ── PLATFORM ───────────────────────────────────────────────────────────────────────────────────
// windows-unit runs all of tests/unit and is blocking, so nothing here may be POSIX-bound. Every
// fixture hook body is a NODE script (bash can be absent on Windows), and the two genuinely
// POSIX-only measurements — process-group signalling and descendant survival — assert the HONEST
// `null` ("not measurable") on win32 rather than a fabricated pass.
//
// That reasoning was right and still landed six red assertions on windows-latest, because it only
// audited the fixtures and never the CHECKER: `fireHook` handed cmd.exe a command line it mangled,
// so no fixture ran at all. §1b below is that defect, its verbatim measurement, and the rule that
// closes it — proven on every platform, since the rule is a pure function of (command, platform).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  fireHook, assertContract, runBattery, resolveInstalledSurface, readInstalledRegistrations,
  checkCoexistence, runSecurityScan, selfCheck, formatVerdict, shellInvocation,
  STDIN_REGIMES, STDOUT_CAP_BYTES, ALLOWED_EXITS,
} from '../../scripts/selfcheck.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures/selfcheck-hooks');
const POSIX = process.platform !== 'win32';

/**
 * A fixture surface laid out exactly like a PACKED install (hooks/ and scripts/ hanging off the
 * root), NOT like the checkout. That layout difference is load-bearing: it is what a stranger's
 * machine looks like, and reading the checkout instead is the adjacent-door defect (ADR-055 F16).
 * The fixture shim below is a real dispatcher whose TABLE is written in the exact single-line
 * object-literal shape hook-registry's `shimTable()` parses — so the authority-parser under test
 * is the real one, not a stub.
 */
function makeSurface(entries, { contracts = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-surface-')));
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const f of fs.readdirSync(FIXTURES)) {
    if (f.endsWith('.mjs')) fs.copyFileSync(path.join(FIXTURES, f), path.join(root, 'scripts', f));
  }
  const table = entries.map((e) => `  '${e.id}': { file: '${e.file}', interpreter: 'node', mode: '${e.mode}', offBehavior: 'run' },`).join('\n');
  fs.writeFileSync(path.join(root, 'scripts', 'hook-shim.mjs'), `#!/usr/bin/env node
// Fixture dispatcher — same contract as plugin/scripts/hook-shim.mjs: typed table, no shell, exit
// code propagated for 'blocking' and forced to 0 for 'advisory'.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const TABLE = {
${table}
};
const entry = TABLE[process.argv[2]];
if (!entry) process.exit(0);
const here = path.dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [path.join(here, entry.file)], { stdio: 'inherit' });
process.exit(entry.mode === 'blocking' ? (r.status ?? 0) : 0);
`);
  const hooks = {};
  for (const e of entries) {
    hooks[e.event] ??= [];
    hooks[e.event].push({
      matcher: e.matcher ?? '*',
      hooks: [{
        type: 'command',
        command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ${e.id}`,
        ...(e.timeout === null ? {} : { timeout: e.timeout ?? 5 }),
      }],
    });
  }
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks }, null, 2));
  if (contracts) fs.writeFileSync(path.join(root, 'hooks', 'hook-contracts.json'), JSON.stringify(contracts, null, 2));
  return {
    ok: true, root, source: 'fixture',
    hooksFile: path.join(root, 'hooks', 'hooks.json'),
    shimFile: path.join(root, 'scripts', 'hook-shim.mjs'),
    alternates: [],
  };
}

const surfaces = [];
const surface = (entries, opts) => { const s = makeSurface(entries, opts); surfaces.push(s.root); return s; };
afterAll(() => { for (const r of surfaces) fs.rmSync(r, { recursive: true, force: true }); });

// ── §1 THE WATCHDOG: the one thing nothing upstream can do ──────────────────────────────────────
describe('external process-group watchdog — the hand-rolled remainder', () => {
  it('FIXTURE hang: a hook frozen on held-open stdin is CAUGHT and killed (in-process timer cannot)', { timeout: 60_000 }, async () => {
    const m = await fireHook({
      command: `node "${path.join(FIXTURES, 'hang.mjs')}"`,
      event: 'UserPromptSubmit', regime: 'held', timeoutSec: 1, cwd: os.tmpdir(), graceMs: 300,
    });
    // The fixture ARMS a setTimeout before its synchronous read precisely to prove the point: the
    // event loop is frozen, that timer never fires, and the process only dies because we killed it.
    expect(m.timedOut).toBe(true);
    expect(m.status).toBeNull();
    expect(m.elapsedMs).toBeGreaterThanOrEqual(1000);
  });

  it('the SAME hook under the other three regimes exits cleanly — the hang is regime-specific', { timeout: 60_000 }, async () => {
    for (const regime of ['valid', 'empty', 'garbage']) {
      const m = await fireHook({
        command: `node "${path.join(FIXTURES, 'hang.mjs')}"`,
        event: 'UserPromptSubmit', regime, timeoutSec: 5, cwd: os.tmpdir(), graceMs: 300,
      });
      expect(m.timedOut, `regime ${regime} should not hang`).toBe(false);
      expect(m.status).toBe(0);
    }
  });

  it('a hang produces a `hang` violation naming the declared timeout', { timeout: 60_000 }, async () => {
    const m = await fireHook({
      command: `node "${path.join(FIXTURES, 'hang.mjs')}"`,
      event: 'UserPromptSubmit', regime: 'held', timeoutSec: 1, cwd: os.tmpdir(), graceMs: 300,
    });
    const v = assertContract({ rec: { event: 'UserPromptSubmit', matcher: '*', handler: 'hang.mjs' }, measurement: m, mode: 'advisory', timeoutSec: 1 });
    expect(v.map((x) => x.kind)).toContain('hang');
    expect(v.find((x) => x.kind === 'hang').detail).toMatch(/declared timeout of 1s/);
  });

  it.skipIf(!POSIX)('FIXTURE orphan: a hook exiting 0 while leaking a descendant is caught', { timeout: 60_000 }, async () => {
    const m = await fireHook({
      command: `node "${path.join(FIXTURES, 'orphan.mjs')}"`,
      event: 'PostToolUse', regime: 'valid', timeoutSec: 5, cwd: os.tmpdir(), graceMs: 200,
    });
    expect(m.status).toBe(0); // the exit code says everything is fine…
    expect(m.survivors).toBe(true); // …and the process group says otherwise
    const v = assertContract({ rec: { event: 'PostToolUse', matcher: '*', handler: 'orphan.mjs' }, measurement: m, mode: 'advisory', timeoutSec: 5 });
    expect(v.map((x) => x.kind)).toContain('orphan');
  });

  it('descendant survival is reported as an honest null on win32, never a fabricated pass', { timeout: 60_000 }, async () => {
    const m = await fireHook({
      command: `node "${path.join(FIXTURES, 'healthy.mjs')}"`,
      event: 'PostToolUse', regime: 'valid', timeoutSec: 5, cwd: os.tmpdir(),
    });
    if (POSIX) expect(m.survivors).toBe(false);
    else expect(m.survivors).toBeNull(); // NOT MEASURABLE — and says so
    // Either way `null` must never be charged as a violation.
    const v = assertContract({ rec: { event: 'PostToolUse', matcher: '*', handler: 'healthy.mjs' }, measurement: { ...m, survivors: null }, mode: 'advisory', timeoutSec: 5 });
    expect(v.map((x) => x.kind)).not.toContain('orphan');
  });
});

// ── §1b THE SHELL INVOCATION — the Windows-only defect that made §1 unmeasurable ────────────────
//
// WHY THIS SECTION EXISTS, in the exact order it was learned. §1's three hang assertions and §2's
// flood + healthy assertions all went red on windows-latest (Actions run 30280922684) while macOS
// and linux were green. The verbatim measurement, from the HEALTHY fixture — the one that must
// produce ZERO violations — was eight violations, two per stdin regime:
//
//   { "kind": "exit-code",    "regime": "valid", "detail": "[valid] exited 1; a 'advisory' hook may only exit 0" }
//   { "kind": "stderr-trace", "regime": "valid", "detail": "[valid] printed what looks like a stack
//     trace on stderr: node:internal/modules/cjs/loader:1433\r" }
//   …the same pair again for empty, garbage and held.
//
// Read that carefully: `held` exited 1 as well. The regime whose entire purpose is to WEDGE the
// hook returned in milliseconds. Nothing ran — every fixture died in node's module loader before
// its first line, because the command string was mangled on its way through cmd.exe. That is a
// defect in the SHIPPED checker, not in the tests: on a Windows user's machine the same code path
// would have reported every hook this package ships as a contract violation and failed the
// post-install self-check with findings that were entirely an artifact of the checker.
//
// The rule is a pure function of (command, platform), which is the whole reason these assertions
// can run — and fail — on a mac. What they CANNOT do is prove the Windows end-to-end behaviour;
// only the windows-unit job can, and §1 is that proof.
//
// TWO SEPARATE DETAILS, and they were NOT equally guilty — the mutants below were run before this
// comment was written, and the first draft of it was wrong:
//   • `windowsVerbatimArguments: true` is the one that was actually breaking. It is what run
//     30280922684 measured, and dropping it alone reproduces the failure.
//   • The quote-wrap is not load-bearing for TODAY's registrations (they all begin `node …`, so
//     cmd's rule 2 never fires) but it is load-bearing the moment a command begins with a quoted
//     interpreter path — `"C:\Program Files\nodejs\node.exe" …` — which is one plugin-root change
//     away. It is also exactly what node's own normalizeSpawnArguments() does. The test below
//     proves the hazard is real rather than asserting a shape nobody can break.
describe('the shell invocation — how a hook command reaches a shell on each platform', () => {
  /**
   * cmd.exe's own documented quote handling, from `cmd /?` rule 2, which applies whenever /S is
   * given: "if the first character is a quote character then strip the leading character and
   * remove the last quote character on the command line, preserving any text after the last quote
   * character." Modelling it here is what makes the assertion about the RESULT — the command line
   * cmd actually executes — rather than about our own argv shape.
   */
  const cmdSlashS = (line) => {
    if (!line.startsWith('"')) return line; // rule 2 does not fire; whatever we wrote, cmd runs
    const last = line.lastIndexOf('"');
    return line.slice(1, last) + line.slice(last + 1);
  };

  const WIN_COMSPEC = { COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe' };
  // The real registered shape: an absolute Windows path, in quotes, with a space in it (Actions
  // runners use C:\Users\RUNNER~1\… but a user's home is routinely "C:\Users\Jane Smith\…").
  const REAL = 'node "C:\\Users\\Jane Smith\\.claude\\plugins\\cache\\ruvnet-brain\\ruvnet-brain\\3.9.92\\scripts\\hook-shim.mjs" ground-before-write';

  it('win32: cmd.exe gets /d /s /c, the command quote-wrapped, and NO libuv escaping', () => {
    const inv = shellInvocation(REAL, 'win32', WIN_COMSPEC);
    expect(inv.file).toBe('C:\\WINDOWS\\system32\\cmd.exe');
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(inv.args[3]).toBe(`"${REAL}"`);
    // THE ONE THAT WAS RED. Without this flag libuv escapes the argument MSVC-style —
    // `"node \"C:\Users\Jane Smith\…\hook-shim.mjs\" ground-before-write"` — cmd.exe passes the
    // backslashes through untouched, node.exe's argv parser turns each `\"` back into a literal
    // quote, and node goes looking for a file whose name starts with a quote character. That is
    // `node:internal/modules/cjs/loader:1433`, verbatim, in run 30280922684.
    expect(inv.windowsVerbatimArguments).toBe(true);
  });

  it('win32: the quote-wrap is what saves a command that BEGINS with a quoted interpreter path', () => {
    // This is the case that proves the wrap is not decoration. cmd's rule 2 only fires when the
    // command line starts with a quote — true for `"C:\Program Files\nodejs\node.exe" …`, and one
    // plugin-root change away from being true for us.
    const quotedInterp = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jane Smith\\rb\\scripts\\hook-shim.mjs" ground';
    // Unwrapped, cmd eats a quote that belonged to a PATH and hands node a mangled line…
    expect(cmdSlashS(quotedInterp), 'the hazard must be real or the wrap proves nothing').not.toBe(quotedInterp);
    // …wrapped, the outer quotes are what rule 2 consumes, and the command survives byte-for-byte.
    const inv = shellInvocation(quotedInterp, 'win32', WIN_COMSPEC);
    expect(cmdSlashS(inv.args[3])).toBe(quotedInterp);
  });

  it('win32: every command the REAL shipped hooks.json registers is invoked the fixed way', () => {
    // Not a fixture string — the actual registrations, so a future hook whose command form breaks
    // Windows is caught here rather than by a stranger. The plugin root is substituted with a
    // Windows path containing a space, because that is the case that failed.
    const regs = readInstalledRegistrations(path.join(REPO_ROOT, 'plugin', 'hooks', 'hooks.json'));
    expect(regs.length).toBeGreaterThan(0);
    for (const r of regs) {
      const command = r.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', 'C:\\Users\\Jane Smith\\.claude\\plugins\\cache\\rb');
      const inv = shellInvocation(command, 'win32', WIN_COMSPEC);
      expect(inv.windowsVerbatimArguments, `libuv would escape: ${command}`).toBe(true);
      expect(inv.args[3], `not quote-wrapped: ${command}`).toBe(`"${command}"`);
      // And what cmd actually executes is the registration, unchanged.
      expect(cmdSlashS(inv.args[3]), `mangled on win32: ${command}`).toBe(command);
    }
  });

  it('a COMSPEC that is not cmd takes the POSIX-shaped branch, never cmd syntax', () => {
    const inv = shellInvocation(REAL, 'win32', { COMSPEC: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(inv.args).toEqual(['-c', REAL]);
    expect(inv.windowsVerbatimArguments).toBe(false); // bash gets no cmd quote-wrapping
  });

  it('posix: /bin/sh -c with the command untouched, and no Windows escaping to opt out of', () => {
    const inv = shellInvocation(REAL, 'linux');
    expect(inv.file).toBe('/bin/sh');
    expect(inv.args).toEqual(['-c', REAL]); // execve takes argv as an array — nothing to quote
    expect(inv.windowsVerbatimArguments).toBe(false);
  });
});

// ── §2 CONTRACT ASSERTIONS, each proven by its own fixture ──────────────────────────────────────
describe('contract assertions — each fixture makes exactly its own assertion red', () => {
  it('FIXTURE advisory-fail: an advisory hook exiting 1 violates its exit contract', { timeout: 60_000 }, async () => {
    const s = surface([{ id: 'advfail', file: 'advisory-fail.mjs', event: 'UserPromptSubmit', mode: 'advisory' }]);
    // NOTE the shim forces advisory exits to 0, so the registration is declared BLOCKING here to let
    // the body's real code through — this is the "advisory registration that can return non-zero"
    // shape, which is what the assertion is about.
    const s2 = surface([{ id: 'advfail', file: 'advisory-fail.mjs', event: 'UserPromptSubmit', mode: 'blocking' }]);
    const r = await runBattery({ surface: s2, regimes: ['valid'], home: os.tmpdir() });
    // Declared blocking, exit 1 is legal → no exit-code violation…
    expect(r.violations.filter((v) => v.kind === 'exit-code')).toHaveLength(0);
    // …but judged against the ADVISORY contract, exit 1 is a violation.
    const m = r.results[0].measurement;
    expect(m.status).toBe(1);
    const v = assertContract({ rec: { event: 'UserPromptSubmit', matcher: '*', handler: 'advisory-fail.mjs' }, measurement: m, mode: 'advisory', timeoutSec: 5 });
    expect(v.map((x) => x.kind)).toContain('exit-code');
    expect(ALLOWED_EXITS.advisory).toEqual([0]);
    expect(s.ok).toBe(true);
  });

  it('FIXTURE flood: >4KB of stdout is a violation (it lands in the context window)', { timeout: 60_000 }, async () => {
    const s = surface([{ id: 'flood', file: 'flood.mjs', event: 'SessionStart', mode: 'advisory' }]);
    const r = await runBattery({ surface: s, regimes: ['valid'], home: os.tmpdir() });
    const flood = r.violations.filter((v) => v.kind === 'stdout-flood');
    expect(flood).toHaveLength(1);
    expect(r.results[0].measurement.stdoutBytes).toBeGreaterThan(STDOUT_CAP_BYTES);
    expect(flood[0].detail).toMatch(/the cap is 4096/);
  });

  it('a registration with NO timeout is a violation on its own (host default = 600s on a stranger)', { timeout: 60_000 }, async () => {
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'SessionStart', mode: 'advisory', timeout: null }]);
    const r = await runBattery({ surface: s, regimes: ['valid'], home: os.tmpdir() });
    expect(r.violations.map((v) => v.kind)).toContain('no-timeout');
  });

  it('a registration declared by NEITHER the shim table nor hook-contracts.json is a violation', { timeout: 60_000 }, async () => {
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'SessionStart', mode: 'advisory' }]);
    // Break the declaration the way drift really happens: the registration stays, the table entry
    // that declared it goes away. This is why the contract is PARSED, never hand-copied.
    fs.writeFileSync(path.join(s.root, 'scripts', 'hook-shim.mjs'), 'const TABLE = {};\nprocess.exit(0);\n');
    const r = await runBattery({ surface: s, regimes: ['valid'], home: os.tmpdir() });
    expect(r.violations.map((v) => v.kind)).toContain('undeclared-mode');
  });

  // Explicit timeout, same reasoning vitest.config.mjs already states for the other subprocess
  // suites: this fires real processes, the assertion is about BEHAVIOUR rather than speed, and a
  // loaded machine must not turn a passing contract into a red build. ONE registration × four
  // regimes is the full regime matrix; a second entry would only re-prove node's startup cost while
  // adding load that tips neighbouring subprocess suites over their own thresholds.
  it('HEALTHY surface: zero violations across all four stdin regimes, exit 0', { timeout: 60_000 }, async () => {
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'UserPromptSubmit', mode: 'advisory' }]);
    const r = await runBattery({ surface: s, regimes: STDIN_REGIMES, home: os.tmpdir() });
    expect(r.violations, JSON.stringify(r.violations, null, 2)).toHaveLength(0);
    expect(r.results).toHaveLength(STDIN_REGIMES.length); // every regime exercised
    expect(r.results.map((x) => x.measurement.regime).sort()).toEqual([...STDIN_REGIMES].sort());
  });

  it('a BLOCKING registration exiting 0 is equally clean', { timeout: 60_000 }, async () => {
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'SessionStart', mode: 'blocking' }]);
    const r = await runBattery({ surface: s, regimes: ['valid'], home: os.tmpdir() });
    expect(r.violations).toHaveLength(0);
  });
});

// ── §3 THE CONTRACT COMES FROM THE PARSED AUTHORITIES, NEVER A LITERAL ──────────────────────────
describe('contract source — shim TABLE + hook-contracts.json, parsed from the INSTALLED tree', () => {
  it('reads mode from the packed-layout shim table (scripts/, not plugin/scripts/)', async () => {
    const { shimTable } = await import('../../scripts/hook-registry.mjs');
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'SessionStart', mode: 'blocking' }]);
    const t = shimTable(s.root); // packed layout — no `plugin/` prefix anywhere
    expect(t.healthy).toBeTruthy();
    expect(t.healthy.mode).toBe('blocking');
    expect(t.healthy.offBehavior).toBe('run');
  });

  it('still parses the CHECKOUT layout — the real repo shim, real ids, no hand-copied list', async () => {
    const { shimTable } = await import('../../scripts/hook-registry.mjs');
    const t = shimTable(REPO_ROOT);
    // Assert the SHAPE and the source of truth, not a frozen roster: a hardcoded id list here would
    // be exactly the hand-copied list this design refuses.
    expect(Object.keys(t).length).toBeGreaterThan(5);
    for (const [id, e] of Object.entries(t)) {
      expect(['advisory', 'blocking'], `${id} mode`).toContain(e.mode);
      expect(['silence', 'run', 'partial'], `${id} offBehavior`).toContain(e.offBehavior);
    }
  });

  it('falls back to hook-contracts.json for registrations outside the shim table', async () => {
    const { loadContracts } = await import('../../scripts/hook-registry.mjs');
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'SessionStart', mode: 'advisory' }], {
      contracts: { contracts: [{ id: 'x', layer: 'plugin', event: 'SessionStart', commandIncludes: 'healthy', mode: 'advisory', offBehavior: 'run' }] },
    });
    const c = loadContracts(s.root); // packed layout: hooks/hook-contracts.json
    expect(c.contracts).toHaveLength(1);
    expect(c.contracts[0].mode).toBe('advisory');
  });
});

// ── §4 THE REAL SHIPPED SURFACE — the real shim, the real hooks.json ────────────────────────────
describe('the real shipped plugin surface', () => {
  it('every registration in the real hooks.json resolves to a declared mode + explicit timeout', async () => {
    const { shimTable, shimIdIn, loadContracts, contractMatches } = await import('../../scripts/hook-registry.mjs');
    const root = path.join(REPO_ROOT, 'plugin');
    const regs = readInstalledRegistrations(path.join(root, 'hooks', 'hooks.json'));
    const table = shimTable(root);
    const { contracts } = loadContracts(root);
    expect(regs.length).toBeGreaterThan(0);
    for (const r of regs) {
      const id = shimIdIn(r.command);
      const mode = (id && table[id]?.mode) ?? contracts.find((c) => contractMatches(c, { layer: 'plugin', event: r.event, matcher: r.matcher, command: r.command }))?.mode ?? null;
      expect(mode, `no declared mode for ${r.event} ${r.matcher} :: ${r.command}`).not.toBeNull();
      expect(typeof r.timeout, `no explicit timeout for ${r.event} ${r.matcher}`).toBe('number');
      expect(r.timeout, `timeout ${r.timeout} > 60 is a milliseconds value in a seconds field`).toBeLessThanOrEqual(60);
    }
  });

  it('resolveInstalledSurface prefers the packed install and names which copy it chose', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-home-')));
    const packed = path.join(home, '.claude/plugins/cache/ruvnet-brain/ruvnet-brain/9.9.9');
    fs.mkdirSync(path.join(packed, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(packed, 'hooks/hooks.json'), '{"hooks":{}}');
    const s = resolveInstalledSurface({ home, repo: REPO_ROOT });
    expect(s.ok).toBe(true);
    expect(s.source).toBe('installed:9.9.9'); // NOT the checkout, even though a checkout was offered
    expect(s.alternates).toContain('checkout');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports honestly when NO plugin is installed — never a silent pass', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-empty-')));
    const s = resolveInstalledSurface({ home });
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/no installed ruvnet-brain plugin payload/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ── §5 COEXISTENCE + DOUBLE REGISTRATION (reused from hook-registry) ────────────────────────────
describe('coexistence — enumerate the user\'s hooks, never execute them', () => {
  it('enumerates foreign registrations and never runs them', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-coex-')));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const canary = path.join(home, 'FOREIGN-HOOK-EXECUTED');
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: `node -e "require('fs').writeFileSync('${canary.replace(/\\/g, '\\\\')}','x')"`, timeout: 5 }] }],
      },
    }));
    const c = await checkCoexistence({ home, repo: REPO_ROOT });
    expect(c.foreign.length).toBeGreaterThan(0);
    expect(c.foreign.some((f) => f.layer === 'user')).toBe(true);
    // THE POINT: a foreign hook is data to be reported, never a process to be run.
    expect(fs.existsSync(canary)).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Dream Cycle 2026-08-20 (cross-host-conformance): `ours` omitted the 'codex' layer, so
  // checkCoexistence() silently undercounted `ourCount` and dropped every codex-hooks.json
  // registration from both buckets the moment hook-registry.mjs's mesh learned to read it — caught
  // by an independent critique, not by this file, before it shipped. Pinned here with an exact
  // count (not `toBeGreaterThan(0)`) specifically because a vacuous-but-truthy assertion is what
  // let the original gap through unnoticed.
  it('classifies codex-hooks.json registrations as OURS, not foreign or invisible', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-coex-codex-')));
    const declaredIn = (rel) => {
      const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      return Object.values(doc.hooks)
        .reduce((total, groups) => total + groups.reduce((n, g) => n + (g.hooks?.length ?? 0), 0), 0);
    };
    // EXACT, not >= : an >= assertion here is the vacuous shape that let the original gap through —
    // plugin/hooks/hooks.json alone already declares more registrations than codex-hooks.json does,
    // so a >= bound stays green whether or not codex's 16 are actually counted.
    const expectedOurCount = declaredIn('plugin/hooks/hooks.json') + declaredIn('plugin/hooks/codex-hooks.json');
    const c = await checkCoexistence({ home, repo: REPO_ROOT });
    expect(c.ourCount, 'ourCount must include codex-hooks.json\'s registrations').toBe(expectedOurCount);
    expect(c.foreign.some((f) => f.layer === 'codex'), 'codex misclassified as foreign').toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('FIXTURE double-registration: one handler from two code roots is detected (reuses lintM1)', async () => {
    const { lintM1 } = await import('../../scripts/hook-registry.mjs');
    // Synthetic records — the invariant is a pure function, which is exactly why it can be proven
    // to FAIL rather than merely asserted to exist (ADR-055 §7.15).
    const rec = (layer, codeRoot) => ({
      layer, inMesh: true, event: 'PreToolUse', matcher: '^Task$', handler: 'route-dispatch.sh',
      codeRoot, tools: ['Task'], effectiveMode: 'blocking', locator: `${layer}:1`,
    });
    const one = lintM1([rec('plugin', 'spine'), rec('plugin', 'spine')]);
    expect(one, 'same handler, ONE root = one behavior, not a finding').toHaveLength(0);
    const two = lintM1([rec('plugin', 'spine'), rec('user', 'marketplace-clone')]);
    expect(two).toHaveLength(1);
    expect(two[0].roots).toEqual(['spine', 'marketplace-clone']);
    expect(two[0].blocking).toBe(true);
  });

  it('detects another hook reading a path inside our write root', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-collide-')));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const ours = path.join(home, '.cache', 'ruvnet-brain');
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: `cat ${path.join(ours, 'active.json')}`, timeout: 5 }] }] },
    }));
    const c = await checkCoexistence({ home, repo: REPO_ROOT });
    expect(c.collisions.length).toBeGreaterThan(0);
    expect(c.collisions[0].root).toBe(ours);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ── §6 SECURITY: rUv's scanner, or an honest absence — NEVER a fabricated verdict ───────────────
describe('security — reuse ruflo metaharness, degrade honestly', () => {
  // THE ASSERTION THAT MATTERS IS OURS, NOT ruflo's: when the scanner is absent we must say so and
  // score NOTHING. Driven deterministically with an empty PATH so it holds on any machine, in CI,
  // and on a windows runner — a test whose outcome depends on whether the developer happens to have
  // ruflo installed proves nothing on the machine that matters.
  //
  // The live spawn is opt-in (RUVNET_SELFCHECK_LIVE=1) for a measured reason, not squeamishness:
  // `ruflo` starts background daemons, and spawning it inside the parallel unit suite starved four
  // neighbouring subprocess-heavy suites into 10s timeouts. Measured both ways — those four files
  // pass together without this one and fail with it. A test that breaks its neighbours is worse
  // than no test, and the live path is exercised by `--doctor --hooks` and by the CLI instead.
  it('when ruflo is ABSENT it says so plainly and never fabricates a verdict', () => {
    const r = runSecurityScan({ cwd: REPO_ROOT, env: { ...process.env, PATH: path.join(os.tmpdir(), 'definitely-no-ruflo-here') } });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/ruflo not found/);
    expect(r.reason).not.toMatch(/\b(clean|pass(ed)?|secure|safe)\b/i); // an absence must never read as a pass
    expect(r['mcp-scan']).toBeUndefined(); // no invented result to accompany the absence
  });

  it.skipIf(!process.env.RUVNET_SELFCHECK_LIVE)('LIVE: reports ruflo\'s real exit codes verbatim', { timeout: 120_000 }, () => {
    const r = runSecurityScan({ cwd: REPO_ROOT });
    expect(r.available).toBe(true);
    // mcp-scan documents exit 1 as an INTENTIONAL alert exit (findings at/above --fail-on), so a
    // non-zero code here is DATA, not a crash — and must never silently become a pass.
    expect([0, 1, 2, null]).toContain(r['mcp-scan'].exitCode ?? null);
    expect(r['threat-model']).toBeTruthy();
  });
});

// ── §7 THE VERDICT + EXIT CODE — the half install.mjs was missing ───────────────────────────────
describe('verdict — exit codes are the point', () => {
  it('FIXTURE zero stores: a broken install state produces a NON-ZERO exit code', async () => {
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'SessionStart', mode: 'advisory' }]);
    const home = path.dirname(s.root);
    const r = await selfCheck({
      home, regimes: ['valid'], security: false,
      installState: { repos: 0, reader: true, mcp: true },
    });
    expect(r.exitCode).toBe(1); // ← RED 1, now impossible
    expect(r.violations.map((v) => v.kind)).toContain('no-stores');
    expect(formatVerdict(r)).toMatch(/Self-check FAILED/);
  });

  it('each broken install dimension is charged independently', async () => {
    const base = { repos: 3, reader: true, mcp: true };
    const cases = [
      [{ ...base, repos: 0 }, 'no-stores'],
      [{ ...base, reader: false }, 'no-reader'],
      [{ ...base, mcp: false }, 'no-mcp'],
    ];
    for (const [installState, kind] of cases) {
      const r = await selfCheck({ home: os.tmpdir(), regimes: ['valid'], security: false, installState });
      expect(r.violations.map((v) => v.kind), `expected ${kind}`).toContain(kind);
      expect(r.exitCode).toBe(1);
    }
  });

  it('a healthy install + healthy hooks = exit 0 and ONE calm confirming line, no nagging', async () => {
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'SessionStart', mode: 'advisory' }]);
    const r = await selfCheck({
      home: os.tmpdir(), regimes: STDIN_REGIMES, security: false,
      installState: { repos: 12, reader: true, mcp: true },
    });
    // The fixture surface is not discoverable from os.tmpdir() as a HOME, so the battery reports no
    // plugin — assert on the install-state half here and on the battery half in §2's healthy case.
    const installViolations = r.violations.filter((v) => ['no-stores', 'no-reader', 'no-mcp'].includes(v.kind));
    expect(installViolations).toHaveLength(0);
    const clean = { ...r, violations: [] };
    const out = formatVerdict(clean);
    expect(out).toMatch(/Self-check passed/);
    expect(out.split('\n').filter((l) => /✓|✗|•/.test(l))).toHaveLength(1); // exactly one verdict line
    expect(s.ok).toBe(true);
  });

  it('the battery result feeds the verdict: a hanging hook alone makes exit non-zero', { timeout: 60_000 }, async () => {
    const s = surface([{ id: 'hang', file: 'hang.mjs', event: 'UserPromptSubmit', mode: 'advisory', timeout: 1 }]);
    const r = await runBattery({ surface: s, regimes: ['held'], home: os.tmpdir() });
    expect(r.violations.map((v) => v.kind)).toContain('hang');
    const verdict = { violations: r.violations, lines: [] };
    expect(verdict.violations.length ? 1 : 0).toBe(1);
  });
});

// ── §8 MUTATION PROOF — break each assertion, watch its fixture go GREEN, restore ───────────────
//
// A test that cannot fail on broken code is not a test. Each mutant below DISABLES exactly one
// assertion in scripts/selfcheck.mjs by rewriting the SOURCE (not the inputs), imports the mutated
// module, and re-judges the SAME recorded measurement. If the violation disappears, that assertion
// is what was catching the fixture — proven, not assumed. If a mutant still reports the violation,
// the assertion was dead code and the test fails. The temp module is deleted afterwards; the real
// file is never written to.
describe('mutation proof — every assertion is load-bearing', () => {
  const SRC = path.join(REPO_ROOT, 'scripts/selfcheck.mjs');
  let source;
  const mutantDirs = []; // every temp dir a mutant was written to, asserted gone at the end
  beforeAll(() => { source = fs.readFileSync(SRC, 'utf8'); });

  /**
   * Write the mutated copy to a TEMP DIR, never into scripts/.
   *
   * The first version of this helper wrote mutants next to the original so its relative import of
   * hook-registry.mjs would resolve — and that broke two OTHER test files, because vitest runs test
   * files in parallel and several of them enumerate scripts/*.mjs. A transient file in a directory
   * other suites glob is a race, and a test that corrupts its neighbours is worse than no test.
   * Instead the mutant's ONE relative resolution is rewritten to an absolute path, which makes it
   * self-contained wherever it lives.
   */
  async function mutant(find, replace) {
    expect(source.includes(find), `mutation anchor not found: ${find.slice(0, 60)}`).toBe(true);
    const ANCHOR = 'const here = path.dirname(fileURLToPath(import.meta.url));';
    expect(source.includes(ANCHOR), 'loadRegistry() resolution anchor moved').toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-mutant-'));
    mutantDirs.push(dir);
    const file = path.join(dir, 'mutant.mjs');
    fs.writeFileSync(file, source
      .replace(find, replace)
      .replace(ANCHOR, `const here = ${JSON.stringify(path.join(REPO_ROOT, 'scripts'))};`));
    return { mod: await import(pathToFileURL(file).href), file, dir };
  }
  const cleanup = (fileOrDir) => {
    try { fs.rmSync(path.dirname(fileOrDir), { recursive: true, force: true }); } catch { /* already gone */ }
  };

  const REC = { event: 'UserPromptSubmit', matcher: '*', handler: 'x' };

  it('MUTANT: disable the hang check → the hanging fixture goes GREEN (proves it was load-bearing)', async () => {
    const m = { regime: 'held', timedOut: true, status: null, elapsedMs: 1200, stdoutBytes: 0, stdout: '', stderr: '', survivors: false };
    expect(assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 1 }).map((v) => v.kind)).toContain('hang');
    const { mod, file } = await mutant("if (measurement.timedOut) {", "if (false) {");
    try {
      expect(mod.assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 1 }).map((v) => v.kind)).not.toContain('hang');
    } finally { cleanup(file); }
  });

  it('MUTANT: disable the exit-code check → the advisory-exit-1 fixture goes GREEN', async () => {
    const m = { regime: 'valid', timedOut: false, status: 1, elapsedMs: 20, stdoutBytes: 10, stdout: '', stderr: '', survivors: false };
    expect(assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).toContain('exit-code');
    const { mod, file } = await mutant("if (!measurement.timedOut && mode) {", "if (false) {");
    try {
      expect(mod.assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).not.toContain('exit-code');
    } finally { cleanup(file); }
  });

  it('MUTANT: disable the stdout cap → the flood fixture goes GREEN', async () => {
    const m = { regime: 'valid', timedOut: false, status: 0, elapsedMs: 20, stdoutBytes: 16384, stdout: '', stderr: '', survivors: false };
    expect(assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).toContain('stdout-flood');
    const { mod, file } = await mutant("if (measurement.stdoutBytes > STDOUT_CAP_BYTES) {", "if (false) {");
    try {
      expect(mod.assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).not.toContain('stdout-flood');
    } finally { cleanup(file); }
  });

  it('MUTANT: disable the orphan check → the leaking fixture goes GREEN', async () => {
    const m = { regime: 'valid', timedOut: false, status: 0, elapsedMs: 20, stdoutBytes: 10, stdout: '', stderr: '', survivors: true };
    expect(assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).toContain('orphan');
    const { mod, file } = await mutant("if (measurement.survivors === true) {", "if (false) {");
    try {
      expect(mod.assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).not.toContain('orphan');
    } finally { cleanup(file); }
  });

  it('MUTANT: disable the latency-margin check → a hook at 95% of its timeout goes GREEN', async () => {
    const m = { regime: 'valid', timedOut: false, status: 0, elapsedMs: 4750, stdoutBytes: 10, stdout: '', stderr: 'SESSION_TRACE stage=spine-block elapsed_ms=4600\n', survivors: false };
    expect(assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).toContain('slow');
    expect(assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).find((v) => v.kind === 'slow').detail)
      .toContain('SESSION_TRACE stage=spine-block elapsed_ms=4600');
    const { mod, file } = await mutant("} else if (measurement.elapsedMs > budgetMs * TIMEOUT_MARGIN) {", "} else if (false) {");
    try {
      expect(mod.assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).not.toContain('slow');
    } finally { cleanup(file); }
  });

  it('MUTANT: disable the stderr-trace check → a stack trace on a stranger\'s screen goes GREEN', async () => {
    const m = { regime: 'valid', timedOut: false, status: 0, elapsedMs: 20, stdoutBytes: 10, stdout: '', stderr: 'TypeError: x is not a function\n    at f (/a/b.mjs:1:1)\n', survivors: false };
    expect(assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).toContain('stderr-trace');
    const { mod, file } = await mutant("if (mode === 'advisory' && /^\\s*(?:Error|TypeError|ReferenceError|SyntaxError)\\b|^\\s+at .+:\\d+:\\d+/m.test(measurement.stderr)) {", "if (false) {");
    try {
      expect(mod.assertContract({ rec: REC, measurement: m, mode: 'advisory', timeoutSec: 5 }).map((v) => v.kind)).not.toContain('stderr-trace');
    } finally { cleanup(file); }
  });

  it('MUTANT: disable the no-timeout check → an untimed registration goes GREEN', { timeout: 60_000 }, async () => {
    const s = surface([{ id: 'healthy', file: 'healthy.mjs', event: 'SessionStart', mode: 'advisory', timeout: null }]);
    expect((await runBattery({ surface: s, regimes: ['valid'], home: os.tmpdir() })).violations.map((v) => v.kind)).toContain('no-timeout');
    const { mod, file } = await mutant("if (typeof r.timeout !== 'number') {", "if (false) {");
    try {
      expect((await mod.runBattery({ surface: s, regimes: ['valid'], home: os.tmpdir() })).violations.map((v) => v.kind)).not.toContain('no-timeout');
    } finally { cleanup(file); }
  });

  it('every mutant is restored: none survive, and scripts/ was never written to', () => {
    // Both halves matter. The first proves the mutants were cleaned up; the second proves the
    // technique never touched the real source tree in the first place — "restore" is only
    // trustworthy if there was nothing to restore.
    expect(mutantDirs.length, 'expected mutants to have been created').toBeGreaterThan(0);
    for (const d of mutantDirs) expect(fs.existsSync(d), `mutant dir survived: ${d}`).toBe(false);
    const strays = fs.readdirSync(path.join(REPO_ROOT, 'scripts')).filter((f) => f.includes('mutant'));
    expect(strays).toEqual([]);
    expect(fs.readFileSync(SRC, 'utf8')).toBe(source); // the real file is byte-identical
  });
});
