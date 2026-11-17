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
}
