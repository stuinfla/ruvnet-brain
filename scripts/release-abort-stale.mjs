#!/usr/bin/env node
/**
 * ABORT AN ABANDONED RELEASE TRANSACTION — the recovery path the rail was missing.
 *
 * WHY (issue #77, 2026-08-07). `runReleaseTransaction` refuses to start while any OTHER
 * transaction has a non-terminal latest receipt:
 *
 *     Error: pending release b2ac9b69… blocks 566dcda4…
 *
 * The v4.0.7 transaction stopped at `npm-stage-intent` and never reached a terminal state. Until
 * today `aborted` was in TERMINAL_STATES but no transition led to it, and the only other exit,
 * `manual-intervention-required`, has no outgoing transitions and is NOT terminal — so an
 * interrupted release permanently blocked every future one. npm was later hand-moved to 4.0.12,
 * which also disqualified the provider's `settled` escape hatch (it needs receipt.version ===
 * npmLatest). The rail had deadlocked itself, hand-publishing became the only way to ship, and
 * hand-publishing is exactly how npm and GitHub came to name different generations.
 *
 * WHAT THIS IS NOT. It publishes nothing, moves no dist-tag, and touches no bundle. It appends ONE
 * signed receipt recording that an abandoned transaction is abandoned. The receipt is signed with
 * the same key and chained with the same digest linkage as every other receipt, so the audit chain
 * stays verifiable — this is bookkeeping, told truthfully, not a way around a gate.
 *
 * SAFETY. Refuses unless the target's latest receipt is genuinely non-terminal, refuses to abort a
 * transaction whose identity matches a release that actually converged, and requires the tag to be
 * named explicitly. `aborted` is terminal, so an aborted transaction can never resume and claim to
 * have shipped.
 *
 *   node scripts/release-abort-stale.mjs --tag v4.0.7 --reason "..."          # report only
 *   node scripts/release-abort-stale.mjs --tag v4.0.7 --reason "..." --apply  # write the receipt
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RECEIPT_PREFIX, TERMINAL_STATES, ALLOWED_TRANSITIONS, canonicalJson, digestReceipt, signReceipt,
} from './release-transaction.mjs';

const REPO = 'stuinfla/ruvnet-brain';
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const TAG = arg('--tag');
const REASON = arg('--reason') || 'abandoned release transaction closed during #77 recovery';
const log = (s) => process.stdout.write(`[abort-stale] ${s}\n`);
const die = (s) => { process.stderr.write(`[abort-stale] REFUSED: ${s}\n`); process.exit(1); };

if (!TAG) die('--tag <vX.Y.Z> is required; this never guesses which transaction to close');

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 120_000 });
const releases = JSON.parse(gh(['api', `repos/${REPO}/releases`, '--paginate']));
const release = releases.find((r) => r.tag_name === TAG);
if (!release) die(`no release tagged ${TAG}`);

const receiptAssets = (release.assets || [])
  .filter((a) => a.name.startsWith(RECEIPT_PREFIX) && a.name.endsWith('.json'));
if (!receiptAssets.length) die(`${TAG} carries no transaction receipts — nothing to abort`);

const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const fetchAsset = (a) => JSON.parse(execFileSync('curl', [
  '-sL', '-H', 'Accept: application/octet-stream', '-H', `Authorization: token ${token}`, a.url,
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

const receipts = receiptAssets.map(fetchAsset).sort((a, b) => a.sequence - b.sequence);
const last = receipts.at(-1);
log(`${TAG}: ${receipts.length} receipt(s), latest seq=${last.sequence} state=${last.state} txn=${String(last.transactionId).slice(0, 16)}…`);

if (TERMINAL_STATES.has(last.state)) {
  log(`already terminal (${last.state}) — nothing to do.`);
  process.exit(0);
}
if (!(ALLOWED_TRANSITIONS[last.state] || []).includes('aborted')) {
  die(`state ${last.state} may not transition to aborted (this is the state machine's call, not mine)`);
}

// Never abort something that actually shipped and simply failed to record it.
const npmLatest = execFileSync('npm', ['view', 'ruvnet-brain@latest', 'version'], { encoding: 'utf8' }).trim();
const ghLatest = JSON.parse(gh(['api', `repos/${REPO}/releases/latest`])).tag_name;
if (last.identity?.version === npmLatest && last.identity?.tag === ghLatest) {
  die(`${TAG} IS the currently published generation on both channels — that is a converged release, not an abandoned one`);
}
log(`published now: npm=${npmLatest} github=${ghLatest} — ${TAG} is not the live generation, so it is genuinely abandoned`);

if (!APPLY) {
  log('report-only. Re-run with --apply to append the signed abort receipt.');
  process.exit(0);
}

const keyPath = process.env.RUVNET_SIGNING_KEY_FILE
  || path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), '.secrets', 'ruvnet-brain-signing.key.pem');
const privateKey = process.env.RUVNET_SIGNING_KEY
  ? crypto.createPrivateKey(process.env.RUVNET_SIGNING_KEY)
  : crypto.createPrivateKey(fs.readFileSync(keyPath));

const receipt = signReceipt({
  schemaVersion: 2,
  transactionId: last.transactionId,
  sequence: last.sequence + 1,
  previousReceiptDigest: last.receiptDigest || null,
  state: 'aborted',
  identity: last.identity,
  observation: { reason: REASON, abortedFrom: last.state, recoveredBy: 'scripts/release-abort-stale.mjs' },
  createdAt: new Date().toISOString(),
}, privateKey);

const name = `${RECEIPT_PREFIX}${String(receipt.sequence).padStart(4, '0')}.json`;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'abort-')), name);
fs.writeFileSync(tmp, `${canonicalJson(receipt)}\n`);
gh(['release', 'upload', TAG, tmp, '--repo', REPO, '--clobber']);
log(`appended ${name} (state=aborted, seq=${receipt.sequence}, digest=${digestReceipt(receipt).slice(0, 16)}…)`);
log('the transaction is now terminal; it can never resume or claim to have shipped.');
