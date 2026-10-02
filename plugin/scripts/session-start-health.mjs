#!/usr/bin/env node
// session-start-health.mjs — the three LOCAL installation-health reads SessionStart's banner depends
// on: is the brain turned off, is the knowledge cache actually usable, and is the MCP worker alive.
// Extracted 2026-09-11 out of session-start-core.mjs to keep that file under 500 lines; behavior is
// unchanged from the original inline functions.
//
// These are the checks behind the 🚨 HEALTH ALARM and the RETRIEVAL-DOWN banner — LOCAL installation
// integrity, not maintainer-only content. Per the 2026-09-11 reviewer correction, everything read
// here is delivered to every user via SessionStart's existing always-shown alarm/banner lines,
// worded for the user — never gated behind the maintainer entitlement file.
import fs from 'node:fs';
import path from 'node:path';
import { json, exists, mtimeMs, read } from './session-start-fsutil.mjs';
import { unmountedNotice } from './brain-location.mjs';
import { assessMoveLeftovers } from './footprint-io.mjs';
import {
  describeFailedRefreshRun, readNightlyRegistration, refreshHistory, updateOwnedByAgenticKit,
} from './nightly-scheduler.mjs';

export const brainState = (env, home) => {
  const stateDir = env.RUVNET_BRAIN_STATE_DIR || path.join(home, '.config', 'ruvnet-brain');
  const file = path.join(stateDir, 'brain-off');
  let off = env.RUVNET_BRAIN_OFF === '1';
  if (!off) {
    try { fs.statSync(file); off = true; }
    catch (error) { off = !(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')); }
  }
  let since = '';
  if (off) {
    const record = json(file);
    if (typeof record?.since === 'string') since = record.since.slice(0, 10);
    if (!since && mtimeMs(file)) since = new Date(mtimeMs(file)).toISOString().slice(0, 10);
  }
  return { off, since, stateDir, file };
};

// An interrupted --move-brain may hold the ONLY Brain at <home>.old-<pid>: "reinstall" there would build a
// second, public-only Brain beside it (4.5.2). Names only; consulted only when the KB is missing or empty.
const restoreNotice = (home) => {
  try {
    const lo = assessMoveLeftovers({ brainHome: path.join(home, '.cache', 'ruvnet-brain') }).find((l) => l.onlyCopy);
    return lo ? `the Brain is not at its path — an interrupted move left the ONLY copy at ${lo.path}; restore it, do NOT reinstall: ${lo.fix}` : '';
  } catch { return ''; }
};

export const health = (home, off) => {
  // Moved to another disk that is not plugged in: say exactly that — not "MISSING, reinstall", which
  // would re-create a fresh brain in ~/.cache over the link. A problem also stands the self-heal down.
  const unmounted = unmountedNotice({ home });
  if (unmounted) return { problem: unmounted, absentByChoice: false };
  const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
  let rvf = false;
  // `._x.rvf` is macOS AppleDouble from an exFAT/FAT volume, not a store.
  try { rvf = fs.readdirSync(kb).some((name) => name.endsWith('.rvf') && !name.startsWith('._') && exists(path.join(kb, name))); }
  catch { /* absent */ }
  const absentByChoice = off && (!exists(kb) || !rvf);
  if (absentByChoice) return { problem: '', absentByChoice };
  if (!exists(kb)) return { problem: restoreNotice(home) || `the brain cache directory is MISSING (${kb}) — reinstall: npx github:stuinfla/ruvnet-brain`, absentByChoice };
  if (!rvf) return { problem: restoreNotice(home) || `NO vector stores (.rvf) found in ${kb} — the brain is empty; reinstall: npx github:stuinfla/ruvnet-brain --force`, absentByChoice };
  if (!exists(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'))) {
    return { problem: `reader dependencies are MISSING (node_modules gone) — every search WILL fail. Fix: cd ${kb} && npm i`, absentByChoice };
  }
  const last = json(path.join(home, '.cache', 'ruvnet-brain', 'health.json'));
  if (last?.status === 'down') {
    const detail = `"error": ${JSON.stringify(String(last.error || 'unknown error'))}`.slice(0, 180);
    return { problem: `the last real search FAILED across all repos (${detail}). Fix: cd ${kb} && npm i, then run one search to clear the alarm`, absentByChoice };
  }
  return { problem: '', absentByChoice };
};

/**
 * KNOWLEDGE CURRENCY — "never silent for 40 days" (owner, 2026-09-30). The installed knowledge base
 * on the owner's Mac was 35 days old with the nightly refresh failing 22/22 times, and the only
 * trace was a "Corpus snapshot ages" footnote inside search output. This returns ONE plain line, or
 * '' when currency is PROVEN. Reuses the existing readers only: refresh receipts
 * (nightly-scheduler.mjs refreshHistory + describeFailedRefreshRun), the scheduler registration
 * (readNightlyRegistration), agentic-kit ownership, SOURCE.json builtUtc, and the heartbeat's
 * recorded --check verdict. Currency is PROVEN only by a successful refresh or a CURRENT verdict
 * inside 48h; anything unreadable stays UNKNOWN in the words, never "current".
 */
export const KNOWLEDGE_LINE_PREFIX = '[RuvNet Brain — KNOWLEDGE ';

// The SessionStart knowledge auto-update's own per-machine state (session-start-update-plane.mjs
// writes it, host-update.mjs --knowledge records the outcome). Deliberately NOT inside refresh-runs/:
// kb/lifecycle-evidence-retention.mjs scanRefresh() marks any non-receipt entry there "unsafe" and
// then refuses to prune, so a sidecar file would silently stop receipt retention.
export const autoUpdatePaths = (brainHome) => ({
  attemptFile: path.join(brainHome, 'auto-update.json'),
  lockFile: path.join(brainHome, 'auto-update.lock'),
  logFile: path.join(brainHome, '.last-auto-update-knowledge.log'),
  // The newer-published identity check (2026-10-02): its own throttle + outcome record, never the update
  // attempt file (a check is not an update; it must not reset the 6h retry or read as an abandoned launch).
  checkFile: path.join(brainHome, 'corpus-check.json'),
  checkResultFile: path.join(brainHome, '.last-kb-check-result.json'),
});
export const AUTO_UPDATE_LOCK_STALE_MS = 35 * 60_000; // detach TTL (30 min) + slack

/** The inputs every currency decision reads — one reader, shared by the line and the auto-update. */
export const knowledgeFacts = ({ env = process.env, home, now = Date.now() } = {}) => {
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  const kbDir = env.RUVNET_BRAIN_KB || path.join(brainHome, 'kb');
  const hours = (ms) => (now - ms) / 3_600_000;
  const source = json(path.join(kbDir, 'SOURCE.json'));
  const builtMs = Date.parse(source?.builtUtc || source?.generatedAt || '');
  const history = refreshHistory({ brainHome });
  const check = json(path.join(brainHome, '.last-kb-check-result.json'));
  const checkMs = Date.parse(check?.recordedAt || '');
  const auto = autoUpdatePaths(brainHome);
  const provenWithin = (h) => Boolean((history.lastSuccess && hours(history.lastSuccess.at) <= h)
    || (check?.currencyVerdict === 'CURRENT' && Number.isFinite(checkMs) && hours(checkMs) <= h));
  return { brainHome, kbDir, source, builtMs, history, hours, provenWithin, auto,
    attempt: json(auto.attemptFile), corpusCheck: json(auto.checkFile),
    lockMs: Date.parse(json(auto.lockFile)?.at || '') || mtimeMs(auto.lockFile) };
};

/**
 * agentic-kit ownership is a CLAIM in kit.json, not a delivery: on the owner's Mac (2026-09-30)
 * kit.json said ruvnetBrain:true while agentic-kit scheduled nothing, so the self-heal stood down
 * forever and the knowledge base aged by hand only. Ownership is honoured only while an update is
 * PROVEN inside this window (a successful refresh receipt or a CURRENT --check verdict); 36h leaves
 * the self-heal 12h to land one before the 48h invariant breaks.
 */
export const AGENTIC_KIT_PROOF_HOURS = 36;
/** 'none' | 'delivering' (kit.json claims it AND an update is proven) | 'not-delivering'. */
export const agenticKitUpdates = ({ home, facts }) => {
  if (!updateOwnedByAgenticKit(home)) return 'none';
  return facts.provenWithin(AGENTIC_KIT_PROOF_HOURS) ? 'delivering' : 'not-delivering';
};

/** Why the SessionStart knowledge auto-update may NEVER run on this machine ('' = it may). */
export const autoUpdateOptOut = ({ env = process.env, home, facts }) => {
  const flag = String(env.RUVNET_AUTO_UPDATE || '').toLowerCase();
  if (flag === 'off') return 'RUVNET_AUTO_UPDATE=off';
  if (env.RUVNET_BRAIN_TEST === '1' && flag !== 'on') return 'test mode';
  if (read(path.join(facts.brainHome, '.auto-update-pref')).trim() === 'no') return 'you answered no to background auto-update';
  if (agenticKitUpdates({ home, facts }) === 'delivering') {
    return `agentic-kit owns updates and one is proven within ${AGENTIC_KIT_PROOF_HOURS}h: ak sync`;
  }
  if (!exists(path.join(facts.kbDir, 'forge-update.mjs'))) return 'this install predates the self-updater';
  return '';
};

/**
 * A newer corpus is PUBLISHED and not yet installed — decided by identity, never by age: the last
 * recorded --if-newer check found a release whose tag is newer (UPDATE_AVAILABLE, or UNKNOWN when the
 * installed tree carries no generation stamp) and that tag is not what SOURCE.json now names. A check
 * recorded before the update landed therefore stops reading as pending the moment B is installed.
 */
export const newerCorpusPending = (facts) => {
  const c = facts.corpusCheck;
  if (!c?.candidateTag || !['UPDATE_AVAILABLE', 'UNKNOWN'].includes(c.verdict)) return null;
  const installed = [facts.source?.corpusReleaseTag, facts.source?.releaseTag].filter(Boolean);
  if (installed.includes(c.candidateTag)) return null;
  return { tag: c.candidateTag, installed: installed[0] || null, checkedAt: c.checkedAt || c.launchedAt || null, outcome: c.outcome };
};
const shortTag = (tag) => (tag && tag.length > 28 ? `${tag.slice(0, 26)}…` : tag || 'unknown');

export const knowledgeCurrency = ({ env = process.env, home, now = Date.now(), windowHours = 48 } = {}) => {
  const facts = knowledgeFacts({ env, home, now });
  const { brainHome, builtMs, history, hours, attempt } = facts;
  const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const age = (ms) => { const h = hours(ms); return h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
  const proven = facts.provenWithin(windowHours);
  const latest = history.latest?.receipt;
  // An automatic update that ended without a refresh receipt of its own (npx could not fetch the
  // package, the lock was held, it was killed at its TTL) is a failure the receipts cannot show.
  const launchedMs = Date.parse(attempt?.launchedAt || '');
  const autoRunning = facts.lockMs > 0 && now - facts.lockMs < AUTO_UPDATE_LOCK_STALE_MS;
  const autoAbandoned = attempt?.outcome === 'launched' && !autoRunning;
  const autoFailed = Number.isFinite(launchedMs) && (attempt.outcome === 'failed' || autoAbandoned)
    && !(history.latest && history.latest.at >= launchedMs);
  const failing = latest?.status === 'FAILED' || autoFailed;
  const ageKnown = Number.isFinite(builtMs);
  const pending = newerCorpusPending(facts);
  if (!failing && pending && (proven || (ageKnown && hours(builtMs) <= windowHours))) {
    const optOut = autoUpdateOptOut({ env, home, facts });
    const what = autoRunning ? 'the automatic update is installing it now'
      : optOut ? `automatic update is off (${optOut}). Fix: npx ruvnet-brain@latest --update`
        : pending.outcome === 'not-converged' ? 'an automatic update to it finished without installing it; it retries within 6h'
          : 'the automatic update installs it in the background';
    return `${KNOWLEDGE_LINE_PREFIX}UPDATE PENDING] a newer corpus ${shortTag(pending.tag)} is published `
      + `(this machine has ${shortTag(pending.installed)}, built ${ageKnown ? age(builtMs) : 'at an UNKNOWN time'}); ${what}.`;
  }
  if (!failing && proven) return '';
  if (!failing && ageKnown && hours(builtMs) <= windowHours) return '';
  const kit = agenticKitUpdates({ home, facts });
  const agentKit = kit === 'delivering';
  // An agentic-kit machine must never be told to also --enable-nightly (one owner per machine).
  const scheduled = kit !== 'none' || readNightlyRegistration({ brainHome }).ok;
  const parts = [ageKnown ? `knowledge base built ${day(builtMs)} (${age(builtMs)})`
    : 'knowledge base age UNKNOWN (SOURCE.json missing or unreadable)'];
  if (autoFailed) {
    const why = autoAbandoned ? 'it never recorded an outcome (killed at its 30-minute limit, or the machine slept)'
      : `exit ${attempt.code ?? 'unknown'}: ${attempt.reason || 'no reason recorded'}`;
    parts.push(`automatic update launched ${age(launchedMs)} FAILED — ${why}`);
  } else if (latest?.status === 'FAILED') {
    const why = describeFailedRefreshRun(latest) || 'failed';
    parts.push(`last refresh (${latest.action || 'unknown'}) FAILED ${age(history.latest.at)}: ${why}`);
  }
  if (autoRunning) parts.push(`an automatic update is running now (started ${age(facts.lockMs)})`);
  parts.push(history.receipts
    ? `${history.failuresSinceSuccess} failed run(s) since the last success (${history.lastSuccess ? day(history.lastSuccess.at) : 'none recorded'})`
    : 'no refresh has ever run on this machine');
  if (kit === 'not-delivering') {
    parts.push(`agentic-kit claims updates (kit.json ruvnetBrain:true) but no update is proven in ${AGENTIC_KIT_PROOF_HOURS}h, so the Brain's own self-heal runs instead`);
  }
  if (!scheduled) parts.push('no nightly refresh is scheduled');
  if (history.unreadable) parts.push(`${history.unreadable} unreadable receipt(s)`);
  const fix = agentKit ? 'ak sync' : scheduled ? 'npx ruvnet-brain@latest --update'
    : 'npx ruvnet-brain@latest --update && npx ruvnet-brain --enable-nightly';
  const optOut = autoUpdateOptOut({ env, home, facts });
  if (optOut) parts.push(`automatic update is off (${optOut})`);
  else if (!autoRunning) parts.push('SessionStart retries the update automatically at most every 6h');
  const head = failing ? 'UPDATE FAILING' : ageKnown ? 'STALE' : 'CURRENCY UNKNOWN';
  return `${KNOWLEDGE_LINE_PREFIX}${head}] ${parts.join('; ')}. Fix: ${fix} (verify: npx ruvnet-brain --doctor).`;
};

export const mcpReadiness = (env, home) => {
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  const receipt = json(path.join(brainHome, 'mcp-readiness.json'));
  if (receipt?.state === 'ready' && Number.isInteger(receipt.pid) && Number.isInteger(receipt.workerPid)) {
    try {
      process.kill(receipt.pid, 0);
      process.kill(receipt.workerPid, 0);
      return { state: 'ready', receipt };
    } catch { /* a stale receipt is registration evidence, not live evidence */ }
  }
  if (receipt?.state === 'degraded') return { state: 'degraded', receipt };
  return { state: 'registered', receipt };
};
