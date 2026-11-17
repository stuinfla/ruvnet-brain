// The breaks of the wave 2 integration (the test guard and opt-in, the delivery ceiling and trimmed
// citations, contract 1.1, and the end-to-end test), added to BREAKS by breaks.mjs. Same rules as
// breaks.mjs: each names its test, an exact text replacement in a scratch copy, and the failure it must show.
export function addWave2Breaks(BREAKS) {
  // wave2 ── integration of work packages 2, 3, 6 and 7. Each names its test and the failure it must show.
  Object.assign(BREAKS, {
    'wp7-08a': {
      test: 'wp7-08', what: 'the test guard is removed (a test run may write under the real home)',
      patches: [{ file: 'packages/plugin/install.mjs', find: "if (env.RUVNET_BRAIN5_TEST !== '1') return;", replace: 'return;' }],
      expect: /a test run must refuse/,
    },
    'wp7-08b': {
      test: 'wp7-08', what: 'install registers hosts without being asked',
      patches: [{ file: 'packages/cli/ruvnet-brain.mjs', find: 'const register = args.includes(HOSTS_FLAG);', replace: 'const register = true;' }],
      expect: /install without --register-hosts must not touch any host file/,
    },
    'wp7-08c': {
      test: 'wp7-08', what: 'uninstall leaves the host entries behind',
      patches: [{ file: 'packages/cli/hosts.mjs', find: 'const r = (await shimApi()).unregisterHosts({ home, hosts: rec.hosts });', replace: 'const r = { written: [] };' }],
      expect: /uninstall must put every host file back byte for byte/,
    },
    'wave2-delivery-engine': {
      test: 'wave2-delivery', what: "the engine ignores the recipe's delivery numbers",
      patches: [{ file: 'packages/engine/index.mjs', find: 'holdToDelivery(sections.flatMap((s) => s.items), recipe.result.delivery);', replace: '' }],
      expect: /over the recipe's \d+ delivery/,
    },
    'wave2-delivery-cite-hash': {
      test: 'wave2-delivery', what: 'a trimmed excerpt cites the sha256 of its untrimmed text',
      patches: [{ file: 'packages/server/format.mjs', find: 'sha256 ${cutHere ? sha(shown) : it.hash}${note}', replace: 'sha256 ${it.hash}${note}' }],
      expect: /the cited sha256 must be that of the text shown/,
    },
    'wave2-delivery-cite-lines': {
      test: 'wave2-delivery', what: 'a trimmed excerpt cites its untrimmed line range',
      patches: [{ file: 'packages/server/format.mjs', find: '    if (kept) end = start + kept - 1;\n', replace: '' }],
      expect: /are cited but \d+ lines are shown/,
    },
    'wave2-contract-v1': {
      test: 'wave2-contract', what: 'the engine requires delivery numbers (a contract-v1 recipe names none)',
      patches: [{ file: 'packages/engine/assemble.mjs', find: '  if (!delivery) return;\n', replace: "  if (!delivery) throw new Error('the recipe names no delivery numbers');\n" }],
      expect: /the recipe names no delivery numbers/,
    },
    'wave2-contract-schema-max': {
      test: 'wave2-contract', what: 'the recipe schema lets a delivery exceed what the host delivers',
      patches: [{ file: 'packages/contract/schemas/recipe.schema.json', find: '"maxChars": { "type": "integer", "minimum": 1000, "maximum": 44000 }', replace: '"maxChars": { "type": "integer", "minimum": 1000 }' }],
      expect: /a delivery above what the host delivers is refused/,
    },
    'wave2-contract-gate-score': {
      test: 'wave2-contract', what: 'the gate-result schema stops requiring a score',
      patches: [{ file: 'packages/contract/schemas/gate-result.schema.json', find: '"required": ["schema", "version", "release", "pack", "passed", "score", "at"]', replace: '"required": ["schema", "version", "release", "pack", "passed", "at"]' }],
      expect: /a gate result without a score is refused/,
    },
    'wave2-contract-read': {
      test: 'wave2-contract', what: 'engine.read finds nothing',
      patches: [{ file: 'packages/engine/index.mjs', find: '    if (rows.length) return rows;\n  }\n  return [];', replace: '  }\n  return [];' }],
      expect: /engine\.read returns the file's passages/,
    },
    'wave2-contract-realpath': {
      test: 'wave2-contract', what: "the private-pack scope compares the caller's folder as given",
      patches: [{ file: 'packages/engine/index.mjs', find: '  try {\n    s = fs.realpathSync(s);\n  } catch {}\n', replace: '' }],
      expect: /a project reached through a link to a listed folder is that folder/,
    },
    // wave2-end-to-end: one break per claim.
    'wave2-e2e-seal': {
      test: 'wave2-end-to-end', what: 'the rail signs with a key that is not the trusted one',
      patches: [{ file: 'packages/release/seal.mjs', find: 'const release = makeRelease({ packDir, outDir, privateKeyPem, releaseNumber });', replace: "const release = makeRelease({ packDir, outDir, privateKeyPem: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), releaseNumber });" }],
      expect: /the rail must seal release 1/,
    },
    'wave2-e2e-minshim': {
      test: 'wave2-end-to-end', what: "current.json does not record the release's minShim",
      patches: [{ file: 'packages/cli/install.mjs', find: 'minShim: release.minShim, ', replace: '' }],
      expect: /current\.json records the release’s minShim/,
    },
    'wave2-e2e-launcher': {
      test: 'wave2-end-to-end', what: 'the launcher cannot start the server',
      patches: [{ file: 'packages/plugin/claude/bin/rb5', find: '    exec "$1" "$PLUGIN/launch.mjs"\n', replace: '    exit 1\n' }],
      expect: /no answer to initialize/,
    },
    'wave2-e2e-history': {
      test: 'wave2-end-to-end', what: 'the history lane is never opened',
      patches: [{ file: 'packages/engine/index.mjs', find: 'if (absent.has(spec.name)) continue;', replace: "if (absent.has(spec.name) || spec.name === 'history') continue;" }],
      expect: /FILES and HISTORY must both answer/,
    },
    'wave2-e2e-ceiling': {
      test: 'wave2-end-to-end', what: "neither the engine's delivery numbers nor the server's guard hold the text",
      patches: [
        { file: 'packages/engine/index.mjs', find: 'holdToDelivery(sections.flatMap((s) => s.items), recipe.result.delivery);', replace: '' },
        { file: 'packages/server/format.mjs', find: 'if (render().length > ceil.maxChars || estimateTokens(render()) > ceil.maxTokens) shed =', replace: 'if (false) shed =' },
        // Since wave 3 the wire guard (server/wire.mjs) is the server's last step; it goes too.
        { file: 'packages/server/wire.mjs', find: '  if (fits(out, ceil)) return out;', replace: '  return out;' },
      ],
      expect: /over the (44000|20000) the host delivers/,
    },
    'wave2-e2e-private': {
      test: 'wave2-end-to-end', what: "a private pack is searched with its own listed project instead of the caller's",
      patches: [{ file: 'packages/server/widen.mjs', find: 'const r = engine.search(p.h, m.query, m.options);', replace: 'const r = engine.search(p.h, m.query, { ...m.options, project: p.h.pack.projects[0] });' }],
      expect: /a private pack must not answer an unlisted project/,
    },
    'wave2-e2e-doctor': {
      test: 'wave2-end-to-end', what: 'doctor runs its own self-test instead of the one verdict (defect C9)',
      patches: [
        { file: 'packages/health/doctor.mjs', find: "import { currentLine } from './line.mjs';", replace: "import { currentLine } from './line.mjs';\nimport { createRequire } from 'node:module';" },
        { file: 'packages/health/doctor.mjs', find: 'const { verdict: v, line } = currentLine(home, { now });', replace: "const { verdict: v, line } = (() => {\n    const c = currentLine(home, { now });\n    try {\n      const cur = readJson(paths(home).current, null);\n      const eng = createRequire(import.meta.url)(path.join(paths(home).app, cur.app, 'engine', 'index.mjs'));\n      const h = eng.open(path.join(paths(home).packs, cur.pack));\n      if (eng.selfTest(h).ok) return { verdict: { state: 'ok' }, line: '[RuvNet Brain OK · own self-test passed]' };\n    } catch {}\n    return c;\n  })();" },
      ],
      expect: /doctor and the hook must agree in state/,
    },
    'wave2-e2e-page': {
      test: 'wave2-end-to-end', what: 'the server heartbeat never decides the owner page',
      patches: [{ file: 'packages/server/main.mjs', find: '      pageCheck({ home }).catch(() => {});\n', replace: '' }],
      expect: /the owner page must be sent while DOWN/,
    },
    'wave2-e2e-update': {
      test: 'wave2-end-to-end', what: 'an update switches the app but keeps the old pack',
      patches: [{ file: 'packages/cli/install.mjs', find: 'app: to.app, pack: to.pack, releaseNumber: release.releaseNumber,', replace: 'app: to.app, pack: cur ? cur.pack : to.pack, releaseNumber: release.releaseNumber,' }],
      expect: /update to the second release/,
    },
    'wave2-e2e-rollback': {
      test: 'wave2-end-to-end', what: 'the check through the real server after the switch is skipped',
      patches: [{ file: 'packages/cli/install.mjs', find: 'const post = await probeThroughServer(home, appDir, packDir);', replace: "const post = { ok: true, verdict: { state: 'ok', label: 'OK', knowledgeDate: '' } };" }],
      expect: /must be rolled back/,
    },
    'wave2-e2e-uninstall': {
      test: 'wave2-end-to-end', what: 'uninstall leaves the shim behind',
      patches: [{ file: 'packages/cli/uninstall.mjs', find: "path.join(home, 'shim'), ", replace: '' }],
      expect: /uninstall leaves nothing/,
    },
  });
  // end wave2
  // wp9 ── work package 9 (migration beside 4.7, and the brake). Each names its test and the failure it must show.
  const MIG = 'packages/migrate/migrate.mjs';
  const BRAKE = 'packages/migrate/brake.mjs';
  Object.assign(BREAKS, {
    'wp9-01-private': {
      test: 'wp9-01', what: 'migration copies the private stores into the version 5 home',
      patches: [{ file: MIG, find: '  if (d.brainOff) carryBrake(home, d.brainOff);\n', replace: "  if (d.brainOff) carryBrake(home, d.brainOff);\n  for (const ps of d.privateStores) for (const f of ps.files) {\n    fs.mkdirSync(path.join(home, 'private', ps.name), { recursive: true });\n    fs.copyFileSync(path.join(d.kb, f), path.join(home, 'private', ps.name, f));\n  }\n" }],
      expect: /no private text may reach the version 5 home/,
    },
    'wp9-01-autoupdate': {
      test: 'wp9-01', what: 'the recorded "no" to automatic updates is not carried',
      patches: [{ file: MIG, find: "  if (d.autoUpdate === 'no') writeJsonAtomic(paths(home).config, { ...readJson(paths(home).config, {}), autoUpdate: false });\n", replace: '' }],
      expect: /the recorded "no" to automatic updates must be carried/,
    },
    'wp9-01-touch47': {
      test: 'wp9-01', what: 'migration leaves a marker in the 4.7 home',
      patches: [{ file: MIG, find: "  step(home, rec, 'settings');\n", replace: "  step(home, rec, 'settings');\n  fs.writeFileSync(path.join(d.real, '.migrated-to-5'), 'yes');\n" }],
      expect: /migration must not change one byte of 4\.7/,
    },
    'wp9-01-plan-writes': {
      test: 'wp9-01', what: 'the plan creates the version 5 home',
      patches: [{ file: MIG, find: '    for (const l of planLines(', replace: '    fs.mkdirSync(home5(env, d).home, { recursive: true });\n    for (const l of planLines(' }],
      expect: /the plan must write nothing/,
    },
    'wp9-01-link': {
      test: 'wp9-01', what: 'a 4.7 home on another disk is ignored (version 5 lands on the home disk)',
      patches: [{ file: MIG, find: '  if (env[HOME_ENV] || !d?.linked || fs.existsSync(home)) return { home, real: null };', replace: '  return { home, real: null };' }],
      expect: /the version 5 home is a link at the usual place/,
    },
    'wp9-01-off': {
      test: 'wp9-01', what: "4.7's own off switch is not carried",
      patches: [{ file: MIG, find: '  if (d.brainOff) carryBrake(home, d.brainOff);\n', replace: '' }],
      expect: /did not match the regular expression \/host registration skipped|the 4\.7 "off" is carried as the brake/,
    },
    'wp9-01-unlisted': {
      test: 'wp9-01', what: 'the plan does not list what it leaves in place',
      patches: [{ file: MIG, find: '  out.push(`  everything else in ${d.home}', replace: '  if (false) out.push(`  everything else in ${d.home}' }],
      expect: /the plan lists what it leaves/,
    },
    'wp9-01-unguarded': {
      test: 'wp9-01', what: 'the 4.7 home is read without the test guard',
      patches: [{ file: 'packages/migrate/detect.mjs', find: '  refuseProtected([h.home, h.real], env);\n', replace: '' }],
      expect: /a test run must refuse a 4\.7 home under a protected folder/,
    },
    'wp9-02-no-unregister': {
      test: 'wp9-02', what: 'the brake does not remove the version 5 host entries (its own check catches it)',
      patches: [{ file: BRAKE, find: '  await unregisterRecorded(home, log);\n', replace: '' }],
      expect: /still start version 5/,
    },
    'wp9-02-no-verify': {
      test: 'wp9-02', what: 'the brake neither removes the host entries nor checks them',
      patches: [
        { file: BRAKE, find: '  await unregisterRecorded(home, log);\n', replace: '' },
        { file: BRAKE, find: '  if (left.length) throw', replace: '  if (false) throw' },
      ],
      expect: /every Claude Code file is back to its pre-migration bytes/,
    },
    'wp9-02-no-47-check': {
      test: 'wp9-02', what: 'the brake does not check that 4.7 can serve',
      patches: [{ file: BRAKE, find: '  if (!u.ok) throw', replace: '  if (false) throw' }],
      expect: /the brake must refuse when 4\.7 cannot serve/,
    },
    'wp9-02-undo': {
      test: 'wp9-02', what: '--undo does not put the host entries back',
      patches: [{ file: BRAKE, find: '  if (hosts) {\n', replace: '  if (false) {\n' }],
      expect: /version 5 is registered again/,
    },
    'wp9-03-aside': {
      test: 'wp9-03', what: "migration moves 4.7's knowledge aside while it installs and puts it back after",
      patches: [
        { file: MIG, find: "  step(home, rec, 'install');\n", replace: "  step(home, rec, 'install');\n  if (fs.existsSync(d.kb)) fs.renameSync(d.kb, `${d.kb}.aside`);\n" },
        { file: MIG, find: "  step(home, rec, 'hosts');\n", replace: "  step(home, rec, 'hosts');\n  fs.renameSync(`${d.kb}.aside`, d.kb);\n" },
      ],
      expect: /4\.7 must still be whole after a kill/,
    },
    'wp9-03-resume': {
      test: 'wp9-03', what: 'an interrupted migration cannot be finished by running it again',
      patches: [{ file: MIG, find: '  const rec = prev ?? {', replace: "  if (prev) throw new Refused('a migration was interrupted');\n  const rec = prev ?? {" }],
      expect: /running it again must finish the migration/,
    },
  });
  // end wp9
  // wp10 ── work package 10 (the optional write guard). Each names its test and the failure it must show.
  const GUARD = 'packages/guard/guard.mjs';
  Object.assign(BREAKS, {
    'wp10-01-refuse-anyway': {
      test: 'wp10-01', what: 'the guard refuses even when search is not ok',
      patches: [{ file: GUARD, find: "  if (v.state !== 'ok') return", replace: '  if (false) return' }],
      expect: /with search not ok the write must be allowed/,
    },
    'wp10-01-second-failure-mode': {
      test: 'wp10-01', what: 'an internal error is not turned into an allowed write (a second failure mode)',
      patches: [{ file: GUARD, find: '  } catch (e) {\n    d = {', replace: '  } catch (e) {\n    throw e;\n    d = {' }],
      expect: /an unreadable session record must allow the write/,
    },
    'wp10-02-unrecorded': {
      test: 'wp10-02', what: 'the override is not recorded',
      patches: [{ file: GUARD, find: '    record(home, { at:', replace: '    if (false) record(home, { at:' }],
      expect: /the override must be recorded/,
    },
    'wp10-02-ignored': {
      test: 'wp10-02', what: 'the in-file override line is ignored',
      patches: [{ file: GUARD, find: '    if (reason.length >= 3) return reason;', replace: '' }],
      expect: /the override line must let the write through/,
    },
    'wp10-03-default-on': {
      test: 'wp10-03', what: 'the guard is on unless switched off',
      // Since contract 1.2 DEFAULTS names guard: false, so "on unless switched off" also flips that default.
      patches: [
        { file: GUARD, find: '  if (readConfig(home).guard !== true) return', replace: '  if (readConfig(home).guard === false) return' },
        { file: 'packages/contract/constants.mjs', find: '  guard: false,', replace: '  guard: true,' },
      ],
      expect: /a fresh install must not refuse|a fresh install reports the guard off/,
    },
    'wp10-04-unverified': {
      test: 'wp10-04', what: 'any search-looking result counts, without checking it against the pack',
      patches: [{ file: GUARD, find: 'if (results.length && (await verifiedAgainstPack(home, results)))', replace: 'if (results.length)' }],
      expect: /a forged record \(a file not in the pack\) must not pass/,
    },
    'wp10-04-stale': {
      test: 'wp10-04', what: 'the freshness window is not applied',
      patches: [{ file: GUARD, find: ' && now - at <= G.freshMinutes * 60_000', replace: '' }],
      expect: /a stale result does not count/,
    },
    'wp10-04-stamp': {
      test: 'wp10-04', what: 'a stamp file in the brain home counts as a search',
      patches: [{ file: GUARD, find: "  if (!input?.transcript_path) return", replace: "  if (fs.existsSync(path.join(paths(home).state, 'search-stamp.json'))) return { action: 'allow' };\n  if (!input?.transcript_path) return" }],
      expect: /a hand-made stamp must not let a write through/,
    },
    'wp10-05-project-data': {
      test: 'wp10-05', what: "the guard reads its product names from the project's folder",
      patches: [{ file: GUARD, find: "fs.readFileSync(new URL('./guard.json', import.meta.url), 'utf8')", replace: "fs.readFileSync(path.join(process.cwd(), 'guard.json'), 'utf8')" }],
      expect: /the guard's product names must come from beside it/,
    },
    'wp10-05-project-engine': {
      test: 'wp10-05', what: "the guard opens the engine found in the project's folder",
      patches: [{ file: GUARD, find: "await import('../engine/index.mjs')", replace: "await import((await import('node:url')).pathToFileURL(path.join(process.cwd(), 'packages', 'engine', 'index.mjs')).href)" }],
      expect: /a project file ran|a real search passes/,
    },
  });
  // end wp10
  // wp11 ── work package 11 (generated documents). Each names its test and the failure it must show.
  const GEN = 'packages/docs/generate.mjs';
  Object.assign(BREAKS, {
    'wp11-01-check-passes': {
      test: 'wp11-01', what: 'the check reports current whatever the files hold',
      patches: [{ file: GEN, find: '    if (stale.length) {', replace: '    if (false) {' }],
      expect: /a changed recipe must make the check fail/,
    },
    'wp11-01-restated': {
      test: 'wp11-01', what: 'the recipe document restates the deadline by hand',
      patches: [{ file: GEN, find: "['search deadline', `${r.deadlineMs} ms`]", replace: "['search deadline', '10000 ms']" }],
      expect: /a changed recipe must make the check fail|the regenerated RECIPE\.md shows the new deadline/,
    },
    'wp11-01-commands-by-hand': {
      test: 'wp11-01', what: 'the commands are written from a copy instead of from the CLI',
      patches: [{ file: GEN, find: "out.push('```', cliOut([]),", replace: "out.push('```', 'usage:\\n  ruvnet-brain install', cliOut([]).slice(0, 0)," }],
      expect: /the committed documents must be current|a changed command must make the check fail/,
    },
    'wp11-02-frozen-fixes': {
      test: 'wp11-02', what: 'the fixes come from a frozen copy, not the health table',
      patches: [{ file: GEN, find: "return [cause, v.label, v.fix ?? '(none)',", replace: "return [cause, v.label, ({ 'safe-mode': 'restart the session' })[cause] ?? v.fix ?? '(none)'," }],
      expect: /a changed fix in packages\/health must appear in the reference/,
    },
    'wp11-02-skip-unknown': {
      test: 'wp11-02', what: 'a cause the generator does not describe is skipped silently',
      patches: [{ file: GEN, find: '  if (missing.length) throw', replace: '  if (false) throw' }],
      expect: /a cause the generator does not describe must be refused/,
    },
    'wp11-03-no-validation': {
      test: 'wp11-03', what: 'the parity rows are not checked',
      patches: [{ file: GEN, find: '  if (bad.length) throw new Stale(`packages/docs/parity.json', replace: '  if (false) throw new Stale(`packages/docs/parity.json' }],
      expect: /a dropped row with no reason: the generator must refuse/,
    },
    'wp11-03-totals': {
      test: 'wp11-03', what: 'the totals count replaced rows as kept',
      patches: [{ file: GEN, find: "const count = (d) => p.rows.filter((r) => r.decision === d).length;", replace: "const count = (d) => p.rows.filter((r) => r.decision === d || (d === 'kept' && r.decision === 'replaced')).length;" }],
      expect: /the totals are those of the data/,
    },
  });
  // end wp11
}
