// kb/corpus-release-identity.mjs — the customer side of a corpus-only release (ADR-086 step 16).
//
// TWO IDENTITY DOMAINS, AND WHY CONFLATING THEM COST A NIGHTLY HALF-GIGABYTE.
//
// A customer bundle carries a RUNTIME identity: `brainVersion` / `releaseTag` in SOURCE.json,
// stamped by scripts/build-bundle.mjs:333-334 as the semver of the code release that assembled it.
// A CORPUS release carries a TRANSPORT identity: the GitHub tag `corpus-sha256-<64 hex>`, which is
// a content address of the corpus archive and is not a version of anything.
//
// kb/forge-update.mjs's isBehind() treated release-tag identity as authoritative with one string
// inequality. Measured on this fixture before this module existed (4 consecutive `--apply` runs
// against ONE unchanged corpus release):
//
//     apply#1: exit=0 zipDownloads=1 behindReported=true
//     apply#2: exit=0 zipDownloads=2 behindReported=true
//     apply#3: exit=0 zipDownloads=3 behindReported=true
//     apply#4: exit=0 zipDownloads=4 behindReported=true
//     check:   exit=10 zipDownloads=4 behindReported=true
//
// `'corpus-sha256-aaa…' !== 'v4.9.0'` is true, and it stays true after a perfectly successful
// install, because the landed bundle re-stamps `releaseTag: v4.9.0`. The comparison could never
// converge. So the transport identity is recorded in its OWN field, `corpusReleaseTag`, written
// atomically with the installation, and compared only against a corpus tag.
//
// THE COMPATIBILITY BOUNDARY (Dual, verbatim): "One releases/latest pointer cannot represent
// independent newest corpora for multiple incompatible runtimes. Either explicitly support the
// current approved runtime with safe rejection for older clients, or add version-aware discovery.
// Never silently install incompatible code."
//
// And on how the pin must hold (Dual, verbatim): "Pinning survives only through enforced equality
// to the approved shipped runtime and its executable hashes. Copying current-main package.json or
// preserving a version string alone is insufficient."
//
// Hence RUNTIME-IDENTITY.json. It is written by bin/install.mjs — the owner-gated code release —
// and names the sha256 of the executables that release placed into the KB tree. It is NEVER
// produced by a bundle: build-bundle.mjs cannot see coverage-integrity.mjs (it is behind the
// updater's dynamic load), which is precisely why that file is the right thing to pin to. The
// updater re-hashes those bytes at update time; a declared version alone proves nothing and is
// never sufficient on its own.
//
// FAIL-CLOSED, ALWAYS. Missing identity file, unreadable identity file, missing executable,
// changed executable, or a corpus release built by a different runtime → the corpus release is
// REFUSED. A client that cannot prove which approved runtime it is running does not get a corpus
// release; it keeps the bundle it has and is told to re-run the installer.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** The corpus transport tag shape published by scripts/corpus-seed-publish.mjs's corpusSeedTag(). */
export const CORPUS_TAG_PATTERN = /^corpus-sha256-[0-9a-f]{64}$/;

// CODE_TAG_PATTERN / releaseKind / CORPUS_GENERATION_FIELD / parseCorpusGeneration below are literal
// copies of scripts/release-channel-kind.mjs and scripts/corpus-promotion.mjs. This module SHIPS
// standalone inside the distributed KB bundle (kb/forge-update.mjs's only imports are siblings in
// this same directory — see the fixtures in tests/unit/*-apply-rollback.test.mjs, which copy exactly
// the kb/*.mjs files a real bundle carries); `scripts/` is build/release tooling that never ships.
// CORPUS_TAG_PATTERN above is already duplicated this same way for the same reason. Keep both copies
// byte-identical in behavior; tests/unit/corpus-release-identity-channel-parity.test.mjs pins that.

/** Product (code) release: a plain semver tag. */
export const CODE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

export function releaseKind(tag) {
  const value = String(tag ?? '');
  if (CORPUS_TAG_PATTERN.test(value)) return 'corpus';
  if (CODE_TAG_PATTERN.test(value)) return 'code';
  return 'other';
}

/** The author-side ordering key field name for a corpus release's `releases/latest` promotion
 * (scripts/corpus-promotion.mjs's CORPUS_GENERATION_FIELD) — S2 reuses it as the client-side
 * ordering key so promotion and currency comparisons can never disagree about what "generation"
 * means. */
export const CORPUS_GENERATION_FIELD = 'Corpus generation:';

/** Parse the `Corpus generation:` line out of a release's body/notes text, exactly as
 * scripts/corpus-promotion.mjs's evaluateCorpusPromotion does for publish-time ordering. Returns
 * `{ value, epoch }` (the raw string and its parsed epoch) or null when absent/unparseable. */
export function parseCorpusGeneration(body) {
  const line = String(body || '').split('\n').map((row) => row.trim())
    .find((row) => row.startsWith(CORPUS_GENERATION_FIELD));
  if (!line) return null;
  const value = line.slice(CORPUS_GENERATION_FIELD.length).trim();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { value, epoch: parsed } : null;
}

/** The installer-written record of which approved runtime this KB belongs to. */
export const INSTALLED_RUNTIME_FILE = 'RUNTIME-IDENTITY.json';

/**
 * Executables the runtime pin is bound to, relative to the KB root.
 *
 * `coverage-integrity.mjs` is the trusted coverage validator. It is placed by the installer
 * (bin/install.mjs placeTrustedCoverageValidator) and CANNOT be supplied by a bundle, so its bytes
 * are a real, non-spoofable fingerprint of the approved shipped runtime on this machine. Adding
 * more installer-placed executables here widens the pin; nothing else needs to change.
 */
export const RUNTIME_PINNED_EXECUTABLES = Object.freeze(['coverage-integrity.mjs']);

/** Where a refused release is remembered — OUTSIDE the governed tree, so an update cannot erase it. */
export const REJECTED_RELEASE_FILE = '.ruvnet-brain-rejected-release.json';

export function isCorpusReleaseTag(tag) {
  return typeof tag === 'string' && CORPUS_TAG_PATTERN.test(tag);
}

function fileIdentity(file) {
  try {
    const bytes = fs.readFileSync(file);
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  } catch {
    return null;
  }
}

function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/**
 * Stamp "this tree belongs to approved runtime X, and here are X's executable hashes" into `kbDir`.
 *
 * Called by the installer immediately after it places those executables, so the declared version and
 * the measured bytes are written from the same moment and cannot disagree.
 *
 * @returns {{written: boolean, path: string, missing: string[]}}
 */
export function writeInstalledRuntimeIdentity(kbDir, { brainVersion }) {
  if (!brainVersion || typeof brainVersion !== 'string') {
    throw new Error('writeInstalledRuntimeIdentity requires the approved runtime brainVersion');
  }
  const executables = {};
  const missing = [];
  for (const relative of RUNTIME_PINNED_EXECUTABLES) {
    const identity = fileIdentity(path.join(kbDir, relative));
    if (!identity) { missing.push(relative); continue; }
    executables[relative] = identity;
  }
  const target = path.join(kbDir, INSTALLED_RUNTIME_FILE);
  // A pin naming an executable that is not there would be a pin to nothing. Refuse to write one.
  if (missing.length) return { written: false, path: target, missing };
  atomicJson(target, {
    schemaVersion: 1,
    kind: 'ruvnet-brain-installed-runtime',
    brainVersion,
    stampedUtc: new Date().toISOString(),
    executables,
  });
  return { written: true, path: target, missing };
}

/**
 * Read the installed approved runtime and RE-HASH every executable it pins.
 *
 * The declared `brainVersion` is only ever returned alongside proof that the bytes it was written
 * against are still the bytes on disk — that is the whole difference between an enforced pin and a
 * copied version string.
 *
 * @returns {{ok: boolean, brainVersion: string|null, reason: string|null}}
 */
export function readInstalledRuntime(kbDir) {
  const file = path.join(kbDir, INSTALLED_RUNTIME_FILE);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    return { ok: false, brainVersion: null,
      reason: `no installed runtime identity at ${INSTALLED_RUNTIME_FILE} (${error.code === 'ENOENT' ? 'absent' : error.message})` };
  }
  if (doc?.schemaVersion !== 1 || doc?.kind !== 'ruvnet-brain-installed-runtime'
    || typeof doc.brainVersion !== 'string' || !doc.brainVersion || !doc.executables) {
    return { ok: false, brainVersion: null, reason: `${INSTALLED_RUNTIME_FILE} is not a readable installed-runtime record` };
  }
  const declared = Object.keys(doc.executables).sort();
  const expected = [...RUNTIME_PINNED_EXECUTABLES].sort();
  if (declared.join('\0') !== expected.join('\0')) {
    return { ok: false, brainVersion: null,
      reason: `${INSTALLED_RUNTIME_FILE} pins [${declared.join(', ')}], this runtime requires [${expected.join(', ')}]` };
  }
  for (const relative of expected) {
    const measured = fileIdentity(path.join(kbDir, relative));
    const pinned = doc.executables[relative];
    if (!measured) {
      return { ok: false, brainVersion: null, reason: `pinned runtime executable ${relative} is missing` };
    }
    if (measured.sha256 !== pinned?.sha256 || measured.bytes !== pinned?.bytes) {
      return { ok: false, brainVersion: null,
        reason: `pinned runtime executable ${relative} does not match its approved bytes `
          + `(approved ${String(pinned?.sha256).slice(0, 12)}…/${pinned?.bytes}B, on disk ${measured.sha256.slice(0, 12)}…/${measured.bytes}B)` };
    }
  }
  return { ok: true, brainVersion: doc.brainVersion, reason: null };
}

/**
 * Decide whether this client may install the release now staged/offered.
 *
 * `offeredRuntimeVersion` is the brainVersion the candidate bundle declares — read from a STAGED
 * tree that has already passed signature verification, never from the release payload's prose.
 *
 * @returns {{ok: boolean, reason: string|null, installedRuntime: string|null}}
 */
export function assertCorpusReleaseCompatible({ kbDir, offeredRuntimeVersion = null }) {
  const runtime = readInstalledRuntime(kbDir);
  if (!runtime.ok) return { ok: false, reason: runtime.reason, installedRuntime: null };
  if (offeredRuntimeVersion == null) return { ok: true, reason: null, installedRuntime: runtime.brainVersion };
  if (offeredRuntimeVersion !== runtime.brainVersion) {
    return { ok: false, installedRuntime: runtime.brainVersion,
      reason: `this corpus release was built by runtime ${offeredRuntimeVersion}; `
        + `this brain runs approved runtime ${runtime.brainVersion}` };
  }
  return { ok: true, reason: null, installedRuntime: runtime.brainVersion };
}

/**
 * Record the authenticated transport identity of the bytes now being installed, IN the tree being
 * installed — so promotion carries it or nothing is promoted. The runtime identity fields
 * (`brainVersion` / `releaseTag`) are never touched: they describe the code that built the bundle,
 * and a corpus tag is not a version of that code.
 */
export function recordCorpusTransportIdentity(treeDir, { releaseTag }) {
  const file = path.join(treeDir, 'SOURCE.json');
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  // STRICTLY IDEMPOTENT, AND THAT IS NOT A STYLE CHOICE. A promoted tree's byte identity is what
  // the storage transaction compares to decide `noop` vs `applied` — the distinction issue #106 and
  // #108 were fought over. Rewriting SOURCE.json to set a field to the value it already holds (or
  // to delete keys that were never there) re-serializes the file and changes its bytes, which turns
  // a genuine no-op into a spurious "applied" and strands a rollback copy. So: touch the file only
  // when a field actually changes. For the same reason there is no install timestamp here — a
  // clock-valued field would differ on every run and could never be byte-identical. The tag IS the
  // identity; `builtUtc` already carries the time.
  if (isCorpusReleaseTag(releaseTag)) {
    if (source.corpusReleaseTag === releaseTag) return source;
    source.corpusReleaseTag = releaseTag;
  } else {
    // An ordinary code release supersedes whatever corpus generation preceded it: its bundle IS the
    // corpus. Leaving a stale corpus tag behind would make the next check compare against a corpus
    // this tree no longer holds.
    if (!Object.hasOwn(source, 'corpusReleaseTag')) return source;
    delete source.corpusReleaseTag;
  }
  atomicJson(file, source);
  return source;
}

/**
 * Record the ordering key a corpus release's generation is compared by (S2, corpus-currency gate).
 * Written IN the tree being installed, next to `recordCorpusTransportIdentity` (same caller, same
 * candidate directory, same atomic rename into place) so a crash between the two can never leave a
 * tree whose transport tag and generation ordering key disagree.
 *
 * `generation` is read from the CANDIDATE release's own published record — parseCorpusGeneration
 * against the release body's `Corpus generation:` line (scripts/corpus-promotion.mjs), the same
 * field that is already the sole author-side ordering key for `releases/latest` promotion. It is
 * never invented locally and never derived from a local clock: kb/forge-update.mjs's isBehind()
 * history (this file's header) is the standing lesson in why a locally-observed timestamp can never
 * safely stand in for an authenticated ordering key.
 *
 * IDEMPOTENT for the same reason recordCorpusTransportIdentity is (see its comment): touch the file
 * only when the field's value actually changes, or a byte-identical re-apply reads as `applied`
 * instead of `noop` and strands a rollback copy.
 */
export function recordCorpusGenerationIdentity(treeDir, { corpusReleaseTag, generation }) {
  const file = path.join(treeDir, 'SOURCE.json');
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (isCorpusReleaseTag(corpusReleaseTag) && typeof generation === 'string' && generation) {
    if (source.corpusGeneration === generation) return source;
    source.corpusGeneration = generation;
  } else {
    // No generation identity to record for this candidate — an ordinary code release, or a corpus
    // release whose published record carries no readable ordering key. Never leave a PRIOR
    // generation stamped: a code release supersedes it outright (its bundle IS the corpus), and a
    // corpus candidate that declares no generation of its own must not leave behind a number that no
    // longer describes what is actually on disk — the next comparison must read UNKNOWN, not compare
    // against a generation this tree no longer holds.
    if (!Object.hasOwn(source, 'corpusGeneration')) return source;
    delete source.corpusGeneration;
  }
  atomicJson(file, source);
  return source;
}

// ── the anti-loop ledger ────────────────────────────────────────────────────────────────────────
// A refusal that is rediscovered every night is a download loop with extra steps. The refused tag
// is remembered next to the KB (never inside it, where an update would replace it), so the very
// next run refuses BEFORE fetching a byte. It is cleared the moment a different release is offered.

export function rejectedReleasePath(kbDir) {
  return path.join(path.dirname(path.resolve(kbDir)), REJECTED_RELEASE_FILE);
}

export function readRejectedRelease(kbDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(rejectedReleasePath(kbDir), 'utf8'));
    return typeof doc?.tag === 'string' && doc.tag ? doc : null;
  } catch { return null; }
}

export function writeRejectedRelease(kbDir, { tag, reason, installedRuntime = null }) {
  try {
    atomicJson(rejectedReleasePath(kbDir), { schemaVersion: 1, kind: 'ruvnet-brain-rejected-release',
      tag, reason, installedRuntime, rejectedUtc: new Date().toISOString() });
    return true;
  } catch { return false; } // never let bookkeeping mask the refusal itself
}

export function clearRejectedRelease(kbDir) {
  try { fs.rmSync(rejectedReleasePath(kbDir), { force: true }); return true; } catch { return false; }
}
