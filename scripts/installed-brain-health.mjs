// ADR-089: describe installed identities without confusing a validator pin with search-engine proof.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readInstalledRuntime, isCorpusReleaseTag } from '../kb/corpus-release-identity.mjs';
import { cmpVersion } from './stack-sync.mjs';
import { isRuntimeFile } from './approved-runtime.mjs';
import { modelCacheReady, requiredEmbedderModels, RERANKER_MODEL } from '../kb/model-requirements.mjs';

const SEARCH_FILES = ['forge-mcp-all.mjs', 'forge-ask-all.mjs', 'forge-rerank.mjs', 'card-lane.mjs'];
// Keep the doctor probe answerable and bounded. A health probe must exercise a real indexed
// source/citation path; it must not turn an unclear broad question into an all-corpus rerank.
export const DOCTOR_SMOKE_QUERY = 'What package name is declared in the RuvNet Brain KB package manifest?';
export function doctorSmokeArgs(cacheDir) {
  return ['forge-ask-all.mjs', '--dir', cacheDir, '--q', DOCTOR_SMOKE_QUERY,
    '--repos', 'ruvnet-brain', '--k', '3', '--pool', '8', '--bounded'];
}

// The models the doctor's question loads whose local copy is not complete. A partial download is
// cold, not ready: the reader would fetch it again inside the timed question.
export function coldModels(kbDir, modelCache) {
  return [...requiredEmbedderModels(kbDir), RERANKER_MODEL]
    .filter((model, i, all) => all.indexOf(model) === i && !modelCacheReady(modelCache, model));
}

// One-time model download + load + first forward pass, kept OUT of the timed question so the
// question's limit measures answering, not fetching. Exits 3 on a bundle that predates the hooks.
export const MODEL_WARMUP_SCRIPT = [
  "const ask = await import('./forge-ask.mjs');",
  "const rr = await import('./forge-rerank.mjs');",
  "if (typeof ask.warmQueryEmbedder !== 'function' || typeof rr.warmReranker !== 'function') process.exit(3);",
  'await ask.warmQueryEmbedder();',
  'await rr.warmReranker();',
  'process.exit(0);',
].join('\n');
export const MODEL_WARMUP_TIMEOUT_MS = 300_000;

// WHY the doctor's question produced no answer, from what spawnSync returned. "slow" is the reader's
// own deadline: kb/query-deadline.mjs describeDeadline() prints this line, naming the phase still
// running, only on that path (that module is not in the npm package, so its text is the contract
// here). The reader works and was mid-answer — a different fault, with different advice, from a crash.
export function classifySmokeFailure({ error, signal, status, stderr = '', secs, limitSecs }) {
  // spawnSync delivers its own timeout as signal SIGTERM AND error ETIMEDOUT: a timeout, not a launch failure.
  if (error?.code === 'ETIMEDOUT') return { kind: 'timeout', cause: `timed out after ${secs}s (240s limit) with no answer` };
  if (error) return { kind: 'launch', cause: `could not launch the reader: ${error.message}` };
  if (signal === 'SIGTERM') return { kind: 'timeout', cause: `timed out after ${secs}s (240s limit) with no answer` };
  if (signal) return { kind: 'killed', cause: `the reader was killed by ${signal} after ${secs}s` };
  const phase = (String(stderr).match(/QUERY DEADLINE EXCEEDED — phase "([^"]+)"/) || [])[1];
  if (status !== 0 && phase) {
    return { kind: 'slow', phase,
      cause: `still answering (phase "${phase}") when the ${limitSecs}s limit ran out, after ${secs}s — slow on this machine, not broken` };
  }
  if (status !== 0) return { kind: 'crash', cause: `the reader exited ${status} after ${secs}s` };
  return { kind: 'empty', cause: `the reader exited 0 after ${secs}s but printed nothing` };
}

/**
 * Why the model warm-up did not finish (re-review B1). spawnSync's own timeout is signal SIGTERM WITH error
 * ETIMEDOUT — a slow machine, advisory. A signal with NO error is the child dying on its own: SIGABRT,
 * SIGSEGV, an OOM SIGKILL — a broken model runtime or cache, a failure with its own cause. The old test,
 * `signal && !error`, had both backwards.
 */
export function classifyWarmupFailure({ error, signal, status, secs, limitSecs }) {
  if (error?.code === 'ETIMEDOUT') return { kind: 'timeout', advisory: true, cause: `ran out of time after ${secs}s (${limitSecs}s limit) — slow on this machine, not broken` };
  if (error) return { kind: 'launch', advisory: false, cause: `could not start: ${error.message}` };
  if (signal) return { kind: 'crash', advisory: false, cause: `crashed (${signal}) after ${secs}s — the model runtime or its cache is broken` };
  return { kind: 'exit', advisory: false, cause: `exited ${status} after ${secs}s` };
}

const version = value => typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)
  ? value.replace(/^v/, '') : null;

export function inspectInstalledBrain(kbDir, packageVersion) {
  const result = { healthy: false, packageVersion, searchVersion: null, corpusTag: null,
    validatorVersion: null, searchFiles: {}, issues: [] };
  let source;
  try { source = JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')); }
  catch { result.issues.push('SOURCE.json is missing or unreadable'); }
  result.searchVersion = version(source?.brainVersion) || version(source?.releaseTag);
  result.corpusTag = isCorpusReleaseTag(source?.corpusReleaseTag) ? source.corpusReleaseTag : null;
  if (!result.searchVersion) result.issues.push('the search engine version is unverified');
  if (version(source?.brainVersion) && version(source?.releaseTag)
    && version(source.brainVersion) !== version(source.releaseTag)) {
    result.issues.push('SOURCE.json runtime version and release tag disagree');
  }
  const pin = readInstalledRuntime(kbDir);
  result.validatorVersion = pin.brainVersion;
  if (!pin.ok) result.issues.push(pin.reason);
  if (pin.ok && result.searchVersion && version(pin.brainVersion) !== result.searchVersion) {
    result.issues.push(`validator runtime ${pin.brainVersion} and search engine ${result.searchVersion} differ`);
  }
  const expected = version(packageVersion);
  if (expected && result.searchVersion && cmpVersion(result.searchVersion, expected) < 0) {
    result.issues.push(`search engine ${result.searchVersion} is behind package ${packageVersion}`);
  }
  for (const file of SEARCH_FILES) {
    try {
      const bytes = fs.readFileSync(path.join(kbDir, file));
      result.searchFiles[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      if (!bytes.length) result.issues.push(`search executable ${file} is empty`);
    } catch { result.issues.push(`search executable ${file} is missing`); }
  }
  // The installed archive manifest lets doctor detect code drift even if SOURCE's version stayed
  // unchanged. This is a consistency check, not independent authentication of a local manifest.
  try {
    const archive = JSON.parse(fs.readFileSync(path.join(kbDir, 'ARCHIVE-MANIFEST.json'), 'utf8'));
    if (archive.kind !== 'ruvnet-brain-archive-manifest' || !Array.isArray(archive.files)) {
      throw new Error('invalid archive manifest shape');
    }
    if (version(archive.version) !== result.searchVersion) {
      result.issues.push('archive manifest and search engine versions differ');
    }
    const runtimeFiles = new Set([...SEARCH_FILES, ...archive.files.filter(row => isRuntimeFile(row?.path)).map(row => row.path)]);
    for (const file of runtimeFiles) {
      if (typeof file !== 'string' || path.isAbsolute(file) || file.includes('\\')
        || file.split('/').some(part => !part || part === '.' || part === '..')) {
        result.issues.push('archive manifest contains an unsafe runtime path');
        continue;
      }
      const rows = archive.files.filter(row => row?.path === file);
      let actual = result.searchFiles[file];
      if (!actual) {
        try {
          const bytes = fs.readFileSync(path.join(kbDir, file));
          actual = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
          result.searchFiles[file] = actual;
        } catch { result.issues.push(`runtime file ${file} is missing`); }
      }
      if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(rows[0]?.sha256 || '')
        || !Number.isSafeInteger(rows[0]?.bytes) || rows[0].bytes < 0) {
        result.issues.push(`archive manifest has no unique valid identity for ${file}`);
      } else if (actual && (actual.sha256 !== rows[0].sha256 || actual.bytes !== rows[0].bytes)) {
        result.issues.push(`search executable ${file} differs from the installed archive manifest`);
      }
    }
  } catch (error) {
    result.issues.push(`installed archive manifest is missing or unreadable: ${error.message}`);
  }
  // These hashes and the local manifest are NOT independent release approval receipts.
  result.healthy = result.issues.length === 0;
  return result;
}

export function classifySmokeEvidence(verification, answer) {
  if (!verification?.grounded) return { usable: false, reason: verification?.reason || 'citation-not-verified' };
  const weak = /EVIDENCE:\s*(?:INSUFFICIENT_EVIDENCE|THIN)\b/i.test(answer);
  if (weak) return { usable: false, reason: 'retrieval-evidence-insufficient' };
  if (/BUILT\/SHIPPED CLAIM:\s*NOT PROVEN/i.test(answer)) {
    return { usable: false, reason: 'required-implementation-unproven' };
  }
  return { usable: true, reason: null };
}
