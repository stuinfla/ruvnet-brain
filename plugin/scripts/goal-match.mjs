// goal-match.mjs — L4 ANTICIPATORY: infer the GOAL, name the capability that serves it, and
// otherwise SAY NOTHING.
//
// PURE. No I/O, no network, no filesystem, no process.exit — same discipline as console-engine.mjs,
// and for the same reason: this file only DECIDES. It is a total function of (prompt, capabilities),
// so it is testable by table and can never, by construction, change the machine.
//
// ── THE CONSTRAINT THAT IS THE ENTIRE DESIGN ────────────────────────────────────────────────────
//
// ADR-027 (the constraint that keeps it honest) and ADR-028 (anti-goals) say the same thing twice,
// because it is the failure mode that kills this feature:
//
//   "This is goal-aware capability matching, NOT evangelism. Recommending a tool to someone whose
//    problem it does not fit is the same failure in the opposite direction, and it is the FASTER
//    way to destroy trust, because it is indistinguishable from salesmanship."
//
// ADR-028's metric table makes it numeric and non-negotiable: false-alarm rate target is **0**,
// annotated "one false alarm costs more trust than ten true ones earn." Recall's target is 0.80 —
// deliberately lower. **The asymmetry is the specification.** This module is therefore built to
// return [] and treats every match as something it must earn. If you are ever choosing between a
// miss and a false positive here, take the miss; that choice is already made, in the ADR, on
// purpose.
//
// ── WHY KEYWORD MATCHING ALONE WOULD SHIP A LIAR ────────────────────────────────────────────────
//
// Look at the actual vocabulary of the eleven capabilities in capability-registry.auditAll():
// memory, hooks, routing, sessions, context, patterns, gates, cache, nightly, learning. **Every
// single one of those words is a homonym for something in ordinary software work**, and the other
// meaning is far more common in a developer's prompt:
//
//     "fix the memory leak"        → C heap, not AgentDB
//     "my useEffect hook fires 2x" → React, not ruflo hooks
//     "set up routing for /admin"  → a router, not cheap-model routing
//     "the session cookie expires" → HTTP, not a Claude session
//     "our nightly build failed"   → CI, not the KB refresh
//     "the model isn't learning"   → gradient descent, not workflow learning
//
// A bag-of-words detector fires on all six and is wrong all six times. That is not a hypothetical:
// this project already shipped exactly this bug in a different costume — a detector that read a
// CLI's human-readable table and announced "26 hooks off" while the learner held 457 trajectories.
// It matched a surface pattern and reported the match as a fact.
//
// So a goal here requires TWO INDEPENDENT KEYS, and one alone is never enough:
//
//   1. INTENT  — the prompt describes the problem the capability actually solves.
//   2. SUBJECT — the thing being discussed is the user's AI/agent workflow, not their application.
//
// plus a VETO list that only ever contains disambiguators for words this file genuinely uses. A
// veto for a word we never match on would be superstition, not engineering.
//
// The two-key rule is what makes "fix the memory leak in my C++ parser" silent: INTENT plausibly
// matches, SUBJECT does not match at all, and the veto catches it a second time. Belt and braces,
// because the cost of being wrong here is measured in trust rather than in a stack trace.

/**
 * SUBJECT — evidence that the conversation is about the user's AI assistant and how it works,
 * rather than about code the user is writing.
 *
 * This is the load-bearing half of the two-key rule. Every entry names the ASSISTANT or the
 * ASSISTANT'S WORKFLOW explicitly. Nothing here can be satisfied by a prompt about a web app, which
 * is the property that produces silence on the negative table.
 */
const SUBJECT = Object.freeze([
  /\bclaude\b/,
  /\b(my|the|this) (ai|assistant|agent|llm|copilot)\b/,
  /\b(coding|ai) (agent|assistant)\b/,
  /\bcursor\b/,
  /\bruflo\b/, /\bruvnet\b/, /\bruvector\b/, /\bagentdb\b/, /\bmcp\b/,
  /\bclaude[ .-]?md\b/,
  /\b(every|each|new|another) (chat|conversation|session)\b/,
  /\bacross (sessions|chats|conversations|projects)\b/,
  /\bcontext window\b/,
  /\bcompact(s|ed|ion|ing)?\b/,
  /\b(my|our) (workflow|setup|harness|stack|tooling)\b/,
  /\bit keeps\b/,          // "it keeps forgetting" — the assistant, in the user's own voice
  /\bit forgets\b/,
  /\bit never\b/,
  /\bit doesn'?t\b/,
]);

/**
 * GLOBAL_VETO — the prompt is about building or operating SOFTWARE, so our whole vocabulary is
 * being used in its other sense.
 *
 * DELIBERATELY OVER-BROAD. Some of these ("deploy", "production") could appear in a prompt that was
 * genuinely about the user's AI workflow, and vetoing it costs us a true positive. That trade is
 * made knowingly and in one direction only, per ADR-028: recall 0.80, false alarms 0. A miss is
 * invisible. A false alarm reads as salesmanship, and you only get to do that once.
 */
const GLOBAL_VETO = Object.freeze([
  // — the assistant's words used as an application's words —
  /\bmemory leak\b/, /\bheap\b/, /\bmalloc\b/, /\bvalgrind\b/, /\bgarbage collect/, /\boom\b/, /\bram\b/,
  /\buse(effect|state|context|memo|callback|ref)\b/, /\breact hook/, /\bcustom hook/, /\blifecycle hook/,
  /\b(react|next|vue|express|api) rout/, /\brouter\b/, /\b\/api\//, /\bendpoint\b/, /\bmiddleware\b/,
  /\bsession (cookie|token|id|storage)\b/, /\bjwt\b/, /\bexpress-session\b/, /\bcookie\b/,
  // Auth owns the word "session" at least as strongly as we do. These began as a veto private to
  // the losing-work goal, and a test proved that scoping WRONG: suppressing one goal simply handed
  // "forgets the login state and starts over from scratch" to a different goal, which recommended
  // the learning capabilities instead. A prompt about authentication is application work outright,
  // so the disambiguation belongs here, once, globally — not per-goal, where it silences one
  // claimant and leaves ten others holding the same bad match.
  /\blogin\b/, /\bauth(entication)?\b/, /\bsign ?(in|out)\b/, /\blogged (in|out)\b/,
  /\bnightly (build|release)\b/, /\bci (pipeline|gate|job)\b/, /\bgithub actions\b/, /\bquality gate\b/,
  /\bcache-control\b/, /\bhttp cache\b/, /\bcdn\b/, /\bredis\b/, /\bmemcached\b/,
  /\bnpm outdated\b/, /\bdependabot\b/, /\bdependenc(y|ies)\b/,
  /\bregex(p)? pattern\b/, /\bdesign pattern\b/,
  // — machine learning, which owns "learn", "train", "model" and "pattern" outright —
  /\btraining (loss|data|set)\b/, /\boverfit/, /\bepochs?\b/, /\bgradient\b/, /\bhyperparameter/,
  /\bpytorch\b/, /\btensorflow\b/, /\bneural net/, /\bdataset\b/, /\bfine-?tun/,
  // — building AGAINST an AI API is app work, not workflow work; "claude" appears in both —
  /\bsdk\b/, /\bapi key\b/, /\brate limit/, /\b429\b/, /\bmy app\b/, /\bproduction\b/,
  /\bend users\b/, /\bcustomers\b/, /\bdeploy(ing|ment)?\b/,
]);

/**
 * GOALS — the closed taxonomy.
 *
 * EVERY goal here is reverse-engineered from a real capability's own `whatItBuysYou` string in
 * capability-registry.auditAll(). None was invented from a sense of what would be nice to detect.
 * That direction of derivation is the point: a goal no shipped capability serves is a goal whose
 * only possible outcome is a recommendation we cannot fulfil, which is the salesmanship failure
 * arriving by a side door.
 *
 * `serves` holds capability KEYS, not labels — labels are prose for humans and drift; keys are the
 * registry's identity.
 */
export const GOALS = Object.freeze([
  {
    id: 'reteaching-every-project',
    because: 'You are re-teaching the same rule in project after project',
    serves: ['cross-project-lessons'],
    intent: [
      /\bre-?(explain|teach|state|specify)/,
      /\b(every|each|another|a new) (new )?(project|repo|repository|codebase)\b/,
      /\bsame (rule|standard|convention|instruction|correction|preference|guideline)/,
      /\bkeep (telling|reminding|explaining)/,
      /\b(over and over|again and again)\b/,
      /\bproject by project\b/,
    ],
  },
  {
    id: 'corrections-not-obeyed',
    because: 'You are correcting the same behaviour more than once',
    serves: ['lessons-in-force'],
    intent: [
      /\bignor(es|ing|ed) (my|the|these)\b/,
      /\balready (told|asked|corrected)\b/,
      /\bsame mistake\b/,
      /\bkeeps? (doing|making|repeating)\b/,
      /\b(won'?t|doesn'?t|does not) (follow|listen|respect|obey)\b/,
      /\bcorrected (it|this|that) (again|twice|three times|\d+ times)\b/,
    ],
  },
  {
    id: 'losing-work-between-sessions',
    because: 'Work you established in one session is not surviving into the next',
    serves: ['session-capture'],
    intent: [
      /\bforget(s|ting)?\b/,
      /\bdoesn'?t remember\b/,
      /\blos(e|es|ing|t) (the |all )?(context|thread|history|everything)\b/,
      /\bstart(s|ing)? (over|from scratch)\b/,
      /\bafter (a |the )?(compact|restart)/,
      /\bwhen the (session|conversation) ends\b/,
    ],
  },
  {
    id: 'spend-too-high',
    because: 'You are paying top-tier model prices for work that does not need them',
    serves: ['cheap-model-routing'],
    intent: [
      /\b(bill|costs?|spend(ing)?|expensive|pricey)\b/,
      /\btoken (spend|usage|burn)\b/,
      /\bcheaper model\b/,
      /\bsave money\b/,
      /\bburning (through )?(credits|tokens|cash)\b/,
      /\bhow much (am i|i'?m) (paying|spending)\b/,
    ],
  },
  {
    id: 'notes-that-teach-nothing',
    because: 'You have accumulated notes and history that are never actually reused',
    serves: ['memory-distillation'],
    intent: [
      /\bdistill/,
      /\breusable patterns?\b/,
      /\bnever (recalls?|reuses?|surfaces?)\b/,
      /\b(notes|memories|decisions) (are )?(just )?(sitting|piling|pile)/,
      /\bdoesn'?t (use|recall|remember) (my|the|past|previous|old)\b/,
      /\bpast (sessions|work|decisions|notes)\b/,
    ],
  },
  {
    id: 'resolving-the-same-problem',
    because: 'You are solving the same problem from scratch instead of building on what worked',
    serves: ['learning-hooks', 'workflow-pattern-learning'],
    intent: [
      /\bsolv(e|es|ed|ing) the same\b/,
      /\bfrom scratch (every|each)\b/,
      /\b(doesn'?t|does not|never) (learn|improve|get better)\b/,
      /\bsame (problem|approach|bug|issue) (again|every)\b/,
      /\breinvent/,
      /\bwhat (worked|we did) last time\b/,
    ],
  },
  {
    id: 'catching-bad-writes-in-review',
    because: 'You are catching in review what should have been refused at write time',
    serves: ['write-gates'],
    intent: [
      /\bcatch(ing)? (it|them|this|that) in review\b/,
      /\b(stop|prevent|block) (it|claude|the agent|the ai) (from )?writ/,
      /\bkeeps? writing\b/,
      /\bguard ?rails?\b/,
      /\benforce (a|my|our|the) (rule|standard|convention|policy)\b/,
      /\bshould have (been )?(refused|blocked|stopped)\b/,
    ],
  },
  {
    id: 'needs-an-external-service',
    because: 'You want your AI to reach a service it currently cannot see',
    serves: ['mcp-servers'],
    intent: [
      /\bconnect (claude|it|the ai|the agent) to\b/,
      /\bhook (it|claude) up to\b/,
      /\b(access|read|see) my (notion|gmail|email|calendar|drive|slack|linear|jira|figma|notes)\b/,
      /\bcan'?t (see|reach|access) (my|our)\b/,
      /\bgive (it|claude) access to\b/,
    ],
  },
  {
    id: 'knowledge-going-stale',
    because: 'What your AI knows about your tools is drifting out of date',
    serves: ['nightly-refresh'],
    intent: [
      /\b(stale|outdated|out of date)\b/,
      /\bdoesn'?t know about the (new|latest)\b/,
      /\bold version of\b/,
      /\bknowledge ?base\b/,
      /\bkeeps? (citing|using) the old\b/,
    ],
  },
  {
    id: 'tuning-the-harness-itself',
    because: 'You are trying to work out which set of rules actually performs better',
    serves: ['harness-evolution'],
    intent: [
      /\bimprove (my|the) (prompt|rules|instructions|harness|setup)\b/,
      /\bwhich (prompt|rule|policy|version) (works|performs) better\b/,
      /\ba\/b test/,
      /\btune (my|the) (rules|instructions|prompt)\b/,
      /\bmeasure (which|whether) .{0,20}(prompt|rule)/,
    ],
  },
]);

/**
 * The floor, and the reason it sits where it does.
 *
 * BASE is deliberately BELOW the floor. That single fact encodes the rule that matters: one intent
 * cue plus one subject cue scores 0.55 and is therefore SILENT. A goal must be CORROBORATED — a
 * second intent cue or a second subject cue — before this module will say anything at all.
 *
 * One cue is a coincidence. Two is a statement.
 */
export const CONFIDENCE_FLOOR = 0.6;
const BASE = 0.55;
const PER_EXTRA_CUE = 0.12;
const MAX_EXTRA_CUES = 2;

/**
 * An 'unknown' capability is discounted, and this is the honesty rule from capability-registry's own
 * header made arithmetic: "'unknown' is a first-class state, and it outranks 'off' every single time
 * a probe could not run."
 *
 * We do not KNOW an unknown capability is dormant. Surfacing one is a guess about the machine on top
 * of a guess about the goal, so it must clear a higher bar of evidence — 0.85 pushes the minimum
 * corroborated score (0.67) back below the floor, meaning an unknown capability needs strictly more
 * than an 'off' one before it may be named. The `why` string never calls it "off" either.
 */
const UNKNOWN_DISCOUNT = 0.85;

/**
 * At most two. The nudge principle ("correct, clear, confident, proactive, deferential, never
 * pushy") does not survive a bulleted list of five things the user should turn on — that reads as a
 * pitch no matter how each line is worded. Anticipation that dumps its whole inventory is evangelism
 * with better targeting.
 */
const MAX_RESULTS = 2;

const hits = (text, patterns) => patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
const any = (text, patterns) => patterns.some((re) => re.test(text));

/**
 * Which goals the prompt supports, with a score. Exported for testing and introspection: a scorer
 * that cannot be examined in isolation is a scorer whose threshold nobody can defend.
 *
 * @param {string} promptText
 * @returns {Array<{goal: object, confidence: number, intentHits: number, subjectHits: number}>}
 */
export function classifyGoals(promptText) {
  if (typeof promptText !== 'string' || !promptText.trim()) return [];
  const text = promptText.toLowerCase();

  // Veto first, and veto globally. If the prompt is about software rather than about the assistant,
  // nothing below can rescue it and nothing below should get the chance to try.
  if (any(text, GLOBAL_VETO)) return [];

  const subjectHits = hits(text, SUBJECT);
  if (subjectHits === 0) return [];   // key 2 absent ⇒ every goal fails, no exceptions

  const out = [];
  for (const goal of GOALS) {
    const intentHits = hits(text, goal.intent);
    if (intentHits === 0) continue;   // key 1 absent

    const extra = Math.min(intentHits - 1, MAX_EXTRA_CUES) + Math.min(subjectHits - 1, MAX_EXTRA_CUES);
    const confidence = Math.min(0.95, BASE + extra * PER_EXTRA_CUE);
    out.push({ goal, confidence: +confidence.toFixed(4), intentHits, subjectHits });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * matchGoal — the L4 surface.
 *
 * Given what the user says they are trying to do, name the capability that serves THAT goal, and
 * only if it is not already serving them. Returns [] far more often than not; that is the feature.
 *
 * Three independent conditions must ALL hold before a single row comes back:
 *   1. the prompt clears the two-key test and the vetoes (classifyGoals),
 *   2. a capability the goal actually names is present in the audit, and is off or unknown,
 *   3. the resulting confidence clears CONFIDENCE_FLOOR after any state discount.
 *
 * @param {string} promptText            what the user said they are trying to do
 * @param {Array}  capabilities          rows from capability-registry.auditAll()
 * @returns {Array<{capability: object, why: string, confidence: number, goal: string}>}
 */
export function matchGoal(promptText, capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) return [];

  const scored = classifyGoals(promptText);
  if (scored.length === 0) return [];

  const byKey = new Map();
  for (const c of capabilities) if (c && typeof c.key === 'string') byKey.set(c.key, c);

  // Best row per capability. Two goals can legitimately point at the same capability; the user is
  // owed one sentence about it, from whichever goal explains it best — not the same suggestion twice
  // wearing different rationales.
  const best = new Map();

  for (const { goal, confidence } of scored) {
    for (const key of goal.serves) {
      const cap = byKey.get(key);
      if (!cap) continue;

      // Never advocate for something already working. A recommendation to switch on what is already
      // on is not merely useless — it proves to the reader that we did not look, and every other
      // claim we make is downgraded accordingly.
      const state = cap.state;
      if (state !== 'off' && state !== 'unknown') continue;

      const adjusted = +(confidence * (state === 'unknown' ? UNKNOWN_DISCOUNT : 1)).toFixed(4);
      if (adjusted < CONFIDENCE_FLOOR) continue;

      const prior = best.get(key);
      if (prior && prior.confidence >= adjusted) continue;
      best.set(key, { capability: cap, why: explain(goal, cap), confidence: adjusted, goal: goal.id });
    }
  }

  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_RESULTS);
}

/**
 * The sentence the user reads.
 *
 * Every clause is DERIVED — the goal's own `because`, the registry's own `label`, the registry's own
 * `whatItBuysYou`, and the registry's own `evidence` string verbatim. Nothing here is written to be
 * persuasive, because the moment this function starts generating copy it starts generating claims,
 * and a claim about the machine that did not come from a probe is the thing this repo exists to
 * refuse.
 *
 * The state clause is the specific guard: an 'unknown' capability is described as unreadable, never
 * as off. Reporting "off" for something we failed to measure is the exact defect that shipped as
 * "26 hooks off" against a learner holding 457 trajectories.
 */
function explain(goal, cap) {
  const stateClause = cap.state === 'unknown'
    ? 'whether this is already switched on could not be read on this machine'
    : 'it is switched off';
  const evidence = cap.evidence ? ` — ${cap.evidence}` : '';
  return `${goal.because}. ${cap.label} is the part of your stack that serves that: `
    + `${cap.whatItBuysYou} Right now ${stateClause}${evidence}.`;
}
