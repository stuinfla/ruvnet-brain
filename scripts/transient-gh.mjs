// DISTINCT-FROM: kb/download-retry.mjs — that retries the customer updater's HTTPS stream by error code; this
// classifies and retries the pipeline's `gh`/`git` subprocess reads by what they printed.
//
// scripts/transient-gh.mjs — ONE rule for what a transient GitHub/API/git failure looks like, and ONE bounded
// retry for it, shared by every read in the corpus nightly (ADR-0091, fault classes in CONTRIBUTING.md).
//
// THE FAILURE THIS EXISTS TO END (measured on 38 corpus nights, 2026-09-21 .. 2026-10-18). Twenty-four nights
// failed; the causes were a gist API rate limit, a publisher that could not re-read the release it had just
// created, a canary refused one anonymous read, a git credential prompt on a clone -- each a single blip at a
// single `gh`/`git`/`fetch` call, each unretried, each the whole night for every customer. Before this module
// every call site either had no retry or its own private idea of "transient" (the canary's status set, the
// gist transport's regexes, the reconciler's exit-status classes). The rule is now written once:
//
//   TRANSIENT  a rate limit (primary or secondary), HTTP 429/408/5xx, a connection reset/refused/timed out, a
//              DNS hiccup, a TLS handshake failure, a hung-up socket, git's credential prompt on an anonymous
//              fetch ("could not read Username"), a partial transfer ("early EOF", "RPC failed").
//   NOT        HTTP 404/410 (gone: the ifGone carry in source-coverage.mjs owns it), a bare HTTP 403 from an
//              authenticated gh (a permission answer, e.g. "Resource not accessible by integration"), "release
//              not found" (the publisher's absence proof), a signature, digest or schema refusal, a missing
//              binary (ENOENT). Those are answers, not weather; retrying them only delays the honest failure.
//
// Anonymous `fetch` reads from a shared runner address are the one place a bare 403 IS transient (GitHub's
// per-IP throttle answers 403): that status set, TRANSIENT_HTTP, lives here too so the canary and any other
// anonymous reader share it rather than restating it.
//
// WRITES ARE NEVER RETRIED BLINDLY. `gh release create` uploads assets; a retry after a half-finished create
// collides with the release it left behind. `retryingGh` retries reads and idempotent edits only; a create or
// any `gh api` POST/PUT/PATCH/DELETE runs exactly once and reports what happened.

/** Anonymous-fetch statuses a shared runner address sees for a moment (GitHub throttles anonymous reads with 403). */
export const TRANSIENT_HTTP = new Set([403, 408, 429, 500, 502, 503, 504]);

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 15_000;
/** The wait before retry `n` is `base * n`. RUVNET_TRANSIENT_RETRY_DELAY_MS is the test seam (the suite sets 0 so a
 * fake gh that answers "gateway timeout" fails in milliseconds, not after the 45 s a real night would wait). */
export function defaultBaseDelayMs(fallback = DEFAULT_BASE_DELAY_MS) {
  const seam = Number(process.env.RUVNET_TRANSIENT_RETRY_DELAY_MS);
  return Number.isFinite(seam) && seam >= 0 && process.env.RUVNET_TRANSIENT_RETRY_DELAY_MS !== undefined ? seam : fallback;
}

const TRANSIENT_TEXT = /\brate limit|secondary rate|abuse detection|HTTP (408|429|5\d\d)\b|\b(500|502|503|504) (Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|connection reset|connection refused|timed out|timeout|TLS handshake|socket hang up|could not resolve host|no such host|dial tcp|i\/o timeout|unexpected EOF|early EOF|RPC failed|remote end hung up|could not read Username|unable to access|temporarily unavailable|temporary failure/i;

/** What a failed subprocess said -- stderr, then stdout, then the spawn error -- as one string for classification. */
export function failureText(result) {
  return [result?.stderr, result?.stdout, result?.error?.message].map((part) => String(part ?? '')).join('\n');
}

/** The one classifier: true when the text describes weather, not an answer. A missing binary is never weather. */
export function isTransientText(text) {
  const message = String(text ?? '');
  if (/\bENOENT\b/.test(message)) return false;
  return TRANSIENT_TEXT.test(message);
}

/** A spawnSync-shaped result that failed transiently. */
export function isTransientResult(result) {
  if (!result) return false;
  if (!result.error && result.status === 0) return false;
  if (result.error?.code === 'ENOENT') return false;
  return isTransientText(failureText(result));
}

/** Blocks the thread for `ms`; the pipeline's gh/git callers are synchronous spawnSync loops. Injectable in tests. */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const delayFor = (attempt, baseDelayMs) => baseDelayMs * attempt;

/**
 * Run `fn` (which THROWS on failure) up to `attempts` times while the failure is transient, waiting
 * baseDelayMs * attempt between tries. The last error is rethrown unchanged, so callers keep their own messages.
 */
export function retryTransient(fn, { attempts = DEFAULT_ATTEMPTS, baseDelayMs = defaultBaseDelayMs(), sleep = sleepSync,
  isTransient = (error) => isTransientText(error?.message), onRetry = () => {} } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      onRetry({ attempt, error, delayMs: delayFor(attempt, baseDelayMs) });
      sleep(delayFor(attempt, baseDelayMs));
    }
  }
}

/** The async twin of retryTransient, for callers whose work (or sleep) is a promise. */
export async function retryTransientAsync(fn, { attempts = DEFAULT_ATTEMPTS, baseDelayMs = defaultBaseDelayMs(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  isTransient = (error) => isTransientText(error?.message), onRetry = () => {} } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      onRetry({ attempt, error, delayMs: delayFor(attempt, baseDelayMs) });
      await sleep(delayFor(attempt, baseDelayMs));
    }
  }
}

/**
 * Run `fn` (which RETURNS a spawnSync-shaped result, never throws) up to `attempts` times while the result is a
 * transient failure. Returns the last result, so callers that read `status`/`stderr` keep doing exactly that.
 */
export function retryTransientResult(fn, { attempts = DEFAULT_ATTEMPTS, baseDelayMs = defaultBaseDelayMs(),
  sleep = sleepSync, onRetry = () => {} } = {}) {
  let result;
  for (let attempt = 1; ; attempt += 1) {
    result = fn(attempt) || {};
    if (attempt >= attempts || !isTransientResult(result)) return result;
    onRetry({ attempt, result, delayMs: delayFor(attempt, baseDelayMs) });
    sleep(delayFor(attempt, baseDelayMs));
  }
}

const GH_WRITE_VERBS = new Set(['create', 'delete', 'upload', 'delete-asset']);
const REST_WRITE_FLAGS = new Set(['-f', '-F', '--input', '--field', '--raw-field']);
const METHOD_FLAGS = new Set(['-X', '--method']);

/**
 * Is this `gh` argument vector a write that must run exactly once? `release edit` is an idempotent PATCH and is
 * NOT a write here: re-sending the same flags after a timeout converges on the same state. `gh api` is a write
 * when it names a non-GET method or carries a field flag (gh then sends POST); `gh api graphql` always POSTs.
 */
export function isGhWrite(args) {
  const argv = (args || []).map(String);
  if (argv[0] === 'api') {
    const methodAt = argv.findIndex((token) => METHOD_FLAGS.has(token));
    if (methodAt >= 0 && String(argv[methodAt + 1] || '').toUpperCase() !== 'GET') return true;
    if (argv[1] === 'graphql') return true;
    return argv.some((token) => REST_WRITE_FLAGS.has(token));
  }
  return argv[0] === 'release' && GH_WRITE_VERBS.has(argv[1]);
}

/**
 * A `gh` runner over a spawnSync-shaped `run` that retries transient failures of READS and idempotent edits,
 * bounded, and runs a write exactly once. `prefix` is the RUVNET_GH_SCRIPT test seam (scripts/release.mjs).
 */
export function retryingGh({ run, command = 'gh', prefix = [], options = {}, sleep = sleepSync, attempts = DEFAULT_ATTEMPTS,
  baseDelayMs = defaultBaseDelayMs(), onRetry = () => {} } = {}) {
  if (typeof run !== 'function') throw new Error('retryingGh needs a spawnSync-shaped run function');
  return (args) => {
    const once = () => run(command, [...prefix, ...args], options) || {};
    if (isGhWrite(args)) return once();
    return retryTransientResult(once, { attempts, baseDelayMs, sleep, onRetry: (event) => onRetry({ ...event, args }) });
  };
}
