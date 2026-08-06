// advocacy-outcomes.mjs — the ledger that tells us whether our own advocacy was RIGHT.
//
// THE MISSING HALF. ADR-027 gave the brain a voice: detect a dormant capability, recommend it,
// execute it, reverse it. ADR-028 then defined the honest measure of that voice — precision,
// "recommendations acted on ÷ recommendations fired, target ≥ 0.60. Below this we are nagging, and a
// nag trains users to ignore the real alarm." That number has never been computable, because nothing
// in this system records what happened AFTER a recommendation was shown. Every offer vanished the
// moment the page closed. A system that cannot see its own outcomes cannot improve, and one that
// reports a metric it cannot source is doing the fabrication this repo has a CI gate against.
//
// So: an append-only outcome ledger. Every offer resolves into exactly one record — applied,
// dismissed, or ignored — and those three records are the only evidence any claim about proactivity
// is allowed to rest on.
//
// THE ONE WAY TO FABRICATE THIS METRIC, named here so a reviewer can check for it: record only the
// applies. Precision is applied ÷ (applied + dismissed + ignored), so a caller that forgets to
// record the misses reports a beautiful 1.0. The invariant is therefore not "record outcomes" but
// "every offer produces exactly one record" — and `ignored` is what an unresolved offer becomes when
// the session ends. If you are adding a caller, the ignored-path is the one to write first.
//
// THE ASYMMETRY THIS FILE EXISTS TO ENCODE. The adversarial review of ADR-031 (GPT-5.6-Sol,
// 2026-07-22) killed the previous learning signal with one sentence: "repeat count measures the
// USER'S FRUSTRATION, not the lesson's correctness... a formatting preference corrected 52 times
// dominates a security rule corrected once." A dismissal ledger repeats that mistake exactly if it is
// read as a popularity contest, so it is not read as one here:
//
//     A dismissal is evidence about FIT, not about IMPORTANCE.
//
// "Not for me" and "not worth an interruption" are the same click. So the click cannot be allowed to
// mean the same thing for a cosmetic suggestion and for a corrupt-database warning — a nag dismissed
// once should vanish, and a high-severity finding dismissed once must not. That asymmetry is
// DISMISSAL_BUDGET below, and it is the whole design; the rest is bookkeeping.
//
// STORAGE. `~/.config/ruvnet-brain/` — user-level, and deliberately OUTSIDE `~/.cache/ruvnet-brain/`
// which `--update` replaces wholesale. Same reasoning as lesson-store.mjs: an outcome destroyed by
// the next release never compounds, and compounding (ADR-028 L5) is the only point of any of this.
//
// PURITY: node builtins only, no spawn, no network. It is read by surfaces; it does not render.
//
// WIRED (2026-07-23). Until this build `shouldStillOffer()` had ZERO production callers —
// `anticipate.sh` kept its OWN binary dismissed-Set (one dismissal muted forever, no severity, no
// budget) as a second, disconnected suppression policy, and this file's asymmetric budget sat
// uncalled. `anticipate.sh` is now the single caller for every mode (suggest AND
// dismiss/undismiss/status): it asks `shouldStillOffer()` and nothing else decides. `reconcileIgnored()`
// likewise had zero callers; `onboarding-console.mjs`'s `/api/capabilities` handler now supplies its
// pending-and-stale ids via this file's `pendingOffers()` (see `findStaleOffers()` there for the
// staleness rule, which is deliberately this file's caller's decision, not this file's).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

/**
 * ACTIONS — what became of an offer.
 *
 * The first three are the closed set ADR-028's precision metric is defined over: an offer that was
 * shown ends as exactly one of them. `ignored` is a real, declared value rather than an absence,
 * for the same reason UNDO_KINDS.NONE is one in remedy-registry.mjs: "the user did nothing" and
 * "nobody wrote the code to record it" must never look identical, and the second is what silently
 * inflates precision.
 *
 * RESET is the fourth, and it is here because of a house rule, not because the metric needs it.
 * Dismissal is a control — it makes the brain stop speaking — and this repo does not ship a control
 * without a real inverse (remedy-registry.mjs exists because a recommendation once promised an undo
 * that had no branch behind it, and reported "nothing to undo" instead of failing). Suppression with
 * no way back would be that same dead button pointed at silence. A reset is a CHECKPOINT, never a
 * deletion: the ledger stays append-only and complete, and only the suppression arithmetic starts
 * counting again after it.
 */
export const ACTIONS = Object.freeze({
  OFFERED: 'offered',
  APPLIED: 'applied',
  DISMISSED: 'dismissed',
  IGNORED: 'ignored',
  RESET: 'reset',
});
const ACTION_VALUES = new Set(Object.values(ACTIONS));

/**
 * `OFFERED` is the PENDING marker: the card was shown, and nothing has become of it yet. It is NOT a
 * resolution and never enters the precision denominator (that would let merely showing a card move
 * the metric). It exists for one reason — so `reconcileApplied()` can tell "we suggested this and the
 * user then turned it on" (an APPLIED) apart from "it was already on". Formalising it here also ends a
 * real schema drift: `anticipate.sh` was already writing `action:'offered'` through its own inline
 * recorder, while the canonical `record()` below rejected that action — so every offered row it wrote
 * was inert, counted by nothing. Now both writers speak one vocabulary and `record()` accepts it.
 */
/** The three RESOLUTIONS. `offered` is pending (not a resolution); `reset` is a ledger checkpoint. */
const OFFER_ACTIONS = new Set([ACTIONS.APPLIED, ACTIONS.DISMISSED, ACTIONS.IGNORED]);

/**
 * THE ASYMMETRY, as numbers.
 *
 * A `normal` item spends its whole budget on ONE dismissal: the user said no, and for a suggestion
 * that is the end of the conversation. Cheap to honour, and the cost of being wrong is that they
 * miss a nicety.
 *
 * A `high` item costs three, because the cost of being wrong runs the other way. The finding this
 * mechanism will most often suppress is the 2026-07-21 case: a corrupt AgentDB store, detected,
 * scored 49/100, rendered — and the owner had to notice it himself. If one distracted click could
 * bury that class of finding permanently, this file would have shipped a regression dressed as a
 * feature. Three refusals is a considered no; one is a busy hand.
 *
 * IGNORE_WEIGHT prices silence at a fifth of a refusal. Silence is the weakest signal we have — it is
 * consistent with "no", with "later", and with "I never saw the card" — so it may accumulate into
 * suppression (a card ignored fifteen times IS a nag) but it may never be mistaken for an answer.
 *
 * APPLIED_CREDIT lets acting on a recommendation buy back a stretch of ignores, because clicking it
 * is the single strongest evidence of fit we can observe, and a wanted card that fires again when
 * the state recurs is not a nag.
 *
 * HARD_DISMISSAL_CAP is the ceiling above severity: after five explicit refusals nothing re-fires,
 * ever, at any severity, whatever the evidence says. At that point we are wrong about the user, not
 * about the machine — and ADR-028's own anti-goal list puts "interruption without an off switch"
 * beside nagging.
 */
export const DISMISSAL_BUDGET = Object.freeze({ normal: 1, high: 3 });
export const IGNORE_WEIGHT = 0.2;
export const APPLIED_CREDIT = 1;
export const HARD_DISMISSAL_CAP = 5;

/** ADR-028's stated target and the sample floor below which reporting against it would be noise. */
export const PRECISION_TARGET = 0.60;
export const MIN_PRECISION_SAMPLES = 5;

/**
 * THE GOODHART GUARD FOR PRECISION — the one the 4.0 briefing named and left open ("the fixture's
 * separation-of-authorities design guards recall; the equivalent guard for precision needs the real
 * ledger to exist first").
 *
 * It turns out not to need the ledger at all, because the hole is arithmetic. Once a metric gates a
 * release it becomes a target, and precision = applied/offered has an obvious exploit: OFFER LESS.
 * Suggest only the sure thing, and precision approaches 1.00 while the product helps nobody — which
 * is the exact behaviour ADR-028 exists to prevent, certified by the metric meant to detect it.
 *
 * The old `meetsTarget: value >= PRECISION_TARGET` compared the POINT ESTIMATE, so 4 applied out of
 * 6 offers read 0.667 >= 0.60 and passed, while the true rate consistent with that evidence goes far
 * below 0.30. Worse, MIN_PRECISION_SAMPLES = 5 cannot support the target under ANY outcome: a
 * perfect 5/5 bounds at 0.05^(1/5) = 54.9%, still short of 0.60. The floor was unreachable and the
 * comparison was to the wrong number.
 *
 * Comparing the 95% LOWER BOUND to the target closes both. Fewer offers widen the interval, so
 * withholding offers can no longer manufacture a passing score — it makes the metric report "not
 * yet judgeable" instead. The incentive now points the right way: the only route to a certified
 * precision is to offer MORE and be right.
 *
 * Exact Clopper-Pearson: the lower bound solves P(X >= k | n, p) = alpha. Computed by bisection on
 * the binomial tail with exact terms (n is tiny here). Self-checkable: at k = n it must reduce to
 * alpha^(1/n) — asserted in the tests rather than trusted, because a hand-rolled incomplete-beta in
 * this same session returned 98.3% for n=3, which is absurd on its face.
 */
export const PRECISION_ALPHA = 0.05;

export function precisionLowerBound(k, n, alpha = PRECISION_ALPHA) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  if (k === 0) return 0;
  const tailAtLeastK = (p) => {
    // sum_{i=k}^{n} C(n,i) p^i (1-p)^(n-i), computed with a running coefficient to avoid factorials.
    let sum = 0;
    let coeff = 1;                                   // C(n,0)
    for (let i = 0; i <= n; i++) {
      if (i >= k) sum += coeff * Math.pow(p, i) * Math.pow(1 - p, n - i);
      coeff = coeff * (n - i) / (i + 1);             // C(n,i) -> C(n,i+1)
    }
    return sum;
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tailAtLeastK(mid) < alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Field caps. These are a CORRECTNESS property, not tidiness — see appendLine() below: the atomicity
// of a concurrent append depends on each record being one small write. EXPORTED so a test can assert
// the arithmetic that makes the guard in appendLine() unreachable: every field is bounded, and the
// bounds sum to well under MAX_RECORD_BYTES. The guard stays anyway, as the tripwire that fires the
// day somebody raises one of these caps without redoing that sum.
export const MAX_ID = 200;
export const MAX_PROJECT = 120;
export const MAX_HASH = 64;
export const MAX_SEVERITY = 32;
export const MAX_RECORD_BYTES = 1024;

export const OUTCOMES_PATH = process.env.RUVNET_ADVOCACY_OUTCOMES
  || path.join(HOME, '.config', 'ruvnet-brain', 'advocacy-outcomes.jsonl');

/**
 * Severity → the two classes the budget is defined over.
 *
 * Accepts console-engine's vocabulary (`INFO` | `SUGGESTED` | `IMPORTANT`) and lesson-store's
 * (`normal` | `high`), because both produce things that get offered and neither is going to change
 * to suit this file.
 *
 * UNKNOWN SEVERITY RESOLVES TO `normal`, i.e. to the quieter class, and that direction is deliberate.
 * It means a caller that forgets to pass severity gets an item silenced after one dismissal rather
 * than one that is nearly unsilenceable. ADR-028: "One false alarm costs more trust than ten true
 * ones earn. Non-negotiable." When we do not know, we err toward respecting the refusal — and
 * because record() stores the severity it was told, the history stays self-describing rather than
 * quietly re-classified later.
 */
export function weightClass(severity) {
  const s = String(severity ?? '').trim().toLowerCase();
  return (s === 'important' || s === 'high' || s === 'critical') ? 'high' : 'normal';
}

/**
 * A stable fingerprint of the evidence a recommendation was built from.
 *
 * ADR-027's rule is "offered once per state change, dismissible, never re-fires while dismissed" —
 * which is only implementable if "the state" is a value something can compare. This is that value:
 * hash what we OBSERVED, not what we said about it, so rewording a card does not read as new
 * evidence and re-open a settled question.
 *
 * Returns null for no evidence. Null is honest ("we cannot tell whether the state changed") and it
 * is inert by construction: the state-change reprieve in shouldStillOffer() requires a real hash on
 * both sides, so an unknown state can never argue its way past a dismissal.
 */
export function stateHashOf(evidence) {
  const items = (Array.isArray(evidence) ? evidence : [evidence])
    .map((e) => {
      if (e === null || e === undefined) return '';
      if (typeof e === 'object') return String(e.observed ?? JSON.stringify(e));
      return String(e);
    })
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();   // order of evidence is presentation, not state
  if (!items.length) return null;
  return crypto.createHash('sha256').update(items.join(' ')).digest('hex').slice(0, 16);
}

function toIso(at) {
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * THE WRITE. One line, one open-with-O_APPEND, one write() — and no read step at all.
 *
 * This repo has already paid for the alternative. saveSettings() did read-modify-write on a JSON
 * object, and MEASURED across 20 trials of four simultaneous writers, at least one setting was lost
 * in 19 of them — every writer returning ok:true, no error, no warning. The fix there was a lock,
 * because a settings file genuinely is a single mutable object.
 *
 * A ledger is not. Append-only removes the read, and with the read goes the entire class of bug:
 * there is no prior value to clobber. That is why this file is JSONL and not a JSON array, and the
 * shape is load-bearing rather than stylistic — an array would reintroduce read-modify-write and
 * with it the 19-in-20 silent loss, on the surface whose only job is to remember what the user chose.
 *
 * The remaining hazard is a partial write interleaving with another process's. POSIX makes the
 * offset-advance-and-write atomic for a single write() on an O_APPEND fd; Node issues one write()
 * for a single small buffer. So the size cap is the guarantee: every field is truncated, and a
 * record that still exceeds MAX_LINE_BYTES is refused rather than written and hoped for. And because
 * a torn line is still conceivable on an exotic filesystem, loadOutcomes() drops unparseable lines
 * instead of failing — one damaged record costs one record, never the ledger.
 */
function appendLine(file, row) {
  const line = JSON.stringify(row) + '\n';
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
    throw new Error(`Outcome for "${row.id}" invalid: record is ${Buffer.byteLength(line)} bytes, over the ${MAX_RECORD_BYTES}-byte cap that keeps a concurrent append atomic`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line);
  return line;
}

/**
 * Record what became of one offer. Append-only; nothing here ever rewrites history.
 *
 * THROWS on a malformed record — same discipline as makeRecommendation() and makeLesson(): an
 * invariant belongs in the constructor, not in a reviewer's memory. An unknown `action` written
 * quietly would corrupt the precision denominator forever, and the wrongness would show up as a
 * plausible number rather than as an error.
 *
 * DOES NOT THROW on an I/O failure — it returns `{ ok: false, reason }`, because callers are
 * surfaces and a read-only home directory must not take down the console. But a caller MUST surface
 * a failed `dismissed`: if the write fails silently, the user's "stop showing me this" does not
 * stick, they see the same card tomorrow, and the off switch has become theatre. That is the exact
 * failure shape as the undo that reported "nothing to undo" — a control that reports success and
 * does nothing.
 *
 * @param {{id:string, action:string, at?:Date|string, project?:string, severity?:string|null,
 *          stateHash?:string|null, scope?:'forever'|null}} spec
 */
/**
 * Under a test runner, writing to the DEFAULT (real, user-level) ledger is a bug, not a choice.
 *
 * Found by an independent grader on 2026-07-24: the live ledger at ~/.config/ruvnet-brain/ held
 * exactly one row, `{"id":"f-adv-1","stateHash":"hash-1",...}` — fixture-shaped data in the user's
 * real outcome record, describing an event that never happened. Every precision number this product
 * reports is computed over that file, and it had junk in it from the first day it existed.
 *
 * It got there because a test called record() without passing `{file}`, so the default path won. The
 * tempting fix is to blocklist ids that look like fixtures (`f-*`, `hash-*`), but that is a guess
 * about naming, and the next fixture that does not match the pattern lands in the ledger exactly the
 * same way. The defect is not the id — it is that a test can address the real file at all.
 *
 * So the write refuses instead. Under vitest, an explicit `file` (or RUVNET_ADVOCACY_OUTCOMES) is
 * mandatory; the default is unreachable. That makes the pollution impossible by construction rather
 * than unlikely by convention, and it fails LOUD at the moment the test is written rather than
 * silently into a file nobody reads until a grader opens it thirteen months of commits later.
 */
const UNDER_TEST = !!(process.env.VITEST || process.env.VITEST_WORKER_ID);

export function record(spec, { file = OUTCOMES_PATH } = {}) {
  if (UNDER_TEST && file === OUTCOMES_PATH && !process.env.RUVNET_ADVOCACY_OUTCOMES) {
    throw new Error(
      'advocacy-outcomes.record() refused: a test tried to write to the REAL user ledger at '
      + `${OUTCOMES_PATH}. Pass {file: <tmp path>} or set RUVNET_ADVOCACY_OUTCOMES. `
      + '(A fixture row reached the live ledger this way once and was found only by an outside grader.)',
    );
  }
  const {
    id, action, at = new Date(), project = null,
    severity = null, stateHash = null, scope = null,
  } = spec || {};
  const err = (m) => { throw new Error(`Outcome for "${id ?? '?'}" invalid: ${m}`); };

  if (!id || typeof id !== 'string') err('missing id — an outcome that cannot name the recommendation it belongs to measures nothing');
  if (!ACTION_VALUES.has(action)) err(`action must be one of: ${[...ACTION_VALUES].join(', ')}`);
  // `scope:'forever'` is the one-action permanent silence ADR-028 requires ("anything that speaks
  // in-session must be silenceable in one action, permanently, without penalty"). It is meaningless
  // on anything but a dismissal, and accepting it elsewhere would let a stray field mute a card
  // nobody asked to mute.
  if (scope !== null && scope !== 'forever') err(`scope must be null or "forever" (got ${JSON.stringify(scope)})`);
  if (scope === 'forever' && action !== ACTIONS.DISMISSED) err('scope:"forever" is only meaningful on a dismissal');

  const row = {
    v: 1,
    id: id.slice(0, MAX_ID),
    action,
    at: toIso(at),
    // The project is recorded but is NOT a scope — see shouldStillOffer(). It is here so the ledger
    // can answer "where did this happen", which is what ADR-028's L5 test is phrased in terms of.
    project: String(project ?? path.basename(process.cwd())).slice(0, MAX_PROJECT),
    severity: severity === null ? null : String(severity).slice(0, MAX_SEVERITY),
    stateHash: stateHash === null ? null : String(stateHash).slice(0, MAX_HASH),
    scope: scope ?? null,
  };

  try {
    appendLine(file, row);
    return { ok: true, file, row };
  } catch (e) {
    // Over-cap is a programming error and was already thrown by appendLine before any write; an
    // ENOSPC/EACCES/EROFS is the environment. Both arrive here as a receipt so the caller can decide
    // how loud to be, and the reason is preserved rather than flattened to a boolean.
    return { ok: false, reason: e.code || e.message, row };
  }
}

/**
 * Read the ledger. NEVER THROWS — a missing file, a corrupt file, a half-written last line, a file
 * full of someone else's JSON: all of them degrade to "no outcomes yet".
 *
 * This is the same contract lesson-gate.mjs holds itself to and for the same reason: a mechanism
 * that suppresses recommendations must fail toward SPEAKING. If an unreadable ledger threw, or worse
 * returned a partial count that happened to look like a spent budget, a corrupt file would silence
 * the brain — and it would be silent in exactly the way it is silent when everything is healthy, so
 * nobody would ever find out.
 */
export function loadOutcomes(file = OUTCOMES_PATH) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch { continue; }   // torn or hand-mangled line: drop it, keep the rest
    if (!r || typeof r !== 'object') continue;
    if (typeof r.id !== 'string' || !r.id) continue;
    if (!ACTION_VALUES.has(r.action)) continue;      // an action we do not understand is not counted as one we do
    out.push({
      v: Number(r.v) || 1,
      id: r.id,
      action: r.action,
      at: typeof r.at === 'string' ? r.at : null,
      project: typeof r.project === 'string' ? r.project : null,
      severity: typeof r.severity === 'string' ? r.severity : null,
      stateHash: typeof r.stateHash === 'string' ? r.stateHash : null,
      scope: r.scope === 'forever' ? 'forever' : null,
    });
  }
  return out;
}

/**
 * The records for one id that the suppression arithmetic is allowed to see: everything appended
 * after the most recent `reset`.
 *
 * ORDERED BY FILE POSITION, NOT BY `at`. The timestamp comes from whichever process wrote it, and a
 * machine with a skewed clock (or a caller passing its own `at`, which record() permits) could
 * otherwise re-order a reset behind the dismissals it was meant to clear — resurrecting a
 * suppression the user explicitly lifted. Append order is the one ordering we actually control.
 */
function liveRecords(id, all) {
  const mine = all.filter((r) => r.id === id);
  let start = 0;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].action === ACTIONS.RESET) { start = i + 1; break; }
  }
  return mine.slice(start);
}

/**
 * What we know about one recommendation.
 *
 * `precision` is null — not 0 — when nothing has been offered yet. This is the repo's oldest live
 * rule: a detector once read a CLI's table and reported "26 hooks off" while the learner held 457
 * trajectories, because unknown rendered as off. A recommendation nobody has seen has an UNKNOWN
 * precision; rendering that as 0.00 would say "this advice is always rejected" about advice that has
 * never been given.
 */
export function outcomesFor(id, { file = OUTCOMES_PATH, all = null, project = null } = {}) {
  let recs = liveRecords(id, all ?? loadOutcomes(file));
  if (project) recs = recs.filter((r) => r.project === project);

  const count = (a) => recs.filter((r) => r.action === a).length;
  const applied = count(ACTIONS.APPLIED);
  const dismissed = count(ACTIONS.DISMISSED);
  const ignored = count(ACTIONS.IGNORED);
  const offered = applied + dismissed + ignored;

  const dismissals = recs.filter((r) => r.action === ACTIONS.DISMISSED);
  const offers = recs.filter((r) => OFFER_ACTIONS.has(r.action));
  const last = offers.length ? offers[offers.length - 1] : null;

  return {
    id,
    applied,
    dismissed,
    ignored,
    offered,
    precision: offered ? +(applied / offered).toFixed(4) : null,
    projects: [...new Set(recs.map((r) => r.project).filter(Boolean))],
    silencedForever: dismissals.some((r) => r.scope === 'forever'),
    lastAction: last?.action ?? null,
    lastAt: last?.at ?? null,
    lastSeverity: [...offers].reverse().find((r) => r.severity)?.severity ?? null,
    lastDismissal: dismissals.length ? dismissals[dismissals.length - 1] : null,
  };
}

/**
 * Should this recommendation be offered again? The question ADR-027 phrases as "dismissible, never
 * re-fires while dismissed".
 *
 * NOT SCOPED BY PROJECT, AND THAT IS THE POINT. A dismissal recorded while working in project A
 * suppresses the same recommendation in project B. This is the falsifiable L5 claim in ADR-028 —
 * "a lesson validated in project A demonstrably changes behaviour in project B" — expressed on the
 * signal we can actually observe today, and it is also just true of the subject matter: these
 * recommendations are about the user's MACHINE (a dormant learner, a corrupt store, a stale install),
 * so per-repo suppression would ask the same person the same question once per checkout.
 *
 * The order of the checks is the safety argument:
 *   1. Never offered  → offer. Silence has to be earned.
 *   2. Silenced forever → never. One action, permanent, no penalty, no severity override. A finding
 *      important enough to argue past an explicit permanent mute does not exist; that argument is
 *      what turns a notification system into spam.
 *   3. Budget by severity class → the asymmetry. A nag dies on one dismissal; a high-severity
 *      finding needs three, so a distracted click cannot bury a corrupt database.
 *   4. State-change reprieve, HIGH SEVERITY ONLY. New evidence re-opens a high-severity question,
 *      because the underlying risk genuinely changed. It does NOT re-open a suggestion: for a nag, a
 *      changed number is not new information worth interrupting a person for, and granting it a
 *      reprieve would let a flapping metric nag forever through a budget it had already spent.
 *   5. HARD_DISMISSAL_CAP overrides even that.
 */
export function shouldStillOffer(id, {
  severity = null, stateHash = null, file = OUTCOMES_PATH, all = null,
} = {}) {
  const o = outcomesFor(id, { file, all });

  if (o.silencedForever) return false;
  if (!o.offered) return true;

  // Severity is DERIVED per offer from evidence measured on this machine (ADR-028: "Severity is
  // derived from measured evidence on this machine. Nothing is IMPORTANT because it would be good
  // for adoption."), so the CURRENT call's severity wins over what history recorded. A capability
  // whose dormancy has become serious must not stay suppressed because it was cosmetic last month.
  const cls = weightClass(severity ?? o.lastSeverity);
  const budget = DISMISSAL_BUDGET[cls];

  // Dismissals count in full; silence counts at a fifth; having actually used it buys credit back.
  // Floor at zero so a long history of applies cannot bank immunity against a later refusal.
  const spend = Math.max(0, o.dismissed + (IGNORE_WEIGHT * o.ignored) - (APPLIED_CREDIT * o.applied));
  if (spend < budget) return true;

  if (o.dismissed >= HARD_DISMISSAL_CAP) return false;
  if (cls === 'high' && stateHash && o.lastDismissal?.stateHash && stateHash !== o.lastDismissal.stateHash) {
    return true;
  }
  return false;
}

/**
 * claimOffer — the ATOMIC step shouldStillOffer() cannot provide, and the reason it needs one.
 *
 * GPT-5.6-Sol found this in the ADR-047 duel and it is a genuine race, not a theoretical one: he
 * drove shouldStillOffer() to `true` while TWENTY offers for the same finding sat pending. The cause
 * is structural — shouldStillOffer() is a pure READ over the ledger. Two Claude Code sessions in two
 * terminals (the normal way this product is used) both read "not yet offered", both conclude yes,
 * and the user is told the same thing twice. Nothing between the read and the write said "mine".
 *
 * A lock around the whole decision would be the obvious fix and the wrong one: the decision reads
 * the ledger, and this repo has already been burned by holding a lock across a read (updateLessons
 * read outside its own lock and the "safe" version raced anyway). So the claim is narrow — it does
 * not protect the decision, it protects the RIGHT TO SPEAK.
 *
 * The primitive is `open(..., 'wx')`: exclusive create, which the OS guarantees is atomic. Exactly
 * one caller can create a given claim file; everyone else gets EEXIST and stays quiet.
 *
 * TTL, because a crashed session must not silence a capability forever. A claim older than ttlMs is
 * abandoned and may be taken over — the same reasoning as any lease. The default is deliberately
 * short: the cost of a stale claim is a MISSED offer (the product's whole reason to exist), while
 * the cost of taking one over early is a duplicate — annoying, not silencing. Between those two
 * failure modes, this system must always fail toward speaking.
 *
 * Returns true if THIS caller owns the right to offer. The caller then record()s the `offered` row.
 */
export function claimOffer(id, { dir = null, ttlMs = 60_000, now = Date.now() } = {}) {
  if (!id || typeof id !== 'string') return false;
  const base = dir || path.join(path.dirname(OUTCOMES_PATH), 'offer-claims');
  const key = crypto.createHash('sha256').update(id).digest('hex').slice(0, 24);
  const file = path.join(base, `${key}.claim`);

  try { fs.mkdirSync(base, { recursive: true }); } catch { return true; }   // cannot claim ⇒ fail toward speaking

  // WRITE-THEN-LINK, and the reason is a bug this file's own concurrency test caught.
  //
  // The obvious implementation is open(file,'wx') followed by write(). It is wrong, and it fails
  // exactly where it matters: `wx` publishes the filename BEFORE the content is written, so there is
  // a window in which the claim exists and is EMPTY. Competing processes read it, fail to parse it,
  // conclude "unknown age ⇒ stale ⇒ take it over", and speak. MEASURED with 12 real OS processes:
  // FIVE of twelve won. A single-process test would have shown one winner and hidden it completely.
  //
  // link() closes the window. The content is written to a private temp file first, so the moment the
  // claim name becomes visible it is already complete and parseable. link() itself fails with EEXIST
  // when the target exists, giving the same atomic exactly-one-winner guarantee — with no torn state
  // for the losers to misread.
  const take = () => {
    const tmp = `${file}.${process.pid}.${Math.abs(now % 1e9)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ id, at: new Date(now).toISOString(), pid: process.pid }));
      try {
        fs.linkSync(tmp, file);   // ATOMIC create-if-absent, content already durable
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') return true;   // an unexpected FS error must not silence us
        return null;                            // genuinely held — staleness decided below
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      }
    } catch { return true; }   // cannot even stage a claim ⇒ fail toward speaking
  };

  const first = take();
  if (first !== null) return first;

  // Someone holds it. Stale?
  let heldAt = 0;
  try { heldAt = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).at) || 0; } catch { heldAt = 0; }
  if (now - heldAt < ttlMs) return false;   // live claim — stay quiet, this is the duplicate we came to prevent

  // Abandoned. Take it over by REPLACING atomically, so two reapers cannot both win.
  const tmp = `${file}.${process.pid}.${key.slice(0, 6)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ id, at: new Date(now).toISOString(), pid: process.pid, tookOver: true }));
    fs.renameSync(tmp, file);   // atomic replace
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return true;   // could not arbitrate ⇒ fail toward speaking
  }
}

/** Release a claim once the offer is resolved (applied/dismissed), so a later dormancy can re-offer. */
export function releaseClaim(id, { dir = null } = {}) {
  if (!id || typeof id !== 'string') return false;
  const base = dir || path.join(path.dirname(OUTCOMES_PATH), 'offer-claims');
  const key = crypto.createHash('sha256').update(id).digest('hex').slice(0, 24);
  try { fs.unlinkSync(path.join(base, `${key}.claim`)); return true; } catch { return false; }
}

/**
 * The pending offer for one id, or null. Pending = the most recent `offered` (since the last reset)
 * has no resolution after it. Ordered by file position, not `at`, for the same clock-skew reason as
 * liveRecords().
 */
function pendingOffer(id, all) {
  const mine = liveRecords(id, all);
  let idx = -1;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].action === ACTIONS.OFFERED) { idx = i; break; }
  }
  if (idx === -1) return null;                                  // never offered since the last reset
  for (let i = idx + 1; i < mine.length; i++) {
    if (OFFER_ACTIONS.has(mine[i].action)) return null;         // already resolved
  }
  return mine[idx];
}

/**
 * Every id with a currently-pending offer — the bulk, read-only form of the per-id check
 * pendingOffer() already makes inside reconcileApplied()/reconcileIgnored(). Exists so a CALLER can
 * decide its OWN staleness rule (wall-clock age, a newer offer superseding it, a session count) over
 * a real `at` timestamp, without re-implementing the reset-aware, position-ordered definition of
 * "pending" that lives here. Read-only: it records nothing and never throws.
 *
 * @returns {Array<{id:string, at:string|null, severity:string|null, project:string|null, stateHash:string|null}>}
 */
export function pendingOffers({ file = OUTCOMES_PATH, all = null } = {}) {
  let recs;
  try { recs = all ?? loadOutcomes(file); } catch { return []; }
  const ids = [...new Set(recs.map((r) => r.id))];
  const out = [];
  for (const id of ids) {
    const offer = pendingOffer(id, recs);
    if (offer) out.push({ id, at: offer.at, severity: offer.severity, project: offer.project, stateHash: offer.stateHash });
  }
  return out;
}

/**
 * THE NUMERATOR, DERIVED — not asserted. precision = applied ÷ (applied+dismissed+ignored), and until
 * now `applied` was recorded by nothing, so the number could only ever be 0 (once a dismissal landed)
 * or null. That is the inverse of the fabrication this file warns about in its header: not a beautiful
 * 1.0 from recording only the applies, but a permanent 0.0 from recording none of them — advocacy that
 * looks like pure nagging no matter how well it lands.
 *
 * The honest signal for "the user acted on our suggestion" is a state transition we can OBSERVE: a
 * capability we OFFERED, still pending, is now measured `on`. That is an APPLIED. We do not guess and
 * we do not credit an offer the user resolved some other way — only a pending offer whose capability
 * the audit now reports on. A capability that was already on when we offered it cannot go on again, so
 * it cannot be double-counted; and a dismissed or ignored offer is no longer pending, so turning it on
 * later (for reasons of their own) is not miscredited to us.
 *
 * NEVER THROWS — surfaces call it. Its writes go through record(), which returns a receipt on I/O
 * failure rather than throwing; a lost applied costs one row, never the caller.
 *
 * @param {Array<{key?:string,id?:string,state?:string}>} auditRows  the capability audit (auditAll()'s output)
 * @returns {string[]} the ids reconciled to `applied` this call
 */
export function reconcileApplied(auditRows, { file = OUTCOMES_PATH } = {}) {
  if (!Array.isArray(auditRows)) return [];
  let all;
  try { all = loadOutcomes(file); } catch { return []; }
  const done = [];
  for (const row of auditRows) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.key === 'string' ? row.key : (typeof row.id === 'string' ? row.id : '');
    if (!id) continue;
    if (row.state !== 'on') continue;                          // only a real, now-observed on-state
    const offer = pendingOffer(id, all);
    if (!offer) continue;                                       // nothing pending to credit
    const res = record({ id, action: ACTIONS.APPLIED, severity: offer.severity ?? null, project: offer.project ?? null }, { file });
    if (res.ok) {
      done.push(id);
      // keep the in-call view consistent so a duplicate id in auditRows can't be applied twice
      all.push({ id, action: ACTIONS.APPLIED, at: res.row.at, project: res.row.project, severity: res.row.severity, stateHash: null, scope: null });
    }
  }
  return done;
}

/**
 * THE DENOMINATOR'S MISSING THIRD — `ignored`, DERIVED, not guessed.
 *
 * ADR-028: precision = applied ÷ (applied + dismissed + ignored). `applied` was wired above by
 * reconcileApplied(); `dismissed` was always recorded, because a dismissal is a click and a click has
 * an event to hang a record on. `ignored` has no click — it is the ABSENCE of one — and this module
 * already refuses to record an absence on a guess (see stateHashOf returning null for no evidence,
 * outcomesFor's precision:null for no offers). An offer shown and never acted on nor dismissed is
 * invisible today, and invisible is optimistic: it silently shrinks the denominator, the mirror image
 * of the fabrication this file's header already names ("record only the applies").
 *
 * THE TRIGGER THIS BUILD CHOSE, AND WHY IT IS NOT A GUESS. "Ignored" is fundamentally a claim about
 * TIME — the offer sat there, unresolved, long enough that the silence means something rather than
 * "the user hasn't looked yet". This module has no clock of its own worth trusting for that: record()
 * lets a caller pass an arbitrary `at`, and liveRecords()/pendingOffer() deliberately order by file
 * position rather than timestamp for exactly the clock-skew reason documented on both of them. Picking
 * a threshold HERE (say, "offered more than N days ago") would be inventing evidence this file does
 * not have. So the staleness decision is left where the evidence actually lives — with the caller, who
 * can say "this offer is N sessions old" or "a newer offer for the same capability just superseded
 * it" — and reconcileIgnored() takes that decision as a plain list of ids rather than a clock. It stays
 * pure: no Date.now(), no session counter, nothing but the ledger already on disk.
 *
 * WHAT MAKES IT SAFE TO CALL WITH A WRONG OR STALE LIST. Passing an id is a PROPOSAL, not a command —
 * the ledger is the sole arbiter. For each id, the only question this function answers on its own
 * evidence is: is there a `pendingOffer` for this id right now (an `offered` since the last reset with
 * NO resolution after it)? That single check is what buys the three guarantees this build requires:
 *   - CANNOT double-count: the moment an id is recorded ignored, it IS a resolution — so any later
 *     call with the same id (a cron re-run, a duplicate in the same list) finds nothing pending.
 *   - CANNOT convert a real resolution: a caller that (wrongly) still lists an id the user applied or
 *     dismissed five minutes ago is a no-op, never an overwrite — pendingOffer() already sees the
 *     resolution and returns null, same as it does for reconcileApplied().
 *   - CANNOT invent an offer: an id that was never offered has no pendingOffer either, so a stray or
 *     misspelled id records nothing.
 *
 * NEVER THROWS — same contract as reconcileApplied(): a caller here is a surface or a scheduled job,
 * and a lost `ignored` costs one row, never the caller.
 *
 * @param {Array<string>} pendingIds  ids the CALLER has already judged pending AND stale — staleness
 *   (session age, wall-clock age, supersession by a newer offer) is entirely the caller's evidence;
 *   this function neither computes nor infers it, only verifies each id still has a real pendingOffer.
 * @returns {string[]} the ids actually reconciled to `ignored` this call — a subset of pendingIds,
 *   only those that still had an unresolved offer to resolve.
 */
export function reconcileIgnored(pendingIds, { file = OUTCOMES_PATH } = {}) {
  if (!Array.isArray(pendingIds)) return [];
  let all;
  try { all = loadOutcomes(file); } catch { return []; }
  const done = [];
  for (const raw of pendingIds) {
    const id = typeof raw === 'string' ? raw : '';
    if (!id) continue;
    const offer = pendingOffer(id, all);
    if (!offer) continue;   // already resolved, reset since, or never offered — nothing pending to mark
    const res = record({ id, action: ACTIONS.IGNORED, severity: offer.severity ?? null, project: offer.project ?? null }, { file });
    if (res.ok) {
      done.push(id);
      // keep the in-call view consistent so a duplicate id in pendingIds can't be recorded twice
      all.push({ id, action: ACTIONS.IGNORED, at: res.row.at, project: res.row.project, severity: res.row.severity, stateHash: null, scope: null });
    }
  }
  return done;
}

/**
 * ADR-028's precision metric: recommendations acted on ÷ recommendations fired. Target ≥ 0.60.
 *
 * A DISMISSAL IS NOT AN ACTION. It is in the denominator and never the numerator, even though the
 * user did click something. Counting it as "acted on" would let us hit target by annoying people
 * into clicking X, which is the precise behaviour the metric exists to catch — the number would rise
 * as the product got worse, and a metric that inverts under pressure is worse than no metric.
 *
 * `precision: null` when nothing has been offered, and `meetsTarget: null` below the sample floor.
 * One rejected offer is not a 0.00 precision rate, and reporting it as one would be the same
 * unknown-rendered-as-a-number failure this repo has a gate against. A grade we have not earned the
 * right to state is stated as "not yet measurable", loudly, in the return value.
 *
 * COUNTS EVERY RECORDED OFFER, INCLUDING BEFORE A RESET. shouldStillOffer() honours the reset
 * checkpoint because that is a user preference about the future; this is a measurement of how the
 * product has actually behaved, and letting a reset launder a bad precision score would make the one
 * number that judges us the one number we can clear.
 */
export function precision({ file = OUTCOMES_PATH, all = null, since = null, id = null } = {}) {
  let recs = (all ?? loadOutcomes(file)).filter((r) => OFFER_ACTIONS.has(r.action));
  if (id) recs = recs.filter((r) => r.id === id);
  if (since) {
    const cut = toIso(since);
    recs = recs.filter((r) => typeof r.at === 'string' && r.at >= cut);
  }

  const count = (a) => recs.filter((r) => r.action === a).length;
  const applied = count(ACTIONS.APPLIED);
  const dismissed = count(ACTIONS.DISMISSED);
  const ignored = count(ACTIONS.IGNORED);
  const offered = applied + dismissed + ignored;

  if (!offered) {
    return {
      precision: null, offered: 0, applied: 0, dismissed: 0, ignored: 0,
      target: PRECISION_TARGET, sufficient: false, meetsTarget: null,
      reason: 'no offers recorded yet — precision is unknown, not zero',
    };
  }

  const value = +(applied / offered).toFixed(4);
  const sufficient = offered >= MIN_PRECISION_SAMPLES;
  return {
    precision: value,
    offered, applied, dismissed, ignored,
    target: PRECISION_TARGET,
    sufficient,
    // The lower bound, not the point estimate — see PRECISION_ALPHA above. `offered` is the sample
    // and `applied` the successes, so withholding offers WIDENS this and can never buy a pass.
    lowerBound: +(precisionLowerBound(applied, offered) ?? 0).toFixed(4),
    meetsTarget: sufficient ? precisionLowerBound(applied, offered) >= PRECISION_TARGET : null,
    reason: sufficient
      ? (precisionLowerBound(applied, offered) >= PRECISION_TARGET
        ? null
        : `${applied}/${offered} applied — the point estimate is ${value}, but the 95% lower bound is `
          + `${(precisionLowerBound(applied, offered) ?? 0).toFixed(3)}, below the ${PRECISION_TARGET} target. `
          + 'More offers, not fewer, is the only way this clears.')
      : `only ${offered} offer(s) recorded — below the ${MIN_PRECISION_SAMPLES}-sample floor, so this is not yet judgeable against the target`,
  };
}

/**
 * Every id the ledger knows about, with its derived state. What a management surface renders — and
 * every field is computed from records on disk, never asserted.
 */
export function summarize({ file = OUTCOMES_PATH, all = null } = {}) {
  const recs = all ?? loadOutcomes(file);
  const ids = [...new Set(recs.map((r) => r.id))];
  return ids.map((id) => {
    const o = outcomesFor(id, { all: recs });
    return { ...o, suppressed: !shouldStillOffer(id, { all: recs, severity: o.lastSeverity }) };
  }).sort((a, b) => b.offered - a.offered);
}
