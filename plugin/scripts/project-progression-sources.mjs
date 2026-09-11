/**
 * project-progression-sources.mjs — where a snapshot's facts actually come from.
 *
 * Every field a capture stores must be traceable to a REAL source: the git index, the user's own
 * work ledger, the owner's own `project-state-current` note, the previous snapshot head, or a
 * bounded transcript reference. Nothing here invents state, and nothing here copies the
 * conversation: the transcript contributes a REFERENCE (path + line/byte span + a sha256 of the
 * exact excerpt read) plus tightly-bounded DERIVED strings, never the prompt or the reply itself.
 *
 * Kept separate from the producer so each file stays small and so the readers can be tested against
 * real fixtures without constructing a whole snapshot.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** The transcript-derived bound. Deliberately far below the hook's 4096-byte observation limit. */
export const DERIVED_TEXT_LIMIT = 240;
/** How much of a transcript tail may be READ (never stored) to derive those bounded strings. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** A stable digest for "there is genuinely nothing to digest here", never an empty string. */
const ABSENT_DIGEST = sha256('ruvnet-brain:absent');

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
}

/**
 * The source identity, with each digest defined EXACTLY:
 *   trackedDigest   sha256 of `git ls-files -s` (mode + blob oid + stage + path for every tracked file)
 *   untrackedDigest sha256 of one `<content-sha256> <path>` line per untracked, non-ignored file —
 *                   the NAMES alone would call two different working trees identical
 *   dirtyTreeDigest sha256 of `git diff HEAD` (staged AND unstaged, against the commit)
 *
 * KNOWN RACE, recorded rather than pretended away: the working tree can change while these three
 * commands run. HEAD is read before and after; when they differ, `headStable` is false and the
 * digests describe a tree that existed at no single instant. A capture still happens — a slightly
 * smeared snapshot is worth far more than no snapshot — but it never claims to be atomic.
 */
export function readSourceIdentity({ checkoutRoot, kind = 'git' } = {}) {
  const worktreeId = sha256(checkoutRoot);
  if (kind !== 'git') {
    // A non-git project has no index, no HEAD and no diff. Say that in the fields rather than
    // fabricating hashes of nothing, and keep every value a non-empty string as the contract requires.
    return {
      identity: {
        checkoutPath: checkoutRoot, worktreeId, branch: 'non-git', head: 'non-git',
        trackedDigest: ABSENT_DIGEST, untrackedDigest: ABSENT_DIGEST, dirtyTreeDigest: ABSENT_DIGEST,
      },
      headStable: true,
      kind,
    };
  }

  const headBefore = git(checkoutRoot, ['rev-parse', 'HEAD'])?.trim() || 'unborn';
  const branch = git(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || 'detached';
  const tracked = git(checkoutRoot, ['ls-files', '-s']);
  const untrackedList = git(checkoutRoot, ['ls-files', '--others', '--exclude-standard']);
  const diff = git(checkoutRoot, ['diff', 'HEAD']);
  const headAfter = git(checkoutRoot, ['rev-parse', 'HEAD'])?.trim() || 'unborn';

  const untrackedLines = String(untrackedList ?? '').split('\n').filter(Boolean).map((relative) => {
    let content;
    try { content = fs.readFileSync(path.join(checkoutRoot, relative)); } catch { return `unreadable ${relative}`; }
    return `${sha256(content)} ${relative}`;
  });

  return {
    identity: {
      checkoutPath: checkoutRoot,
      worktreeId,
      branch,
      head: headBefore,
      trackedDigest: tracked === null ? ABSENT_DIGEST : sha256(tracked),
      untrackedDigest: untrackedList === null ? ABSENT_DIGEST : sha256(untrackedLines.join('\n')),
      dirtyTreeDigest: diff === null ? ABSENT_DIGEST : sha256(diff),
    },
    headStable: headBefore === headAfter,
    headAfter,
    kind,
  };
}

/**
 * The user's own work ledger, read-only, resolved exactly as continuation-gate.mjs resolves it:
 * RUVNET_WORK_LEDGER, else ~/.config/ruvnet-brain/work-ledgers/<projectId with ':' → '-'>.json.
 * This is the AUTHORITATIVE source for open work, because the user put it there.
 */
export function readWorkLedger({ projectId, env = process.env, home = os.homedir() } = {}) {
  const file = env.RUVNET_WORK_LEDGER
    || path.join(home, '.config', 'ruvnet-brain', 'work-ledgers', `${String(projectId).replace(':', '-')}.json`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    return { file, present: false, open: [], done: [], objective: null };
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const text = (item) => (typeof item?.text === 'string' ? item.text : '');
  return {
    file,
    present: true,
    open: items.filter((item) => item && !item.done).map(text).filter(Boolean),
    done: items.filter((item) => item?.done).map(text).filter(Boolean),
    objective: parsed?.objective && typeof parsed.objective === 'object' ? parsed.objective : null,
  };
}

/**
 * The owner's own convention: append-only `project-state-current-<epochms>[-slug]` free-text notes.
 * 378 of them exist in this repo's canonical store. They are narrative, not schema, so only the head
 * of the newest one is carried, as CONTEXT — never as an instruction and never as authority.
 */
export function readOwnerNote(readRows, { limit = 600 } = {}) {
  let rows;
  try { rows = readRows(); } catch { return null; }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const newest = rows
    .filter((row) => typeof row?.key === 'string' && row.key.startsWith('project-state-current'))
    .sort((left, right) => String(left.key).localeCompare(String(right.key)))
    .at(-1);
  if (!newest || typeof newest.content !== 'string' || !newest.content.trim()) return null;
  const excerpt = newest.content.slice(0, limit);
  return {
    key: newest.key,
    namespace: newest.namespace ?? null,
    excerpt,
    truncated: newest.content.length > limit,
    excerptSha256: sha256(excerpt),
  };
}

function firstSentence(value) {
  const collapsed = String(value).replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const stop = collapsed.search(/[.!?](\s|$)/);
  const sentence = stop > 0 ? collapsed.slice(0, stop + 1) : collapsed;
  return sentence.length <= DERIVED_TEXT_LIMIT ? sentence : `${sentence.slice(0, DERIVED_TEXT_LIMIT)}…`;
}

function claudeTranscriptRows(text) {
  const rows = [];
  const lines = text.split('\n');
  // The first line of a mid-file tail is almost always a fragment; dropping it is correct, not lossy.
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a partial line in a live-appended file */ }
  }
  return rows;
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('\n');
}

/**
 * A BOUNDED, NON-VERBATIM reading of the transcript tail.
 *
 * THE PRIVACY BOUNDARY, stated as a rule rather than a hope: the prompt and the assistant's reply
 * are READ here and are NEVER RETURNED. What comes back is a REFERENCE (path, line span, byte span,
 * and the sha256 of the exact bytes read, so an auditor can prove what was consulted) plus at most
 * two DERIVED single sentences, each capped at DERIVED_TEXT_LIMIT. Anything inferred this way is
 * marked non-authoritative by the producer; the ledger and the owner's note outrank it always.
 *
 * Unknown or unreadable formats return `skipped` with a reason. A host whose transcript we cannot
 * parse must cost the capture nothing at all.
 */
export function readTranscriptReference(transcriptPath, { host = 'claude', tailBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) {
    return { skipped: 'no transcript path supplied' };
  }
  if (host !== 'claude') return { skipped: `transcript format unknown for host ${host}` };
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return { skipped: 'transcript is unreadable' }; }
  if (!stat.isFile() || stat.size === 0) return { skipped: 'transcript is empty or not a file' };
  if (!/\.jsonl$/i.test(transcriptPath)) return { skipped: 'transcript is not a JSONL transcript' };

  const byteOffset = Math.max(0, stat.size - tailBytes);
  const byteLength = stat.size - byteOffset;
  let buffer;
  try {
    const handle = fs.openSync(transcriptPath, 'r');
    try {
      buffer = Buffer.alloc(byteLength);
      fs.readSync(handle, buffer, 0, byteLength, byteOffset);
    } finally { fs.closeSync(handle); }
  } catch { return { skipped: 'transcript tail could not be read' }; }

  const rows = claudeTranscriptRows(buffer.toString('utf8'));
  if (rows.length === 0) return { skipped: 'transcript tail contained no parseable records' };
  const lastUser = [...rows].reverse()
    .find((row) => row?.type === 'user' && row.message?.role === 'user' && textOf(row.message).trim());
  const lastAssistant = [...rows].reverse()
    .find((row) => row?.type === 'assistant' && textOf(row.message).trim());

  return {
    reference: {
      path: transcriptPath,
      byteOffset,
      byteLength,
      recordsRead: rows.length,
      excerptSha256: sha256(buffer),
      format: 'claude-jsonl',
    },
    // DERIVED ONLY. Callers must not treat these as the user's words; they are a bounded
    // single-sentence reduction, recorded so an abandoned session still knows what it was doing.
    derivedGoal: lastUser ? firstSentence(textOf(lastUser.message)) : '',
    derivedNextAction: lastAssistant ? firstSentence(textOf(lastAssistant.message)) : '',
  };
}
