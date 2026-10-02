// The doctor's grounding question: warming the models is its own step, and a timeout mid-answer is
// reported as slow-not-broken. Measured cause: 4.4.1 public-verification-macos (run 36877770786).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  classifySmokeFailure, classifyWarmupFailure, coldModels, MODEL_WARMUP_SCRIPT,
} from '../../scripts/installed-brain-health.mjs';
import { completeBrain } from '../helpers/doctor-brain-fixture.mjs';
import { BGE_MODEL, RERANKER_MODEL, modelPath } from '../../kb/model-requirements.mjs';
import { QueryDeadlineExceeded, describeDeadline, DEADLINE_EXIT_CODE } from '../../kb/query-deadline.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `doctor-warm-${name}-`));
const readyModel = (cache, model) => {
  const root = modelPath(cache, model);
  fs.mkdirSync(path.join(root, 'onnx'), { recursive: true });
  for (const f of ['tokenizer.json', 'config.json', path.join('onnx', 'model_quantized.onnx')]) fs.writeFileSync(path.join(root, f), '{}');
};

describe('classifySmokeFailure', () => {
  it('reads the reader\'s own deadline line as slow-not-broken and names the phase', () => {
    const stderr = `\n${describeDeadline(new QueryDeadlineExceeded({ phase: 'rerank', deadlineMs: 45000, elapsedMs: 45195 }))}`;
    const v = classifySmokeFailure({ status: DEADLINE_EXIT_CODE, stderr, secs: '45.8', limitSecs: 45 });
    expect(v.kind).toBe('slow');
    expect(v.phase).toBe('rerank');
    expect(v.cause).toBe('still answering (phase "rerank") when the 45s limit ran out, after 45.8s — slow on this machine, not broken');
  });

  it('a crash is a crash, even with exit 4, when the reader never said it hit its deadline', () => {
    expect(classifySmokeFailure({ status: 4, stderr: 'Error: Cannot find module x', secs: '1.2', limitSecs: 45 }))
      .toEqual({ kind: 'crash', cause: 'the reader exited 4 after 1.2s' });
    expect(classifySmokeFailure({ status: 1, stderr: 'TypeError', secs: '2.0', limitSecs: 45 }).kind).toBe('crash');
  });

  it('keeps the launch / outer-timeout / killed / empty causes exact', () => {
    expect(classifySmokeFailure({ error: new Error('spawn node ENOENT'), secs: '0.0' }))
      .toEqual({ kind: 'launch', cause: 'could not launch the reader: spawn node ENOENT' });
    expect(classifySmokeFailure({ signal: 'SIGTERM', status: null, secs: '240.0' }).cause)
      .toBe('timed out after 240.0s (240s limit) with no answer');
    expect(classifySmokeFailure({ signal: 'SIGKILL', status: null, secs: '3.0' }).kind).toBe('killed');
    expect(classifySmokeFailure({ status: 0, stderr: '', secs: '3.0' }))
      .toEqual({ kind: 'empty', cause: 'the reader exited 0 after 3.0s but printed nothing' });
  });
});

describe('coldModels', () => {
  const kbWith = (model) => {
    const kb = tmp('kb');
    fs.writeFileSync(path.join(kb, 'ruvnet-brain.rvf'), '');
    fs.writeFileSync(path.join(kb, 'ruvnet-brain.rvf.embed.json'), JSON.stringify({ model }));
    return kb;
  };

  it('lists the store\'s embedder and the reranker when the cache is empty', () => {
    expect(coldModels(kbWith(BGE_MODEL), tmp('cache'))).toEqual([BGE_MODEL, RERANKER_MODEL]);
  });

  it('is empty once every model the question loads is fully present', () => {
    const cache = tmp('cache');
    readyModel(cache, BGE_MODEL);
    readyModel(cache, RERANKER_MODEL);
    expect(coldModels(kbWith(BGE_MODEL), cache)).toEqual([]);
  });

  it('a partial download (directory present, weights missing) is still cold', () => {
    const cache = tmp('cache');
    readyModel(cache, BGE_MODEL);
    fs.mkdirSync(modelPath(cache, RERANKER_MODEL), { recursive: true });
    fs.writeFileSync(path.join(modelPath(cache, RERANKER_MODEL), 'config.json'), '{}');
    expect(coldModels(kbWith(BGE_MODEL), cache)).toEqual([RERANKER_MODEL]);
  });
});

describe('MODEL_WARMUP_SCRIPT (run for real against a stand-in KB)', () => {
  const kbWithWarmers = ({ ask, rerank }) => {
    const kb = tmp('warm');
    fs.writeFileSync(path.join(kb, 'forge-ask.mjs'), ask);
    fs.writeFileSync(path.join(kb, 'forge-rerank.mjs'), rerank);
    return kb;
  };
  const run = (kb) => spawnSync(process.execPath, ['--input-type=module', '-e', MODEL_WARMUP_SCRIPT], { cwd: kb, encoding: 'utf8' });

  it('warms the embedder, then the reranker, and exits 0', () => {
    const kb = kbWithWarmers({
      ask: "import fs from 'node:fs'; export async function warmQueryEmbedder() { fs.appendFileSync('order', 'embedder\\n'); }",
      rerank: "import fs from 'node:fs'; export async function warmReranker() { fs.appendFileSync('order', 'reranker\\n'); }",
    });
    expect(run(kb).status).toBe(0);
    expect(fs.readFileSync(path.join(kb, 'order'), 'utf8')).toBe('embedder\nreranker\n');
  });

  it('exits 3 (skip, not fail) on a bundle that predates the warm hooks', () => {
    const kb = kbWithWarmers({ ask: 'export const x = 1;', rerank: 'export const y = 1;' });
    expect(run(kb).status).toBe(3);
  });

  it('a warm-up that throws is a real failure with its error on stderr', () => {
    const kb = kbWithWarmers({
      ask: "export async function warmQueryEmbedder() { throw new Error('onnx load failed'); }",
      rerank: 'export async function warmReranker() {}',
    });
    const r = run(kb);
    expect([0, 3]).not.toContain(r.status);
    expect(r.stderr).toContain('onnx load failed');
  });
});

// Re-review B1: the warm-up's "timed out" test was `Boolean(w.signal) && !w.error` — backwards. Node's
// spawnSync timeout delivers signal SIGTERM AND error ETIMEDOUT (so a real timeout read as a failure), while a
// native crash (SIGABRT / SIGSEGV) has a signal and NO error (so a crash read as an advisory timeout, and a
// corrupt model runtime plus a persisted 'proven' verdict gave ✓ Healthy). These spawn REAL children.
const node = (code, opts = {}) => spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', ...opts });
describe('the warm-up classification, from REAL spawnSync results', () => {
  it('a real timeout (SIGTERM + ETIMEDOUT) is a timeout, advisory', () => {
    const w = node('setTimeout(() => {}, 10000)', { timeout: 200 });
    expect([w.signal, w.error?.code]).toEqual(['SIGTERM', 'ETIMEDOUT']);
    expect(classifyWarmupFailure({ ...w, secs: '0.2', limitSecs: 0.2 })).toMatchObject({ kind: 'timeout', advisory: true });
  });
  it.skipIf(process.platform === 'win32')('a real native crash (SIGABRT, SIGSEGV) is a crash: a failure with its own cause, never advisory', () => {
    for (const [code, signal] of [['process.abort()', 'SIGABRT'], ['process.kill(process.pid, "SIGSEGV")', 'SIGSEGV']]) {
      const w = node(code);
      expect(w.signal).toBe(signal);
      expect(w.error).toBeUndefined();
      const v = classifyWarmupFailure({ ...w, secs: '0.1', limitSecs: 300 });
      expect(v).toMatchObject({ kind: 'crash', advisory: false });
      expect(v.cause).toContain(signal);
    }
  });
  it('a plain non-zero exit is a failure, not a timeout', () => {
    expect(classifyWarmupFailure({ ...node('process.exit(1)'), secs: '0.1', limitSecs: 300 })).toMatchObject({ kind: 'exit', advisory: false });
  });
  it('the timed QUESTION timing out is named a timeout (not "could not launch"), and stays a failure', () => {
    const r = node('setTimeout(() => {}, 10000)', { timeout: 200 });
    expect(classifySmokeFailure({ error: r.error, signal: r.signal, status: r.status, stderr: r.stderr, secs: '0.2', limitSecs: 0.2 }).kind).toBe('timeout');
  });
});

// The doctor itself, on a complete hermetic install whose reader files are real executables: what it runs,
// in what order, and what each outcome does to the ONE verdict.
describe('the doctor runs the warm-up only for a cold cache, before the timed question', () => {
  it('cold cache: warm-up, then the question; warm cache: the question only', () => {
    for (const [modelsReady, expected] of [[false, ['warm', 'ask']], [true, ['ask']]]) {
      const b = completeBrain({ modelsReady });
      try {
        const r = b.doctor();
        expect(b.calls(), r.text.slice(-2000)).toEqual(expected);
        expect(r.status).toBe(0);
      } finally { b.cleanup(); }
    }
  }, 120_000);

  it.skipIf(process.platform === 'win32')('a warm-up that CRASHES (SIGABRT) fails the doctor, even with a persisted proven verdict for these bytes', () => {
    const b = completeBrain({ warm: 'abort' });
    try {
      b.persist({ grounding: 'proven', clearedBy: 'search_ruvnet', coverageSha256: b.coverageSha256() });
      const r = b.doctor();
      expect(r.status).toBe(1);
      expect(r.text).toMatch(/✗ Grounding\s+not proven \(model-warmup-crash: .*SIGABRT/);
      expect(b.calls()).toEqual(['warm']); // the question never ran on a crashed runtime
    } finally { b.cleanup(); }
  }, 120_000);

  // Re-review a6 SF4: a verifier that throws when CALLED (not on import) crashed the doctor — exit 1 with no
  // parseable --json, breaking the one-verdict contract.
  it('a verifier that throws at call time is ✗ reader-broken, and text, --json and the exit code agree', () => {
    const b = completeBrain({ verifier: 'throwsAtCall', modelsReady: true });
    try {
      const text = b.doctor();
      const jsonRun = b.doctor(['--json']);
      const verdict = JSON.parse(jsonRun.stdout);
      expect(verdict.lines.find((l) => l.id === 'grounding')).toMatchObject({ state: 'fail', detail: expect.stringMatching(/reader-broken: verify-citation\.mjs threw/) });
      expect(text.text).toMatch(/✗ Grounding\s+not proven \(reader-broken: verify-citation\.mjs threw/);
      expect([text.status, jsonRun.status, verdict.exitCode]).toEqual([1, 1, 1]);
    } finally { b.cleanup(); }
  }, 120_000);

  it('the timed question hitting the reader\'s own deadline is ✗ (only a WARM-UP timeout is advisory)', () => {
    const b = completeBrain({ ask: 'deadline', modelsReady: true });
    try {
      const r = b.doctor();
      expect(r.status).toBe(1);
      expect(r.text).toMatch(/✗ Grounding\s+not proven \(no-answer: still answering \(phase "rerank"\)/);
      // The detail says "slow, not broken", so the fix is to run it again — never a reinstall (re-review a6 NIT).
      expect(r.text).toMatch(/✗ Grounding[^\n]*\n\s+fix: npx ruvnet-brain --doctor \(again, when the machine is less busy\)/);
    } finally { b.cleanup(); }
  }, 120_000);
});
