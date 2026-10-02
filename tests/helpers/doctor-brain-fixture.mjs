// doctor-brain-fixture.mjs — a genuinely complete, hermetic, offline install for driving the REAL
// `bin/install.mjs --doctor` (re-review 4.5): search entry points, the reader's warm-up modules (no model),
// a canned cited answer, a build time, COVERAGE.json, the signature record from the real writer, and the
// installed-runtime identity. Every behaviour a test needs is a real file the doctor executes — a warm-up
// that aborts, a question that hits the reader's own deadline — never a hand-built result object.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeInstalledRuntimeIdentity } from '../../kb/corpus-release-identity.mjs';
import { writeSignatureRecord } from '../../plugin/scripts/brain-confirmation.mjs';
import { RERANKER_MODEL, modelPath, requiredEmbedderModels } from '../../kb/model-requirements.mjs';
import { QueryDeadlineExceeded, describeDeadline, DEADLINE_EXIT_CODE } from '../../kb/query-deadline.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const EMPTY_GIT = path.join(os.tmpdir(), 'empty-gitconfig-doctor-fixture');

const WARMERS = {
  noop: (log) => `import fs from 'node:fs';
export async function warmQueryEmbedder() { fs.appendFileSync(${JSON.stringify(log)}, 'warm\\n'); }`,
  // A native crash in the model runtime: SIGABRT, no error object — what a corrupt onnxruntime looks like.
  abort: (log) => `import fs from 'node:fs';
export async function warmQueryEmbedder() { fs.appendFileSync(${JSON.stringify(log)}, 'warm\\n'); process.abort(); }`,
};
const ASKERS = {
  answer: (log) => `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, 'ask\\n');
console.log('RuvNet Brain package manifest declares ruvnet-brain [source/package.json]');`,
  // The reader's OWN deadline (kb/query-deadline.mjs), exactly as it prints and exits.
  deadline: (log) => `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, 'ask\\n');
process.stderr.write(${JSON.stringify(`\n${describeDeadline(new QueryDeadlineExceeded({ phase: 'rerank', deadlineMs: 45000, elapsedMs: 45195 }))}\n`)});
process.exit(${DEADLINE_EXIT_CODE});`,
};
const VERIFIERS = {
  proves: "export async function verifyGrounding() { return { grounded: true, receipt: { path: 'source/package.json', file: 'passages.jsonl' } }; }\n",
  throws: "throw new Error('fixture: this verifier is broken');\n",
  throwsAtCall: "export async function verifyGrounding() { throw new Error('fixture: verifier fails at call time'); }\n",
};

/**
 * @param warm 'noop' | 'abort'   @param ask 'answer' | 'deadline'   @param verifier 'proves' | 'throws' | 'throwsAtCall' | 'absent'
 * @param modelsReady true = the reranker is already in the model cache (no warm-up needed)
 */
export function completeBrain({ warm = 'noop', ask = 'answer', verifier = 'proves', modelsReady = false } = {}) {
  fs.writeFileSync(EMPTY_GIT, '');
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-brain-')));
  const kbDir = path.join(parent, 'kb');
  const cacheDir = path.join(parent, 'cache');
  const brainHome = path.join(parent, 'brain-home');
  const home = path.join(parent, 'home');
  const models = path.join(parent, 'models');
  const project = path.join(parent, 'project');
  const log = path.join(parent, 'calls.log');
  for (const d of [kbDir, cacheDir, brainHome, home, models, project]) fs.mkdirSync(d, { recursive: true });
  const files = new Map([
    ['forge-mcp-all.mjs', '// fixture forge-mcp-all.mjs\n'], ['card-lane.mjs', '// fixture card-lane.mjs\n'],
    ['forge-ask-all.mjs', ASKERS[ask](log)], ['forge-ask.mjs', WARMERS[warm](log)],
    ['forge-rerank.mjs', 'export async function warmReranker() {}\n'],
    ['coverage-integrity.mjs', fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'coverage-integrity.mjs'))],
  ]);
  for (const [name, bytes] of files) fs.writeFileSync(path.join(kbDir, name), bytes);
  if (verifier !== 'absent') fs.writeFileSync(path.join(kbDir, 'verify-citation.mjs'), VERIFIERS[verifier]);
  fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify({ brainVersion: VERSION, releaseTag: `v${VERSION}`, builtUtc: new Date().toISOString() }));
  fs.writeFileSync(path.join(kbDir, 'COVERAGE.json'), JSON.stringify({ rows: [] }));
  fs.writeFileSync(path.join(kbDir, 'ruvector.big.rvf'), 'presence is what the install check counts\n');
  fs.mkdirSync(path.join(kbDir, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'node_modules', '@xenova', 'transformers', 'package.json'), '{"name":"@xenova/transformers","version":"0.0.0-fixture"}\n');
  fs.mkdirSync(path.join(kbDir, 'node_modules', '@ruvector'), { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'ARCHIVE-MANIFEST.json'), JSON.stringify({ schemaVersion: 1, kind: 'ruvnet-brain-archive-manifest', version: VERSION,
    files: [...files].map(([name, v]) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(v); return { path: name, sha256: sha(b), bytes: b.length }; }) }));
  writeInstalledRuntimeIdentity(kbDir, { brainVersion: VERSION });
  writeSignatureRecord({ brainHome, kbDir, source: 'fixture', bundleSha256: sha(fs.readFileSync(path.join(kbDir, 'ARCHIVE-MANIFEST.json'))) });
  if (modelsReady) {
    for (const model of [...requiredEmbedderModels(kbDir), RERANKER_MODEL]) {
      const root = modelPath(models, model);
      fs.mkdirSync(path.join(root, 'onnx'), { recursive: true });
      for (const f of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) fs.writeFileSync(path.join(root, f), '{}');
    }
  }
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, RUVNET_BRAIN_KB: kbDir, RUVNET_BRAIN_HOME: brainHome,
    XDG_CACHE_HOME: cacheDir, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), KB_MODEL_CACHE: models,
    RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_TEST_NPM_LATEST: VERSION, RUVNET_NO_TELEMETRY: '1', RUFLO_DAEMON_AUTOSTART: '0',
    GIT_CONFIG_GLOBAL: EMPTY_GIT, GIT_CONFIG_NOSYSTEM: '1' };
  const stateFile = path.join(cacheDir, 'ruvnet-brain', 'install-state.json');
  return {
    parent, kbDir, cacheDir, brainHome, home, project, log, env, stateFile,
    coverageSha256: () => sha(fs.readFileSync(path.join(kbDir, 'COVERAGE.json'))),
    persist(state) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    doctor(args = [], { cwd = project, extraEnv = {} } = {}) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--doctor', ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120_000 });
      // eslint-disable-next-line no-control-regex
      return { ...r, text: String(r.stdout || '').replace(/\u001b\[[0-9;]*m/g, '') };
    },
    cleanup() { fs.rmSync(parent, { recursive: true, force: true }); },
  };
}
