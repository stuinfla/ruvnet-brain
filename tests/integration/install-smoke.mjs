// tests/integration/install-smoke.mjs — drive-to-98 item #6: the REAL installer smoke test.
//
// bin/install.mjs is the highest-risk untested path — a stranger's very first contact with the
// brain runs through it, and until now nothing exercised it. These tests run the ACTUAL installer
// in its three safe, offline, non-mutating modes and assert on real observed behavior (exit code +
// stdout), not on mocks:
//   1. `--help`   — prints usage/flags, exits 0.
//   2. `--doctor` — runs the read-only health check, prints the banner + a diagnostic line, and
//                   NEVER crashes. We pin RUVNET_BRAIN_KB to an empty temp dir so the check takes
//                   the deterministic "brain not found here" path on EVERY machine (a fresh CI
//                   runner has no brain; a dev box does — pinning makes both behave identically and
//                   skips the multi-minute model-warm smoke query). We do NOT assert a passing
//                   health state — only that doctor RAN, produced a diagnostic, and stayed
//                   read-only (the pinned dir must be untouched afterwards).
//   3. freshness flags — `--update` against an empty KB dir must fail LOUD (non-zero exit + the
//                   re-run-installer message); `--enable-nightly` / `--disable-nightly` must write/
//                   remove a valid LaunchAgent plist under an overridden HOME (macOS only; the
//                   RUVNET_BRAIN_TEST=1 guard skips launchctl so the real gui domain is never touched).
//   4. signing wiring — asserts `node --check bin/install.mjs` parses, and that SIGNING_PUBKEY_PEM
//                   and the verifyBundle definition are both still inlined (guards against the
//                   Ed25519 bundle-signature gate being accidentally deleted).
//   5. the nightly offer — a default install ends by recommending nightly auto-updates and asking,
//                   DEFAULTING TO YES. parseNightlyAnswer holds the default-yes contract (tested
//                   in-process via RUVNET_BRAIN_IMPORT_ONLY=1, which skips the installer's main);
//                   offerNightly's decision matrix (suppressed under RUVNET_BRAIN_TEST=1 and
//                   --no-nightly-prompt; non-TTY recommends instead of prompting; already-enabled
//                   and non-macOS paths) is exercised via a spawned driver, never a real install.
//
// Robust by construction: spawnSync with an explicit timeout, zero network dependence, node:test +
// node:assert (runnable via `node --test tests/integration/install-smoke.mjs`). Any failed
// assertion makes the process exit non-zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');

// Run the real installer. Bounded timeout, inherited env (+ overrides), never touches the network
// in the modes exercised here.
function runInstaller(args, extraEnv = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...extraEnv },
  });
}

// ── "did not crash" and "reported success" are DIFFERENT contracts ────────────────────────────────
// Conflating them is what broke this suite. The D8 post-install check made doctor() return a real
// verdict (bin/install.mjs: `process.exitCode = await doctor()`), so a deliberately-broken fixture
// install now correctly exits 1 — which is the entire point of that change: the installer can
// finally FAIL. Three tests below build broken fixtures ON PURPOSE (an empty brain dir; a dir
// holding nothing but a forge-mcp-all.mjs stub) and then asserted exit 0, so they were pinning the
// OLD bug and would have gone red the moment the installer started telling the truth. They did.
//
//   assertNoCrash — the installer reached a DELIBERATE verdict: no spawn error, no signal (timeout),
//                   no leaked stack trace, and an exit code it chose (0 or 1) rather than a crash.
//   assertClean   — assertNoCrash PLUS "and it reported success". For modes where exit 0 is the
//                   contract (--help).
//   assertVerdict — pins the exact verdict in BOTH directions, so neither a doctor() reverted to
//                   always-0 nor one hardwired to always-1 can pass this file.
const DELIBERATE_EXITS = new Set([0, 1]);

function assertNoCrash(r, label) {
  assert.equal(r.error, undefined, `${label}: spawn failed — ${r.error && r.error.message}`);
  assert.equal(r.signal, null, `${label}: process was killed by signal ${r.signal} (timeout?)`);
  assert.ok(
    DELIBERATE_EXITS.has(r.status),
    `${label}: expected a deliberate verdict (0 or 1), got ${r.status} — that is a crash, not a report\nstderr:\n${r.stderr || ''}`,
  );
  // A verdict is allowed to be 1. An unhandled throw is never allowed, in either direction.
  assert.doesNotMatch(
    r.stderr || '',
    /\n\s+at\s+\S+.*:\d+:\d+/,
    `${label}: leaked an unhandled-exception stack — a verdict must be reported, not thrown`,
  );
}

function assertClean(r, label) {
  assertNoCrash(r, label);
  assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\nstderr:\n${r.stderr || ''}`);
}

function assertVerdict(r, expected, label) {
  assertNoCrash(r, label);
  assert.equal(
    r.status,
    expected,
    `${label}: expected doctor verdict ${expected}, got ${r.status}\nstderr:\n${r.stderr || ''}`,
  );
}

test('the installer file exists at bin/install.mjs', () => {
  assert.ok(fs.existsSync(INSTALLER), `installer missing at ${INSTALLER}`);
});

test('the install smoke warms the same model cache used by the stable MCP runtime', () => {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(
    source,
    /spawnSync\('node',\s*\['forge-ask-all\.mjs'[\s\S]*?env:\s*\{\s*\.\.\.process\.env,\s*KB_MODEL_CACHE:\s*resolveRuntimeModelCache\(\)\s*\}/,
    'smokeQuery must pass the runtime model cache to the real reader process',
  );
});

test('`--help` exits 0 and prints usage + flags', () => {
  const r = runInstaller(['--help']);
  assertClean(r, '--help');
  const out = r.stdout || '';
  assert.match(out, /RuvNet Brain installer/, 'help must identify the tool');
  assert.match(out, /Usage:/, 'help must print a Usage section');
  assert.match(out, /--doctor/, 'help must list the --doctor flag');
});

test('`--doctor` runs a read-only health check, prints a diagnostic, and never crashes', () => {
  // Pin the brain dir to an EMPTY temp dir → deterministic "brain not found here" path on any
  // machine (and no multi-minute model warm-up). Read-only: the dir must stay untouched.
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-doctor-'));
  try {
    const r = runInstaller(['--doctor'], { RUVNET_BRAIN_KB: brainDir });
    // An EMPTY brain dir is a broken install, and since D8 doctor says so with exit 1. It must
    // still reach that verdict cleanly — report, never throw.
    assertVerdict(r, 1, '--doctor (empty brain dir = not installed)');
    const out = r.stdout || '';
    assert.match(out, /RuvNet Brain/, 'doctor must print the banner identifying the tool');
    assert.match(out, /brain dir:/, 'doctor must print a diagnostic check line (the brain dir it inspected)');
    // A read-only diagnostic must not write anything into the brain dir it was pointed at.
    assert.deepEqual(fs.readdirSync(brainDir), [], 'doctor must be non-mutating (pinned brain dir stayed empty)');
  } finally {
    fs.rmSync(brainDir, { recursive: true, force: true });
  }
});

// THE OTHER DIRECTION — without this, the file only ever pins "doctor exits 1", and a doctor()
// hardwired to `return 1` would pass every assertion above. gatherInstallState() reads four things
// off disk (a *.rvf store, @xenova/transformers, @ruvector, forge-mcp-all.mjs), so a HEALTHY brain
// dir is buildable from files alone. Deliberately no forge-ask-all.mjs: its absence is what keeps
// smokeQuery() from warming a real local model, so this stays a fast, offline, hermetic test.
test('`--doctor` on a COMPLETE brain dir returns the healthy verdict (exit 0) — the verdict is real, not hardwired', () => {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-doctor-healthy-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-doctor-healthy-cache-'));
  try {
    fs.writeFileSync(path.join(brainDir, 'forge-mcp-all.mjs'), '// stub for install-smoke — never executed\n');
    // Current release bundles contain canonical *.big.rvf stores only. The older checker excluded
    // that suffix and falsely failed a real 60-store v3.9.131 install as "zero stores".
    fs.writeFileSync(path.join(brainDir, 'ruvector.big.rvf'), 'not a real store — presence is what gatherInstallState counts\n');
    const xen = path.join(brainDir, 'node_modules', '@xenova', 'transformers');
    fs.mkdirSync(xen, { recursive: true });
    fs.writeFileSync(path.join(xen, 'package.json'), '{"name":"@xenova/transformers","version":"0.0.0-fixture"}\n');
    fs.mkdirSync(path.join(brainDir, 'node_modules', '@ruvector'), { recursive: true });

    const r = runInstaller(['--doctor'], { RUVNET_BRAIN_KB: brainDir, XDG_CACHE_HOME: cacheDir });
    assertVerdict(r, 0, '--doctor (complete brain dir = healthy)');
    const out = r.stdout || '';
    assert.match(out, /1 RuvNet repos? indexed/, `doctor must report the store it found; got:\n${out}`);
    assert.match(out, /local reader installed/, 'doctor must confirm the reader deps it verified');
    assert.doesNotMatch(out, /✗ FAILING/, 'a complete install must not print the FAILING verdict line');
  } finally {
    fs.rmSync(brainDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ── ADR-058 §D8: the PERSISTED grounding verdict gates `--doctor` even when everything else is
// healthy. bin/install.mjs is the only writer (right after its own real install run) — a plain
// `--doctor` invocation never re-writes this file, it only reads it back. Same complete-brain-dir
// fixture as the healthy test above (repos/reader/mcp all present); the ONLY variable across these
// three cases is what install-state.json says, proving the gate is real and not a side effect of
// some other signal.
function completeBrainFixture() {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-doctor-grounding-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-doctor-grounding-cache-'));
  fs.writeFileSync(path.join(brainDir, 'forge-mcp-all.mjs'), '// stub for install-smoke — never executed\n');
  fs.writeFileSync(path.join(brainDir, 'ruvector.rvf'), 'not a real store — presence is what gatherInstallState counts\n');
  const xen = path.join(brainDir, 'node_modules', '@xenova', 'transformers');
  fs.mkdirSync(xen, { recursive: true });
  fs.writeFileSync(path.join(xen, 'package.json'), '{"name":"@xenova/transformers","version":"0.0.0-fixture"}\n');
  fs.mkdirSync(path.join(brainDir, 'node_modules', '@ruvector'), { recursive: true });
  return { brainDir, cacheDir };
}

test('`--doctor` FAILS (exit 1) on an otherwise-COMPLETE brain dir when the persisted verdict says grounding is unproven', () => {
  const { brainDir, cacheDir } = completeBrainFixture();
  try {
    const stateDir = path.join(cacheDir, 'ruvnet-brain');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'install-state.json'), JSON.stringify({ grounding: 'unproven', reason: 'no-answer' }));
    const r = runInstaller(['--doctor'], { RUVNET_BRAIN_KB: brainDir, XDG_CACHE_HOME: cacheDir });
    assertVerdict(r, 1, '--doctor (complete brain dir, but grounding persisted as unproven)');
    assert.match(r.stdout || '', /Grounding UNPROVEN/, 'doctor must name the persisted verdict as the reason it failed');
  } finally {
    fs.rmSync(brainDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('`--doctor` PASSES (exit 0) on the same complete brain dir when the persisted verdict says grounding is proven', () => {
  const { brainDir, cacheDir } = completeBrainFixture();
  try {
    const stateDir = path.join(cacheDir, 'ruvnet-brain');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'install-state.json'), JSON.stringify({ grounding: 'proven', clearedBy: 'search_ruvnet' }));
    const r = runInstaller(['--doctor'], { RUVNET_BRAIN_KB: brainDir, XDG_CACHE_HOME: cacheDir });
    assertVerdict(r, 0, '--doctor (complete brain dir, grounding persisted as proven)');
    assert.doesNotMatch(r.stdout || '', /Grounding UNPROVEN/, 'a proven verdict must never print the unproven line');
  } finally {
    fs.rmSync(brainDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('`--doctor` PASSES (exit 0) on the same complete brain dir when NO verdict was ever recorded (unknown ≠ fail)', () => {
  // No install-state.json written at all under this cacheDir — the pre-ADR-058 state of the world,
  // and the common case for any machine that installed before this feature shipped.
  const { brainDir, cacheDir } = completeBrainFixture();
  try {
    const r = runInstaller(['--doctor'], { RUVNET_BRAIN_KB: brainDir, XDG_CACHE_HOME: cacheDir });
    assertVerdict(r, 0, '--doctor (complete brain dir, no persisted verdict at all)');
    assert.doesNotMatch(r.stdout || '', /Grounding UNPROVEN/, 'absence of a verdict must never read as a failure');
  } finally {
    fs.rmSync(brainDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('`--help` lists the freshness flags: --update, --enable-nightly, --disable-nightly', () => {
  const r = runInstaller(['--help']);
  assertClean(r, '--help (freshness flags)');
  const out = r.stdout || '';
  for (const flag of ['--update', '--enable-nightly', '--disable-nightly', '--no-nightly-prompt']) {
    assert.ok(out.includes(flag), `help must list ${flag}`);
  }
});

test('`--update` against an empty KB dir fails LOUD with the re-run-installer message', () => {
  // An empty dir has no forge-update.mjs — the honest failure is a clear "re-run the installer",
  // a non-zero exit, and NO invented fallback behavior.
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-update-'));
  try {
    const r = runInstaller(['--update'], { RUVNET_BRAIN_KB: kbDir });
    assert.equal(r.error, undefined, `--update: spawn failed — ${r.error && r.error.message}`);
    assert.notEqual(r.status, 0, '--update on an empty KB dir must exit non-zero (fail loud)');
    const all = `${r.stdout || ''}${r.stderr || ''}`;
    assert.match(all, /forge-update\.mjs/, 'must name the missing self-updater');
    assert.match(all, /npx ruvnet-brain/, 'must tell the user the fix: re-run the installer');
    assert.deepEqual(fs.readdirSync(kbDir), [], '--update must not mutate the KB dir on failure');
  } finally {
    fs.rmSync(kbDir, { recursive: true, force: true });
  }
});

// `--doctor`'s meterSummaryLine() (ADR-0011 token_cost_efficiency) reads
// <cwd>/.ruvnet-brain/token-ledger.jsonl — a real file, never mocked. runInstaller() above pins
// cwd to ROOT (the repo itself), which this test must NOT do (writing into the real repo's
// .ruvnet-brain/ would pollute it) — so this spawns directly with an overridden cwd instead.
test('`--doctor` reports the real token-meter summary line, computed from a real ledger file in cwd', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-meter-'));
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-meter-kb-'));
  try {
    // meterSummaryLine() only prints once doctor() gets past its "brain not found here" early
    // return, which needs forge-mcp-all.mjs present — but NOT forge-ask-all.mjs, or smokeQuery()
    // would try to warm a real local model. This stub is the minimal fixture past that gate.
    fs.writeFileSync(path.join(brainDir, 'forge-mcp-all.mjs'), '// stub for install-smoke — never executed\n');
    fs.mkdirSync(path.join(projectDir, '.ruvnet-brain'));
    const ledger = path.join(projectDir, '.ruvnet-brain', 'token-ledger.jsonl');
    const now = new Date().toISOString();
    const lines = [
      { ts: now, source: 'hook', class: 'session-start', bytes: 1000 },
      { ts: now, source: 'hook', class: 'ground-ruvnet', bytes: 2000 },
      'not json, must be skipped without crashing',
      { source: 'hook', class: 'no-timestamp', bytes: 99999 }, // no `ts` — must be excluded, not counted
    ];
    fs.writeFileSync(ledger, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');

    // The canonical machine-wide ledger (XDG_CACHE_HOME/ruvnet-brain, issue #36) shadows the
    // legacy per-cwd fixture whenever any hook has ever fired on this machine — pin the canonical
    // location to a fresh temp dir so this test reads exactly the world it built.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-meter-cache-'));
    const r = spawnSync(process.execPath, [INSTALLER, '--doctor'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, RUVNET_BRAIN_KB: brainDir, XDG_CACHE_HOME: cacheDir },
    });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    // The fixture is a stub-only brain dir (no .rvf stores, no reader deps) — a genuinely
    // incomplete install, so the verdict is 1. The meter line is still expected to print: this
    // test is about the meter's arithmetic, not the install's health.
    assertVerdict(r, 1, '--doctor (meter; stub-only brain dir = incomplete install)');
    const out = r.stdout || '';
    assert.match(out, /meter: 2 injections measured here yesterday\+today — 3000 bytes/, `doctor must report the real ledger totals; got:\n${out}`);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(brainDir, { recursive: true, force: true });
  }
});

test('`--doctor`\'s meter line degrades honestly when no ledger exists yet in cwd', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-meter-empty-'));
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-meter-empty-kb-'));
  try {
    fs.writeFileSync(path.join(brainDir, 'forge-mcp-all.mjs'), '// stub for install-smoke — never executed\n');
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-meter-empty-cache-'));
    const r = spawnSync(process.execPath, [INSTALLER, '--doctor'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, RUVNET_BRAIN_KB: brainDir, XDG_CACHE_HOME: cacheDir },
    });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    assertVerdict(r, 1, '--doctor (no ledger; stub-only brain dir = incomplete install)');
    assert.match(r.stdout || '', /meter: no data yet/, 'must say plainly that nothing has been measured, not error or stay silent');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(brainDir, { recursive: true, force: true });
  }
});

// The LaunchAgent path only exists on macOS (--enable-nightly prints a cron recipe elsewhere).
// HOME is pointed at a temp dir so the REAL ~/Library/LaunchAgents is never touched, and
// RUVNET_BRAIN_TEST=1 makes the installer skip launchctl entirely (we assert the guard fired).
test(
  '`--enable-nightly` writes a valid per-user plist under a test HOME, and `--disable-nightly` removes it',
  { skip: process.platform !== 'darwin' ? 'macOS-only: exercises the LaunchAgent plist path' : false },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-home-'));
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-kb-'));
    const realPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
    const realPlistBefore = fs.existsSync(realPlist);
    try {
      // --enable-nightly refuses to schedule a job with nothing to run — give it a stub updater.
      fs.writeFileSync(path.join(kbDir, 'forge-update.mjs'), '// stub for install-smoke — never executed\n');
      const env = { HOME: home, RUVNET_BRAIN_KB: kbDir, RUVNET_BRAIN_TEST: '1' };

      const r = runInstaller(['--enable-nightly'], env);
      assertClean(r, '--enable-nightly');
      // The guard must have fired: launchctl skipped, and the installer must SAY so.
      assert.match(r.stdout || '', /RUVNET_BRAIN_TEST=1/, 'test-mode guard must announce that launchctl was skipped');

      const plist = path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
      assert.ok(fs.existsSync(plist), `plist not written at ${plist} (HOME override not honored?)`);
      const xml = fs.readFileSync(plist, 'utf8');
      assert.ok(xml.includes(kbDir), "plist must be templated to THIS user's kb dir");
      assert.match(xml, /<key>Hour<\/key>\s*<integer>3<\/integer>/, 'must schedule hour 3');
      assert.match(xml, /<key>Minute<\/key>\s*<integer>47<\/integer>/, 'must schedule minute 47 (03:47)');
      assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/, 'must not run at load');
      // ProgramArguments is a proper argv ARRAY (one <string> per arg — the correct launchd form),
      // so the two tokens are adjacent elements, never one space-joined line.
      assert.match(xml, /<string>forge-update\.mjs<\/string>\s*<string>--apply<\/string>/, 'must run the bundled self-updater with --apply');
      // plutil is macOS's own plist validator — structural proof launchd could load this file.
      const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8', timeout: 15000 });
      assert.equal(lint.status, 0, `plutil -lint rejected the plist:\n${lint.stdout || ''}${lint.stderr || ''}`);

      // --disable-nightly removes it…
      const d1 = runInstaller(['--disable-nightly'], env);
      assertClean(d1, '--disable-nightly (first run)');
      assert.ok(!fs.existsSync(plist), '--disable-nightly must delete the plist');
      // …and is idempotent + friendly when there's nothing to remove.
      const d2 = runInstaller(['--disable-nightly'], env);
      assertClean(d2, '--disable-nightly (second run, idempotent)');
      assert.match(d2.stdout || '', /already off/i, 'second disable must stay friendly, not error');

      // The REAL LaunchAgents dir must be exactly as it was — the whole point of the HOME override.
      assert.equal(fs.existsSync(realPlist), realPlistBefore, 'the real ~/Library/LaunchAgents must be untouched');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  },
);

// ── the nightly-updates offer (item 5 in the header) ─────────────────────────────────────────────
// The default-yes PARSING is tested in-process: RUVNET_BRAIN_IMPORT_ONLY=1 makes install.mjs skip
// its main, so importing it is side-effect free. The env var is deleted immediately after import —
// runInstaller() spreads process.env, and leaking IMPORT_ONLY into spawned installers would silently
// no-op every other test in this file.
test('nightly prompt parsing: ENTER and y/yes accept (the default); ONLY an explicit n/no declines', async () => {
  let mod;
  try {
    process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
    mod = await import(pathToFileURL(INSTALLER).href);
  } finally {
    delete process.env.RUVNET_BRAIN_IMPORT_ONLY;
  }
  assert.equal(typeof mod.parseNightlyAnswer, 'function', 'install.mjs must export parseNightlyAnswer');
  assert.equal(
    mod.resolveRuntimeModelCache({ RUVNET_BRAIN_HOME: '/tmp/brain-home' }, '/ignored-home'),
    path.join('/tmp/brain-home', 'models'),
    'installer warm-up must target the stable MCP runtime cache',
  );
  assert.equal(
    mod.resolveRuntimeModelCache({ KB_MODEL_CACHE: '/explicit-models' }, '/ignored-home'),
    '/explicit-models',
    'an explicit KB_MODEL_CACHE must win for both warm-up and runtime',
  );
  // Default YES: empty string (plain ENTER), whitespace, y/yes in any case — and anything that
  // is not an explicit no ("only explicit n/no declines" is the contract).
  for (const yes of ['', '   ', 'y', 'Y', 'yes', 'YES', 'Yes', ' y ', 'sure']) {
    assert.equal(mod.parseNightlyAnswer(yes), true, `${JSON.stringify(yes)} must mean yes`);
  }
  for (const no of ['n', 'N', 'no', 'NO', 'No', ' n ']) {
    assert.equal(mod.parseNightlyAnswer(no), false, `${JSON.stringify(no)} must mean no`);
  }
});

// Runs offerNightly() alone in a child process (import-only guard + a tiny driver), with stdin a
// closed pipe (never a TTY) and HOME/RUVNET_BRAIN_KB pointed at temp dirs — so no scenario can
// prompt, hang, download, or touch the real ~/Library/LaunchAgents.
function runOfferNightly(extraEnv = {}, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-driver-'));
  const driver = path.join(dir, 'driver.mjs');
  fs.writeFileSync(driver, [
    "process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';",
    'const mod = await import(process.env.INSTALLER_URL);',
    'const r = await mod.offerNightly();',
    "console.log('OFFER_RESULT=' + r);",
    '',
  ].join('\n'));
  try {
    return spawnSync(process.execPath, [driver, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      input: '', // stdin is a pipe at EOF: not a TTY, and a regression that prompts ends instead of hanging
      // RUVNET_BRAIN_TEST is neutralized by default: the suite is documented to run under
      // RUVNET_BRAIN_TEST=1, and letting it leak in would suppress every scenario below. The
      // suppression test turns it back on EXPLICITLY via extraEnv.
      env: { ...process.env, RUVNET_BRAIN_TEST: '', INSTALLER_URL: pathToFileURL(INSTALLER).href, ...extraEnv },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the nightly offer is suppressed under RUVNET_BRAIN_TEST=1 — no prompt, no recommendation, no plist', () => {
  const r = runOfferNightly({ RUVNET_BRAIN_TEST: '1' });
  assert.equal(r.status, 0, `driver failed:\n${r.stderr || ''}`);
  assert.match(r.stdout || '', /OFFER_RESULT=suppressed/, 'RUVNET_BRAIN_TEST=1 must suppress the offer');
  assert.doesNotMatch(r.stdout || '', /Enable nightly auto-updates\?/, 'must not print the prompt');
  assert.doesNotMatch(r.stdout || '', /--enable-nightly/, 'must not even print the recommendation');
});

test('`--no-nightly-prompt` suppresses the nightly offer', () => {
  const r = runOfferNightly({}, ['--no-nightly-prompt']);
  assert.equal(r.status, 0, `driver failed:\n${r.stderr || ''}`);
  assert.match(r.stdout || '', /OFFER_RESULT=suppressed/, '--no-nightly-prompt must suppress the offer');
  assert.doesNotMatch(r.stdout || '', /Enable nightly auto-updates\?/, 'must not print the prompt');
});

test(
  'non-TTY on macOS: no prompt — prints the clear recommendation + the --enable-nightly command, writes nothing',
  { skip: process.platform !== 'darwin' ? 'macOS-only: exercises the LaunchAgent branch' : false },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-home-'));
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-kb-'));
    try {
      // The offer requires the bundle's self-updater to exist (it refuses to sell a job that can't run).
      fs.writeFileSync(path.join(kbDir, 'forge-update.mjs'), '// stub for install-smoke — never executed\n');
      const r = runOfferNightly({ HOME: home, RUVNET_BRAIN_KB: kbDir });
      assert.equal(r.status, 0, `driver failed:\n${r.stderr || ''}`);
      const out = r.stdout || '';
      assert.match(out, /OFFER_RESULT=recommended/, 'non-TTY must take the recommend-don\'t-prompt path');
      assert.match(out, /updates itself while you sleep/, 'must print the recommendation');
      assert.match(out, /npx ruvnet-brain --enable-nightly/, 'must print the exact command to enable later');
      assert.doesNotMatch(out, /Enable nightly auto-updates\?/, 'must NOT prompt without a TTY');
      const plist = path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
      assert.ok(!fs.existsSync(plist), 'recommending must not write a plist');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  },
);

test(
  'already enabled on macOS: says nightly is already on and never prompts',
  { skip: process.platform !== 'darwin' ? 'macOS-only: exercises the LaunchAgent branch' : false },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-home-on-'));
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-kb-on-'));
    try {
      fs.writeFileSync(path.join(kbDir, 'forge-update.mjs'), '// stub for install-smoke — never executed\n');
      const plistDir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(plistDir, { recursive: true });
      fs.writeFileSync(path.join(plistDir, 'com.ruvnet.brain-update.plist'), '<!-- pre-existing -->\n');
      const r = runOfferNightly({ HOME: home, RUVNET_BRAIN_KB: kbDir });
      assert.equal(r.status, 0, `driver failed:\n${r.stderr || ''}`);
      assert.match(r.stdout || '', /OFFER_RESULT=already-on/, 'an existing LaunchAgent must short-circuit the offer');
      assert.match(r.stdout || '', /already on/, 'must say plainly that nightly is already on');
      assert.doesNotMatch(r.stdout || '', /Enable nightly auto-updates\?/, 'must not prompt when already enabled');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  },
);

// The accept-and-actually-enable path (a real TTY "y", or --yes on a fresh non-TTY run) has NO
// safe way to be exercised for real here: offerNightly() short-circuits to 'suppressed' on its
// very first line under RUVNET_BRAIN_TEST=1, but running WITHOUT it means accepting calls
// enableNightly() -> a REAL `launchctl bootstrap gui/<uid> <plist>` against the machine's actual
// launchd session (overriding HOME only redirects the plist FILE path, not the launchctl gui
// domain) -- a real, machine-wide LaunchAgent mutation the "already enabled" test above is
// deliberately built to never reach. Unblocking needs a DI seam (e.g. decoupling offerNightly's
// own suppression from enableNightly's launchctl skip, which currently share one env var) --
// flagged, not built here, same production-code sign-off norm as every other gap in this suite.
test.todo(
  'accepting the offer (TTY "y", or --yes on a fresh non-TTY run) calls enableNightly() and returns "enabled" — BLOCKED: no safe way to test without a real launchctl mutation or a new TEST_MODE/offer decoupling seam',
);

// success()'s new `nightly` param (added alongside offerNightly — the banner must not contradict
// what the offer just did) picks between an "ON — refreshes at 03:47" line and an "OFF right now"
// line with the full --update/--enable-nightly/--disable-nightly menu. Every scenario above proves
// offerNightly()'s RETURN VALUE is correct in isolation; none of them reach success() itself, because
// it is module-private (no `export`, called only from the real end-to-end main() flow) — same
// export-sign-off blocker as ~20 other functions in this suite, not unique to this feature. This
// gap is not new in kind (success()'s banner text has never had any test, for any of its offers —
// offerStack/offerClaudeMd's branches are equally untested) — flagging the two nightly-specific
// branches here since they're the freshest, not re-litigating the pre-existing full-success() gap.
test.todo(
  'success()\'s nightly banner: nightly === "enabled" or "already-on" -> prints the ON banner ("refreshes itself at 03:47") and does NOT print the OFF banner\'s --enable-nightly recommendation — BLOCKED: success() is module-private, same export-sign-off norm as the rest of this suite',
);
test.todo(
  'success()\'s nightly banner: nightly === "declined" | "suppressed" | "unsupported" | "no-updater" | "skipped" -> prints the OFF-right-now banner with the full --update/--enable-nightly/--disable-nightly menu — BLOCKED: same export-sign-off norm',
);

test(
  'non-macOS: honest "macOS-only" line plus the --update manual alternative, no prompt',
  { skip: process.platform === 'darwin' ? 'covers the non-darwin branch (runs on Linux/Windows CI)' : false },
  () => {
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-kb-lin-'));
    try {
      fs.writeFileSync(path.join(kbDir, 'forge-update.mjs'), '// stub for install-smoke — never executed\n');
      const r = runOfferNightly({ RUVNET_BRAIN_KB: kbDir });
      assert.equal(r.status, 0, `driver failed:\n${r.stderr || ''}`);
      const out = r.stdout || '';
      assert.match(out, /OFFER_RESULT=unsupported/, 'non-darwin must take the unsupported path');
      assert.match(out, /macOS-only/, 'must say honestly that the scheduler is macOS-only');
      assert.match(out, /npx ruvnet-brain --update/, 'must offer the manual --update alternative');
      assert.doesNotMatch(out, /Enable nightly auto-updates\?/, 'must not prompt on non-macOS');
    } finally {
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  },
);

// ── `--feedback`: the prefilled-Discussion composer ──────────────────────────────────────────────
// Contract under RUVNET_BRAIN_TEST=1: prints the full prefilled URL, NEVER opens a browser (the
// guard must announce itself), the URL carries the installed brain version, and — the point of
// showing the user everything — the URL contains no secrets: no home dir, no KB path, no temp path.
test('`--feedback` prints a prefilled Discussions URL with the version, opens nothing, leaks no paths', () => {
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-feedback-'));
  try {
    // Minimal installed-brain fixture: a stamped SOURCE.json (the version source) + the MCP stub.
    fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v9.9.9-test' }));
    fs.writeFileSync(path.join(kbDir, 'forge-mcp-all.mjs'), '// stub for install-smoke — never executed\n');
    const before = fs.readdirSync(kbDir).sort();

    const r = runInstaller(['--feedback'], { RUVNET_BRAIN_KB: kbDir, RUVNET_BRAIN_TEST: '1' });
    assertClean(r, '--feedback');
    const out = r.stdout || '';

    // The guard fired: no browser was opened, and the installer SAID so.
    assert.match(out, /RUVNET_BRAIN_TEST=1/, 'test-mode guard must announce that the browser open was skipped');
    assert.match(out, /not opening a browser/i, 'must say plainly that nothing was opened');

    // The URL: present, well-formed, aimed at the General category of THIS repo's Discussions.
    const m = /https:\/\/github\.com\/stuinfla\/ruvnet-brain\/discussions\/new\?\S+/.exec(out);
    assert.ok(m, `stdout must contain the prefilled discussions/new URL; got:\n${out}`);
    const url = new URL(m[0]);
    assert.equal(url.searchParams.get('category'), 'general', 'must target the general Discussions category');

    // The version travels in BOTH prefilled params — that's the whole value of the prefill.
    assert.match(url.searchParams.get('title') || '', /v9\.9\.9-test/, 'title must carry the brain version');
    assert.match(url.searchParams.get('body') || '', /v9\.9\.9-test/, 'body must carry the brain version');
    // …and the body carries the 3-line --doctor-style health summary.
    assert.match(url.searchParams.get('body') || '', /search_ruvnet/, 'body must carry the health summary');

    // No secrets, PROVEN on the decoded URL: no home dir, no KB dir, no temp dir, no username-bearing path.
    const decoded = decodeURIComponent(m[0]);
    for (const secret of [os.homedir(), kbDir, os.tmpdir()]) {
      assert.ok(!decoded.includes(secret), `prefilled URL must not contain ${secret}`);
    }
    assert.doesNotMatch(decoded, /(\/Users\/|\/home\/|C:\\Users\\)/, 'prefilled URL must not contain any user path');

    // Read-only: composing feedback must not write into the brain dir.
    assert.deepEqual(fs.readdirSync(kbDir).sort(), before, '--feedback must not mutate the KB dir');
  } finally {
    fs.rmSync(kbDir, { recursive: true, force: true });
  }
});

test('`--help` lists --feedback', () => {
  const r = runInstaller(['--help']);
  assertClean(r, '--help (--feedback)');
  assert.ok((r.stdout || '').includes('--feedback'), 'help must list the --feedback flag');
});

test('installer parses and still inlines the Ed25519 signing pubkey + verifyBundle', () => {
  // Syntax gate: a broken installer would ENOENT for every stranger on first contact.
  const check = spawnSync(process.execPath, ['--check', INSTALLER], { encoding: 'utf8', timeout: 30000 });
  assert.equal(check.status, 0, `node --check bin/install.mjs failed:\n${check.stderr || ''}`);
  // Wiring gate: the bundle-signature verifier must not be silently removed.
  const src = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(src, /SIGNING_PUBKEY_PEM\s*=/, 'SIGNING_PUBKEY_PEM constant must remain wired in');
  assert.match(src, /-----BEGIN PUBLIC KEY-----/, 'the inlined Ed25519 public key block must remain');
  assert.match(src, /function\s+verifyBundle\s*\(/, 'the verifyBundle definition must remain');
});

// ── M-D8c (ADR-058 §D8): a hook that sleeps past its declared timeout, registered in a PACKED
// hooks.json, makes the `--doctor --hooks` battery cell go RED end-to-end. tests/unit/selfcheck-
// battery.test.mjs already proves fireHook()'s watchdog catches this at the unit level (a synthetic
// "surface"); this proves the SAME thing through the real CLI entry point a stranger actually runs,
// against a marketplace-clone-shaped surface laid out the way resolveInstalledSurface() expects —
// the stranger-matrix workflow mutates the INSTALLED hooks.json the same way, so this is the fast,
// local rehearsal of that exact CI cell.
test('`--doctor --hooks` goes RED when a registered hook sleeps past its declared timeout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-hook-timeout-'));
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-hook-timeout-kb-'));
  try {
    // A healthy, otherwise-complete install (so the ONLY red comes from the hook, never from the
    // install-state checks) — same minimal fixture install-smoke's own "COMPLETE brain dir" test uses.
    fs.writeFileSync(path.join(brainDir, 'forge-mcp-all.mjs'), '// stub for install-smoke — never executed\n');
    fs.writeFileSync(path.join(brainDir, 'ruvector.rvf'), 'not a real store — presence is what gatherInstallState counts\n');
    const xen = path.join(brainDir, 'node_modules', '@xenova', 'transformers');
    fs.mkdirSync(xen, { recursive: true });
    fs.writeFileSync(path.join(xen, 'package.json'), '{"name":"@xenova/transformers","version":"0.0.0-fixture"}\n');
    fs.mkdirSync(path.join(brainDir, 'node_modules', '@ruvector'), { recursive: true });

    // The marketplace-clone-shaped plugin surface resolveInstalledSurface() looks for, seeded with
    // ONE registration: the REAL hang.mjs fixture (synchronous stdin read — freezes the event loop,
    // so only an EXTERNAL watchdog can catch it), timeout set short so the battery finishes fast.
    const pluginRoot = path.join(home, '.claude', 'plugins', 'marketplaces', 'ruvnet-brain', 'plugin');
    fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    const hangFixture = path.join(ROOT, 'tests', 'fixtures', 'selfcheck-hooks', 'hang.mjs');
    fs.copyFileSync(hangFixture, path.join(pluginRoot, 'scripts', 'hang.mjs'));
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'hook-shim.mjs'), [
      "const TABLE = { 'sleepy': { file: 'hang.mjs', interpreter: 'node', mode: 'advisory', offBehavior: 'run' } };",
      "import path from 'node:path';",
      "import { spawnSync } from 'node:child_process';",
      "import { fileURLToPath } from 'node:url';",
      'const entry = TABLE[process.argv[2]];',
      'if (!entry) process.exit(0);',
      "const here = path.dirname(fileURLToPath(import.meta.url));",
      'const r = spawnSync(process.execPath, [path.join(here, entry.file)], { stdio: "inherit" });',
      'process.exit(0);',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" sleepy', timeout: 1 }],
        }],
      },
    }, null, 2));

    const r = runInstaller(['--doctor', '--hooks'], { RUVNET_BRAIN_KB: brainDir, XDG_CACHE_HOME: path.join(home, '.cache'), HOME: home, USERPROFILE: home });
    assertVerdict(r, 1, '--doctor --hooks (a sleeping hook must fail the battery)');
    const out = r.stdout || '';
    assert.match(out, /hang/, `battery must report a hang violation; got:\n${out}`);
    assert.match(out, /Self-check FAILED/, 'the mechanical verdict must say FAILED, not just print a warning');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(brainDir, { recursive: true, force: true });
  }
}, { timeout: 30000 });
