// codex-overnight-notice.mjs — the unattended nightly never reloads the shared Codex app-server (owner decision,
// 4.7.21 review r2): a reload reaches Codex sessions already open, and Brain hooks pause in them until re-reviewed in
// /hooks, which nobody is awake to do. The nightly records this one-line notice instead; the next SessionStart shows
// it ONCE. Same claim-before-say contract as the other once-only SessionStart lines (.star-ask-shown, turn-capture
// notices): the file is claimed by an atomic rename BEFORE the line is emitted, so two sessions starting together
// cannot both show it, and a killed session cannot repeat it.
import fs from 'node:fs';
import path from 'node:path';

export const CODEX_OVERNIGHT_FILE = 'codex-hooks-overnight-notice.json';
export const CODEX_OVERNIGHT_PREFIX = '[RuvNet Brain — CODEX HOOKS CHANGED OVERNIGHT]';
export const CODEX_OVERNIGHT_TEXT = 'Codex hooks changed overnight; open Codex sessions will pick them up on restart or after /hooks review.';

/** Written by the unattended update. Never throws: an unrecorded notice must not fail the nightly. */
export function recordCodexOvernightNotice(brainHome, { now = Date.now() } = {}) {
  try {
    fs.mkdirSync(brainHome, { recursive: true });
    const file = path.join(brainHome, CODEX_OVERNIGHT_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, at: new Date(now).toISOString() })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** Read by SessionStart: the line to show, at most once; '' when there is none or another session claimed it. */
export function claimCodexOvernightNotice(brainHome) {
  const file = path.join(brainHome, CODEX_OVERNIGHT_FILE);
  const claimed = `${file}.shown-${process.pid}`;
  try { fs.renameSync(file, claimed); } catch { return ''; }
  try { fs.rmSync(claimed, { force: true }); } catch { /* claimed already; a leftover is never shown again */ }
  return `${CODEX_OVERNIGHT_PREFIX} ${CODEX_OVERNIGHT_TEXT}`;
}
