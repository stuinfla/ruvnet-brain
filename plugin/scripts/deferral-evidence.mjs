/**
 * deferral-evidence.mjs — "do not end the turn on authorized work by asking permission" as a pure,
 * replayable detector (ADR-106 `no-deferral`; ADR-043 "must force, not whisper").
 *
 * The owner's measured complaint: turns end with "Say go and I'll start", "Decisions I need from you",
 * "Do you want me to…", "Next: …", "I'll come back when…" on work he had already authorized. The
 * Stop gate corrects completion claims and records promises; this file supplies the third check.
 *
 * A turn is a DEFERRAL only when all three hold, and each is a fact read from text:
 *   (a) the END of the final answer seeks permission or lists its own next actions as future work;
 *   (b) authorization exists — a standing instruction in the session's prompts, or an open promise;
 *   (c) the answer names no genuine blocker class (credential, out-of-authority write, irreversible
 *       action needing consent, hardware-key tap, evidenced outage, or a choice only the user can make).
 * Heuristic by construction. scripts/deferral-replay.mjs measures it on real transcripts; the
 * measured false-positive rate is recorded in ADR-106, not assumed.
 */
import { strippedProse } from './completion-claim-evidence.mjs';
import { isHarnessGenerated } from './hook-input.mjs';

const TAIL_CHARS = 700;

/** Permission-seeking / hand-back phrasing. Matched only in the last part of the answer. */
const PERMISSION = [
  /\bsay\s+(?:the\s+word|go|yes)\b/i,
  /\b(?:do\s+you\s+)?want\s+me\s+to\b/i,
  /\bwould\s+you\s+like\s+(?:me\s+)?to\b/i,
  /\b(?:should|shall)\s+I\b/i,
  /\bdo\s+you\s+want\b/i,
  /\blet\s+me\s+know\s+(?:if|whether|when|which|how)\b/i,
  /(?<!\b(?:no|nothing|without|any)\s+(?:further\s+)?)\b(?:decisions?|input|approval|confirmation|sign-?off|answers?|go-?ahead)\s+(?:I\s+need\s+)?(?:from|needed\s+from)\s+you\b/i,
  /\bI\s+need\s+(?:you|your)\b/i,
  /\bwaiting\s+(?:on|for)\s+(?:you|your)\b/i,
  /\b(?:ready\s+when\s+you\s+are|on\s+your\s+(?:go|word|ok))\b/i,
  /\b(?:ok|okay)\s+to\s+proceed\b|\bproceed\?/i,
  /\b(?:green[-\s]?light|your\s+call)\b/i,
];

/** Own next actions stated as future work instead of done. */
const FUTURE_WORK = [
  /^(?:\s*[-*•#]+\s*|\s*\*\*)*next(?:\s+steps?)?(?:\*\*)?\s*[:—–-]\s*\S/im,
  /\bI(?:'ll|’ll|\s+will)\s+(?:come\s+back|follow\s+up|pick\s+(?:this|it)\s+(?:back\s+)?up|resume|continue|get\s+to|start|tackle|handle|do)\b[^.\n]{0,120}\b(?:after|when|once|later|next\s+(?:session|turn|time)|tomorrow)\b/i,
  /\b(?:remaining|still\s+to\s+do|left\s+to\s+do|todo)\s*[:—–-]\s*\S/i,
];

/** A genuine authority boundary or an answer only the user can give. Matched anywhere in the answer. */
export const BLOCKER_CLASSES = Object.freeze({
  credential: /\b(?:setup\s+key|authenticator|backup\s+codes?)\b|\b(?:api[\s-]?key|token|secret|credential|password|passphrase|login|sign[\s-]?in|oauth)\b[^.\n]{0,80}\b(?:missing|needed|required|absent|expired|not\s+(?:set|available|present|found)|revoked|invalid)\b|\b(?:missing|need|needs|no)\s+(?:an?\s+)?(?:api[\s-]?key|token|secret|credential|password)\b/i,
  hardwareTap: /\b(?:hardware[\s-]?key|security[\s-]?key|yubikey|touch\s?id|passkey|2fa|otp|tap\s+(?:the|your)\s+key)\b/i,
  outsideAuthority: /\b(?:outside\s+(?:my|the)\s+(?:stated\s+)?(?:authority|scope)|not\s+(?:authori[sz]ed|permitted|allowed)\s+to|no\s+(?:write\s+)?authority|user-level|~\/\.claude|~\/\.codex|only\s+you\s+can|I\s+can(?:'t|’t|not)\s+(?:contact|reach|send|sign|log\s+in)|npm\s+(?:publish|deprecate)|deprecat(?:e|ed|ing)\s+(?:it\s+)?on\s+npm)\b/i,
  irreversible: /\b(?:irreversible|cannot\s+be\s+undone|can't\s+be\s+undone|destructive|data\s+loss|force[\s-]?push|drop\s+(?:the\s+)?(?:table|database)|delete\s+(?:the\s+)?(?:branch|repo|database|production)|before\s+anything\s+is\s+deleted|rm\s+-rf)\b/i,
  outage: /\b(?:outage|is\s+down|503|502|rate[\s-]?limit(?:ed)?|unreachable|connection\s+refused|timed?\s*out\s+(?:connecting|reaching))\b/i,
  background: /\b(?:awaiting|standing\s+by\s+for|report(?:s)?\s+back|the\s+moment\b[^.\n]{0,60}\b(?:lands|has|finishes|arrives)|once\s+[^.\n]{0,60}\b(?:lands|finishes|completes|returns|is\s+back)|waiting\s+on\s+(?!you|your)[^.\n]{0,40}\b(?:CI|v\d|run|build|agent|tests?|review|suite|checks?)|still\s+running|running\s+in\s+the\s+background|I(?:'m|’m|\s+am)\s+waiting\s+for\s+(?:both|the|it|CI|checks?|reviews?|results?)|when\s+(?:the\s+)?[^.\n]{0,60}\b(?:arrives|lands|returns|reports|finishes|passes|completes|comes\s+back|is\s+back))\b/i,
  userAction: /\b(?:restart\s+(?:the|your)\s+(?:Mac|computer|machine)|reboot|type\s+(?:the|your)\s+password|First\s+Aid|plug\s+(?:it\s+)?in|unplug|eject)\b/i,
  purchase: /\b(?:amazon\.com|buy|purchase|price[ds]?|\$\s?\d)\b/i,
  ownerFact: /\b(?:show\s+me\s+where|tell\s+me\s+(?:where|which\s+file|what\s+you\s+(?:mean|meant)))\b/i,
  ownerChoice: /\b(?:should|do\s+you\s+want)\b[^?\n]{0,200}\bor\b[^?\n]{0,200}\?|\b(?:which\s+(?:one|option)\s+(?:do\s+)?you|(?:option|choice)\s+(?:A|1)\b[^.\n]{0,200}\b(?:option|choice)\s+(?:B|2)\b|only\s+you\s+(?:know|can\s+(?:decide|choose|answer)))\b/i,
});

/** Standing authorization phrases in the owner's prompts. */
const STANDING = /\b(?:don['’]?t\s+stop|do\s+not\s+stop|keep\s+going|never\s+stop|get\s+it\s+(?:done|shipped)|finish\s+(?:it|this|the\s+job|everything)|until\s+(?:it['’]?s\s+)?done|carry\s+(?:it|this)\s+to\s+done|i\s+didn['’]?t\s+tell\s+you\s+to\s+stop|just\s+do\s+it|go\s+ahead|you\s+are\s+authori[sz]ed|fix\s+it\s+now|do\s+it\s+all|make\s+the\s+call)\b/i;

const tailOf = (message) => {
  const prose = strippedProse(message).replace(/\n{3,}/g, '\n\n').trim();
  return prose.slice(-TAIL_CHARS);
};

/** The answer itself says work continues, or that nothing is needed from the owner: not a hand-back. */
const PROGRESSING = /\b(?:I(?:'m|’m|\s+am)\s+(?:now\s+)?(?:continuing|starting|moving|proceeding)|starting\s+(?:on\s+)?[^.\n]{0,60}\bnow|moving\s+(?:into|on\s+to)\s+[^.\n]{0,60}\bnow|continuing\s+without|nothing\s+(?:is\s+)?(?:waiting\s+on|needed\s+from|required\s+from)\s+you|no\s+(?:further\s+)?input\s+(?:is\s+)?needed)\b/i;

/** Pure: does this final answer end by deferring? Returns the matched phrase or null. */
export function deferralIn(message) {
  const tail = tailOf(message);
  if (!tail || PROGRESSING.test(tail)) return null;
  for (const re of [...PERMISSION, ...FUTURE_WORK]) {
    const m = re.exec(tail);
    if (m) return { phrase: m[0].trim().slice(0, 80), kind: PERMISSION.includes(re) ? 'permission' : 'future-work' };
  }
  return null;
}

/** Pure: which genuine blocker classes the answer names (empty = none). */
export function blockersIn(message) {
  const text = strippedProse(message);
  return Object.entries(BLOCKER_CLASSES).filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Pure: is there a standing instruction in any of these owner prompts? */
export function standingAuthorization(prompts) {
  for (const p of prompts || []) {
    const m = STANDING.exec(String(p || ''));
    if (m) return m[0];
  }
  return null;
}

/**
 * The verdict. `prompts` = owner prompt texts of the session so far; `openPromises` = count of open
 * first-person promises from this session in the work ledger.
 */
export function auditDeferral(message, { prompts = [], openPromises = 0 } = {}) {
  const deferral = deferralIn(message);
  if (!deferral) return { verdict: 'NONE' };
  const blockers = blockersIn(message);
  if (blockers.length) return { verdict: 'BLOCKER', deferral, blockers };
  const standing = standingAuthorization(prompts);
  if (!standing && openPromises < 1) return { verdict: 'UNAUTHORIZED', deferral };
  return { verdict: 'DEFERRAL', deferral, authorization: standing ? `standing instruction "${standing}"` : `${openPromises} open promise(s)` };
}

/** Owner prompt texts from raw Claude transcript lines (main thread, not tool results, not meta). */
export function ownerPrompts(lines) {
  const out = [];
  for (const l of lines || []) {
    let o; try { o = typeof l === 'string' ? JSON.parse(l) : l; } catch { continue; }
    const c = o?.message?.content;
    if (o?.type !== 'user' || o.isSidechain || o.isMeta) continue;
    if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) continue;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
    if (text.trim() && !isHarnessGenerated(text)) out.push(text.slice(0, 8000));
  }
  return out;
}

/**
 * The Stop-side read (Claude): owner prompts from the transcript tail plus the current prompt's text,
 * which keys the per-prompt force counter. A transcript we cannot read yields no verdict (fail open).
 */
export function deferralAtStop({ message, transcriptPath, openPromises = 0, read }) {
  if (typeof transcriptPath !== 'string' || !/\.jsonl$/i.test(transcriptPath) || !message) return null;
  let lines;
  try { lines = read(transcriptPath, { maxMs: 0 }); } catch { return null; }
  const prompts = ownerPrompts(lines);
  return { ...auditDeferral(message, { prompts, openPromises }), prompt: prompts.at(-1) || '' };
}
