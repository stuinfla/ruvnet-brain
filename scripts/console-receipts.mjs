// console-receipts.mjs — every Console click leaves a receipt the owner can SEE (2026-10-30).
//
// THE COMPLAINT THIS ANSWERS (owner, 2026-10-30): "Even if they work, they're not showing me that
// they've worked — completely insufficient." Measured on an isolated Console the same day:
//   • Brain power and Brain profile wrote their success note into a slot, then repainted the card
//     from /api/state, which rebuilt that slot empty — the note lived for one frame.
//   • A recommendation's "Applied — and reversible" panel, with its log and its Undo button, was
//     deleted outright ~30 s later when the re-measure landed and the proposal was (correctly) no
//     longer detected. The undo token was still in the server journal with no way left to reach it.
//   • Settings said "Saved." while the very field just saved still read "Not chosen yet".
//
// So the PROOF moves to the server, where a repaint cannot erase it: each mutating endpoint reads the
// real state BEFORE it writes and again AFTER (never echoing what it was asked to do), and the
// difference is stored here, in an append-only file, and served by GET /api/receipts. The page renders
// the newest receipts in a card of their own and next to the control that made them.
//
// Verdicts are derived, never asserted:
//   changed      the endpoint said ok AND the re-read differs from the read before
//   no-change    the endpoint said ok, nothing needed to change (it was already in that state)
//   unverified   the endpoint said ok, a change was expected, and the re-read shows none — said aloud
//   failed       the endpoint said it did not complete
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const RECEIPT_LIMIT = 200;      // lines kept on disk
export const RECEIPT_SERVE = 30;       // receipts served to the page

/** Flat comparison of two fact maps ({ label: displayValue }). Unknown is a value, never a blank. */
export function diffFacts(before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const show = (v) => (v === undefined || v === null || v === '' ? 'unknown' : String(v));
  return keys.map((fact) => ({ fact, before: show(before?.[fact]), after: show(after?.[fact]) }))
    .map((row) => ({ ...row, changed: row.before !== row.after }));
}

/**
 * Build one receipt. `ok` is the endpoint's own claim; `before`/`after` are independent re-reads.
 * `expectChange: false` declares an action whose success does not require a visible difference
 * (e.g. turning on a brain that was already on) — anything else that reports ok with no difference
 * is `unverified`, because "success" with nothing changed on disk is exactly the lie this exists to end.
 */
export function buildReceipt({ action, title, ok, before, after, log = '', undoToken = null, undoHow = '', expectChange = true, at = new Date().toISOString() }) {
  const facts = diffFacts(before, after);
  const changedCount = facts.filter((f) => f.changed).length;
  const verdict = !ok ? 'failed' : changedCount ? 'changed' : expectChange ? 'unverified' : 'no-change';
  const headline = {
    changed: `${title} — done. ${changedCount} thing${changedCount === 1 ? '' : 's'} changed, read back from your machine.`,
    'no-change': `${title} — nothing needed changing; your machine was already in that state.`,
    unverified: `${title} — the console reported success, but re-reading your machine shows no difference. Treat it as NOT done.`,
    failed: `${title} — did not complete. ${facts.some((f) => f.changed) ? 'Some state moved anyway; see below.' : 'Nothing on your machine changed.'}`,
  }[verdict];
  return {
    id: crypto.randomBytes(6).toString('hex'),
    at,
    action,
    title,
    ok: !!ok,
    verdict,
    headline,
    facts,
    log: String(log || '').slice(-2000),
    undoToken: undoToken || null,
    undoHow: undoHow || (undoToken ? 'Use the Undo button on this receipt.' : ''),
  };
}

/** Append a receipt and keep the file bounded. A receipt that cannot be stored is still returned. */
export function recordReceipt(file, receipt) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > RECEIPT_LIMIT) fs.writeFileSync(file, `${lines.slice(-RECEIPT_LIMIT).join('\n')}\n`);
  } catch { /* the response still carries the receipt; only its persistence is lost */ }
  return receipt;
}

/**
 * Newest first. `consumedTokens` (from the undo journal) marks a receipt whose undo was already used,
 * so the page never offers an undo the server will refuse.
 */
export function readReceipts(file, { consumedTokens = new Set(), limit = RECEIPT_SERVE } = {}) {
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((r) => r && r.id && r.at);
  } catch { return []; }
  return rows.reverse().slice(0, limit).map((r) => ({ ...r, undoUsed: !!(r.undoToken && consumedTokens.has(r.undoToken)) }));
}

/** Human size, with KB precision so a small real change never prints as "0 MB". */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
