// console-engine.mjs — the PURE core of the Onboarding Console (ADR-0013 / DDD-0002).
//
// No I/O. No network. No filesystem. No process.exit. Everything here is a pure function of its
// inputs, so it is testable by table (see console-engine.test.mjs) and can never, by construction,
// change the machine. The server (onboarding-console.mjs) does the reading and the writing; this
// file only DECIDES. That separation is DDD context 4 (Recommendation is the one context with no
// I/O) and context 8 (Presentation holds no domain logic) made literal.
//
// The one invariant that matters most: a Recommendation CANNOT be constructed without evidence,
// a cost, and an undo — and, if it touches the machine, a plain-English impact statement. This is
// the ADR's principle 4 ("every recommendation carries evidence, cost, and a reversal") and Stuart's
// directive ("never change the machine without explaining, in plain words, what it does") enforced
// by the type factory rather than by a code review that can be forgotten.

import { cmpVersion } from './stack-sync.mjs';

// ── Recommendation factory — the schema gate ─────────────────────────────────────────────────────
// Throws, loudly, on any recommendation that could become an irreversible or unexplained mutation.
// A throw here is a developer error caught at construction, not a runtime surprise for the user.
// Blast-radius of a recommendation, mirroring capability-registry.mjs's SCOPE (kept as literals here
// to avoid importing that whole module into the engine). `null` is the honest "scope not stated" —
// the console groups those into their own bucket rather than guessing which side they fall on.
const REC_SCOPES = new Set(['project', 'user', 'machine']);

export function makeRecommendation(spec) {
  const { id, title, rationale, severity, touchesMachine, plainImpact, evidence, cost, change, undo, scope } = spec;
  const err = (m) => { throw new Error(`Recommendation "${id ?? '?'}" invalid: ${m}`); };

  if (scope != null && !REC_SCOPES.has(scope)) err(`bad scope ${scope} (expected project|user|machine or omitted)`);
  if (!id || typeof id !== 'string') err('missing id');
  if (!title) err('missing title');
  if (!['INFO', 'SUGGESTED', 'IMPORTANT'].includes(severity)) err(`bad severity ${severity}`);
  if (!Array.isArray(evidence) || evidence.length === 0) err('evidence[] must be non-empty (we may only suggest what we SAW)');
  for (const e of evidence) if (!e || !e.observed) err('every evidence item needs an `observed`');
  if (!cost || typeof cost !== 'object') err('cost is required (time/latency/$/risk)');
  if (!change || !change.human) err('change is required and must be human-describable');
  if (!undo || !undo.human) err('undo is required — a change with no recorded inverse may not be offered');
  if (touchesMachine === true && (!plainImpact || plainImpact.length < 40)) {
    err('touchesMachine:true requires a plain-English `plainImpact` (what happens to the computer + why it is safe/reversible)');
  }
  // Design law: nothing above SUGGESTED unless it was measured on THIS machine (evidence present ⇒
  // measured). We allow IMPORTANT only when there is at least one concrete observation, which the
  // non-empty evidence check above already guarantees. Freeze so Presentation cannot mutate it.
  return Object.freeze({
    id, title, rationale: rationale ?? '',
    severity,
    touchesMachine: touchesMachine === true,
    plainImpact: plainImpact ?? null,
    // The owner's "user-level vs per-project" question, made answerable: does applying this change
    // just this project, or every project on the machine? null = we did not state it (grouped
    // separately, never guessed). See the scope groups in addRecommendations().
    scope: scope ?? null,
    evidence, cost, change, undo,
  });
}

// ── Health & learning recommendations ────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS (2026-07-21, found by Stuart, not by us). The console detected that his AgentDB
// store was CORRUPT, computed a memory score of 49/100, rendered it into a card — and offered no
// fix. His words: "when it finds a problem, the fact that it didn't recommend a fix is
// unconscionable." He was right. Detection without a remedy is a nicer way of doing nothing.
//
// The same run exposed a second dormancy: the capture queue had grown to 1,884 undelivered events
// because the flush only fires on a clean SessionEnd, and sessions that compact, crash, or resume
// never reach it. Draining it took the learner from 5 trajectories / 7 patterns (last trained SIX
// DAYS earlier) to 412 / 412. The architecture was built, installed, active — and starving.
//
// Both become RECOMMENDATIONS here rather than console prose, so they inherit the schema gate above:
// nothing can be offered without evidence we actually observed, a stated cost, and a recorded undo.
// That is the difference between a card that worries you and a button that fixes it.
//
// @param {{ memory?: {dimensions?:Array}, learning?: {queueDepth?:number, lastTrainSeconds?:number|null, trajectories?:number} }} input
export function buildHealthRecommendations({ memory = null, learning = null } = {}) {
  const recs = [];

  // 1. Store corruption. SQLite "wrong # of entries in index" is INDEX damage, not data loss —
  //    REINDEX rebuilds indexes from the intact table. Measured live 2026-07-21 on the real store:
  //    1193 rows before, 1193 after, integrity_check ok. That measured no-data-loss result is what
  //    makes this safe to offer as one click instead of a warning to go read about.
  const corrupt = (memory?.dimensions || []).find(
    (d) => d?.status === 'fail' && /corrupt|integrity/i.test(String(d?.detail || '')),
  );
  if (corrupt) {
    recs.push(makeRecommendation({
      id: 'repair:memory-index',
      scope: 'project',
      title: 'Repair your memory store',
      rationale: 'A corrupt index makes counts and lookups wrong — it is why saved lessons can read as zero when they are still there.',
      severity: 'IMPORTANT',
      touchesMachine: true,
      plainImpact:
        'Rebuilds the database indexes for your project memory. Your memories themselves are never touched — '
        + 'index damage is not data loss — and a full backup is taken first, so this is reversible.',
      evidence: [{ observed: String(corrupt.detail || 'integrity_check reported a corrupt index') }],
      cost: { time: 'seconds', risk: 'low — indexes rebuilt from the intact table; backup taken first' },
      change: { human: 'back up the store, REINDEX it, then re-run integrity_check to prove it is clean' },
      undo: { human: 'restore the backup taken immediately before the repair' },
    }));
  }

  // 2. A capture queue that fills but does not drain. The depth IS the evidence.
  const depth = Number(learning?.queueDepth);
  if (Number.isFinite(depth) && depth > 50) {
    recs.push(makeRecommendation({
      id: 'learning:flush',
      scope: 'user',
      title: 'Feed your captured work into the learner',
      rationale: 'Your AI captured this work, but none of it has reached the learner yet — so none of it has taught it anything.',
      severity: 'IMPORTANT',
      touchesMachine: true,
      plainImpact:
        'Sends events already captured on your own machine into the local learner so it improves from them. '
        + 'Nothing leaves your computer, and the queue is kept intact if the feed fails.',
      evidence: [{ observed: `${depth} captured events waiting, undelivered` }],
      cost: { time: 'under a minute', risk: 'low — local only; queue preserved on failure' },
      change: { human: 'drain the capture queue into the learner' },
      undo: { human: 'nothing to reverse — this only adds observations; learned state can be cleared separately' },
    }));
  }

  // 3. A learner that has not trained in days. Installed-but-dormant is a DEFECT, not a neutral
  //    state — the entire point of shipping a learning system is that it runs.
  const STALE_TRAIN_SECONDS = 60 * 60 * 24 * 2; // two days
  const age = Number(learning?.lastTrainSeconds);
  if (Number.isFinite(age) && age > STALE_TRAIN_SECONDS) {
    recs.push(makeRecommendation({
      id: 'learning:train',
      scope: 'project',
      title: 'Your learner has gone quiet',
      rationale: 'It is installed and switched on, but it has not learned anything recently — so it is not getting smarter.',
      severity: 'SUGGESTED',
      touchesMachine: true,
      plainImpact:
        'Runs one local training cycle so recent work becomes patterns it can reuse next time. '
        + 'Runs on your machine only and changes nothing about your projects.',
      evidence: [{ observed: `last trained ${(age / 86400).toFixed(1)} days ago (${learning?.trajectories ?? 0} trajectories recorded)` }],
      cost: { time: 'under a minute', risk: 'low — local, and the learned state is resettable' },
      change: { human: 'run one training cycle so captured work becomes reusable patterns' },
      undo: { human: 'the learned state can be reset, returning it to its pre-training condition' },
    }));
  }

  // 4. THE ONE THAT SHOULD HAVE FIRED ON DAY ONE — storage without learning.
  //
  //    Measured on the owner's machine 2026-07-21: 208 AgentDB stores, 156 with ZERO learns, and 87
  //    holding 154,106 memories between them while learning nothing at all. The console had
  //    `patterns` and `learns` on every fleet entry the entire time. It had the data and never said
  //    the sentence. His words: "you're basically storing a whole bunch of information that none of
  //    what you're using is changing how I do a damn thing... That should have been the first thing
  //    you noticed."
  //
  //    This is the North Star case: the capability was OWNED, INSTALLED, and OFF, and a tool that
  //    could see it stayed quiet because nobody asked. Knowing which question to ask is the scarce
  //    thing; supplying it is the job.
  //    THE HONESTY SPLIT (2026-07-21, second pass). The first version of this said "turn on the
  //    learning loop" for every store with `learns === false`. That was two lies in one button.
  //
  //    First, "the learning loop" is not a switch — memory-doctor has printed the ACTUAL fix since
  //    the day it was written: `embedded but never distilled — run: ruflo memory distill run`
  //    (rUv's ADR-174 pipeline: memory_entries → reasoning_patterns/episodes/causal_edges). We had
  //    the sentence and shipped a vaguer one.
  //
  //    Second, `learns === false` has two causes and only ONE of them is fixable this way. A store
  //    whose rows were never embedded (cover < 50%) cannot be distilled at all — there are no
  //    vectors to cluster. Offering it a distill button would burn the user's time and then report
  //    success having changed nothing. So only the genuinely distillable stores are counted here,
  //    and the un-embedded ones are named separately rather than silently folded in.
  const fleet = Array.isArray(learning?.fleet) ? learning.fleet : [];
  const populated = fleet.filter((f) => Number(f?.total || 0) > 0 && !f?.unreadable);
  const distillable = populated.filter(
    (f) => !f?.learns && Number(f?.coverPct ?? 0) >= 50 && Number(f?.patterns ?? 0) === 0,
  );
  const unembedded = populated.filter((f) => !f?.learns && Number(f?.coverPct ?? 0) < 50);

  if (distillable.length >= 3) {
    const memories = distillable.reduce((n, f) => n + Number(f.total || 0), 0);
    const evidence = [
      { observed: `${distillable.length} project stores are embedded but have never been distilled — they hold memories and zero patterns` },
      { observed: `${memories.toLocaleString()} memories sitting in those stores, teaching nothing` },
    ];
    // Never let the fixable count quietly absorb the unfixable ones. If some stores can't be helped
    // by this button, the card says so on the card — not in a footnote nobody reads.
    if (unembedded.length) {
      evidence.push({ observed: `${unembedded.length} further store${unembedded.length === 1 ? '' : 's'} have too little embedded to distill — this fix does NOT cover them` });
    }
    recs.push(makeRecommendation({
      id: 'learning:distill-fleet',
      scope: 'machine',
      title: 'You are storing memories that teach your AI nothing',
      rationale:
        'These projects captured plenty and embedded it — but nothing has ever mined it into reusable '
        + 'patterns. It is a filing cabinet, not experience.',
      severity: 'IMPORTANT',
      touchesMachine: true,
      plainImpact:
        'Runs RuvNet\'s own distillation over the memory stores that are ready for it, turning stored '
        + 'work into patterns your AI can reuse. Each store is snapshotted first, it runs entirely on '
        + 'your machine at no cost, and the snapshots can be restored if you want it undone.',
      evidence,
      cost: { time: 'a few minutes for a large store', usd: 0, risk: 'low — every store is snapshotted before it is touched' },
      change: { human: 'distill stored memories into reusable patterns (ruflo memory distill run)' },
      undo: { human: 'restore the snapshot taken of each store immediately before it was distilled' },
    }));
  }

  return recs;
}

// ── Capability recommendations — the capability-registry ⇄ "What we'd suggest" bridge ─────────────
//
// WHY THIS EXISTS. capability-registry.mjs answers "is X on?" and console.app.js's capabilities card
// renders that answer, but until this function existed nothing connected an OFF row to the one place
// this file already knows how to make a change safe: a schema-gated Recommendation with evidence,
// cost, a change, and a PROVEN undo. A capability could sit OFF on that card forever with no path from
// "here is the gap" to "here is the one-click fix" — the exact gap ADR-027 closed for health/stack/
// wiring findings, left open for capabilities.
//
// THE BAR IS HIGHER THAN "has a turnOn command". capability-registry.mjs's own header states turnOn
// is null unless the exact command was verified with --help — that proves the command EXISTS, not
// that its INVERSE has ever been run. Of the registry's rows, only `memory-distillation` clears both:
// distill-project.mjs's header records a live, round-tripped proof (644 → 648 patterns, restore →
// 644, re-run → 648, 2026-07-24) — an undo that has actually executed, not merely been promised in a
// comment (see that file's header for why "promised, never run" was this project's origin sin).
//
// So this is a small, explicit map, not "every row with a non-null turnOn". A second and third
// capability (most likely cross-project-lessons, then workflow-pattern-learning) join this map only
// once THEIR undo is independently proven the same way — never before (Rule 0: verify, don't assume).
const CAPABILITY_ELIGIBLE = {
  'memory-distillation': {
    title: 'Turn on memory distillation',
    scope: 'project',
    cost: { time: '~10s', usd: 0, risk: 'low' },
    undo: { human: 'restores the pre-distill snapshot exactly (proven 2026-07-24: 644→648 patterns, restore→644, re-run→648)' },
  },
};

/**
 * @param {{ capabilities?: Array<{key,label,state,scope,turnOn,evidence,whatItBuysYou}> }} input — the
 *   SAME rows capability-registry.mjs's auditAll() produces (or an equivalent shape in tests).
 * @returns Recommendation[] — empty for every row that is ON/IDLE/UNKNOWN/ABSENT, not on the eligible
 *   map above, or whose turnOn command is missing/parameterised. An empty array is the expected,
 *   correct answer for most calls: this is deliberately a narrow allowlist, not a general-purpose
 *   "offer anything OFF" mechanism.
 */
export function buildCapabilityRecommendations({ capabilities = [] } = {}) {
  const recs = [];
  for (const row of capabilities) {
    const spec = CAPABILITY_ELIGIBLE[row?.key];
    if (!spec) continue;                                              // not on the proven-undo map
    if (String(row.state || '').toLowerCase() !== 'off') continue;    // ON/IDLE/UNKNOWN/ABSENT: never — see header
    const cmd = row.turnOn && typeof row.turnOn.cmd === 'string' ? row.turnOn.cmd : '';
    if (!cmd || /<[^>]+>/.test(cmd)) continue;                        // no verified command, or one with a blank to fill in
    const evidence = typeof row.evidence === 'string' && row.evidence.trim()
      ? [{ observed: row.evidence.trim() }] : [];
    if (!evidence.length) continue;                                   // schema gate: never fabricate evidence
    recs.push(makeRecommendation({
      id: `enable:${row.key}`,
      scope: spec.scope,
      title: spec.title,
      rationale: typeof row.whatItBuysYou === 'string' ? row.whatItBuysYou : '',
      severity: 'SUGGESTED',
      touchesMachine: spec.scope !== 'project',
      plainImpact: spec.scope !== 'project' ? `Runs ${row.turnOn.human} on your computer.` : null,
      evidence,
      cost: spec.cost,
      change: { human: row.turnOn.human, cmd },
      undo: spec.undo,
    }));
  }
  return recs;
}

// ── Stack recommendations ────────────────────────────────────────────────────────────────────────
// Inputs come from stack-sync.auditModel(): rows[{name,installed,target,state,tag}], stale[{name,version,global,dir}].
// AHEAD is legal and produces NO recommendation — that modelling choice is what makes the
// alpha-vs-latest downgrade war structurally impossible (see stack-sync.mjs header).
export function buildStackRecommendations({ rows = [], stale = [] } = {}) {
  const recs = [];
  const behind = rows.filter((r) => r.state === 'BEHIND');
  const broken = rows.filter((r) => r.state === 'BROKEN' && r.target);

  for (const r of behind) {
    recs.push(makeRecommendation({
      id: `sync:${r.name}`,
      scope: 'machine',
      title: `Update ${r.name} — ${r.installed} → ${r.target}`,
      rationale: `A newer version is available on the @${r.tag} track you follow.`,
      severity: 'SUGGESTED',
      touchesMachine: true,
      plainImpact: `This updates ${r.name} on your computer from version ${r.installed} to ${r.target}. ` +
        `It's the very same tool you already use — just the current version, like updating an app. Your ` +
        `existing work and settings are left alone, it never installs an older version, and if anything ` +
        `looks off you can put ${r.installed} back with one click.`,
      evidence: [{ observed: `${r.name} installed at ${r.installed}; @${r.tag} is ${r.target}`, source: 'stack-sync.auditModel' }],
      cost: { time: '~10–40s', latency: 'none after', usd: 0, risk: 'low' },
      change: { kind: 'run-script', human: `install ${r.name}@${r.target} into your one global copy`, cmd: 'stack-sync --sync', target: r.name, to: r.target },
      undo: { kind: 'reinstall-version', human: `reinstall ${r.name}@${r.installed}`, target: r.name, to: r.installed },
    }));
  }
  for (const r of broken) {
    recs.push(makeRecommendation({
      id: `repair:${r.name}`,
      scope: 'machine',
      title: `Repair ${r.name} — installed copy is unreadable`,
      rationale: `A copy is present but has no readable version, usually a half-finished install.`,
      severity: 'IMPORTANT',
      touchesMachine: true,
      plainImpact: `Your computer has a broken, half-installed copy of ${r.name}. This cleanly reinstalls ` +
        `the current version (${r.target}) so it works again. Nothing else is affected, and the previous ` +
        `broken files are backed up first.`,
      evidence: [{ observed: `${r.name} present on disk with no readable version; registry has ${r.target}`, source: 'stack-sync.auditModel' }],
      cost: { time: '~10–40s', latency: 'none after', usd: 0, risk: 'low' },
      change: { kind: 'run-script', human: `reinstall ${r.name}@${r.target}`, cmd: 'stack-sync --sync', target: r.name, to: r.target },
      undo: { kind: 'none-needed', human: `the broken copy is backed up; a reinstall is safe to leave in place` },
    }));
  }
  if (stale.length) {
    const names = [...new Set(stale.map((s) => s.name))];
    recs.push(makeRecommendation({
      id: 'purge:shadows',
      scope: 'machine',
      title: `Remove ${stale.length} stale duplicate cop${stale.length === 1 ? 'y' : 'ies'}`,
      rationale: `Older duplicate copies in a temporary cache can preempt your up-to-date global copy.`,
      severity: 'IMPORTANT',
      touchesMachine: true,
      plainImpact: `Your computer has ${stale.length} extra, older cop${stale.length === 1 ? 'y' : 'ies'} of ` +
        `RuvNet tools (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}) tucked away in a temporary ` +
        `folder. Those stale copies can quietly get used instead of your current ones. This removes them — your ` +
        `main, newer copies stay exactly as they are, and the temporary folder rebuilds itself automatically if ` +
        `it's ever needed. Nothing you use stops working.`,
      evidence: stale.slice(0, 8).map((s) => ({ observed: `${s.name}@${s.version} in npx cache while global is ${s.global}`, source: 'stack-sync.findShadows' })),
      cost: { time: '~1s', latency: 'none', usd: 0, risk: 'low' },
      change: { kind: 'run-script', human: 'delete the stale temporary copies', cmd: 'stack-sync --sync' },
      undo: { kind: 'auto-rebuild', human: 'the temporary cache re-fills itself on next use; no manual step needed' },
    }));
  }
  return recs;
}

// ── Wiring recommendations ───────────────────────────────────────────────────────────────────────
// Input: wiring survey sites[{project, mechanism, ...}]. We recommend de-npx-ing a project only when
// it has NPX resolution sites. This reuses reconcile-project.mjs (which backs up + is idempotent).
export function buildWiringRecommendations({ sites = [] } = {}) {
  const byProject = new Map();
  for (const s of sites) {
    if (s.mechanism !== 'NPX') continue;
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  const recs = [];
  for (const [project, npxSites] of byProject) {
    recs.push(makeRecommendation({
      id: `reconcile:${project}`,
      scope: 'project',
      title: `Speed up “${project}” — ${npxSites.length} tool call${npxSites.length === 1 ? '' : 's'} download a fresh copy each time`,
      rationale: `These launch RuvNet tools via npx, which re-downloads on every run and can silently use a stale copy.`,
      severity: 'SUGGESTED',
      touchesMachine: true,
      plainImpact: `Right now the project “${project}” starts its RuvNet tools by fetching a fresh copy every ` +
        `single time they run — that's slower, and it can quietly run an out-of-date version without telling you. ` +
        `This switches it to use the one copy already installed on your computer: faster, and always the version ` +
        `you expect. We back up the project's settings files first, and you can restore them with one click.`,
      evidence: npxSites.slice(0, 8).map((s) => ({ observed: `${s.file} · ${s.event}: ${String(s.spec).slice(0, 80)}`, source: 'wiring survey' })),
      cost: { time: '~1s', latency: 'faster after (no per-call download)', usd: 0, risk: 'low' },
      change: { kind: 'run-script', human: `rewire “${project}” to the global binary`, cmd: `reconcile-project --apply --project ${project}`, project },
      undo: { kind: 'restore-backup', human: `restore the .bak-reconcile-* settings files written before the change` },
    }));
  }
  return recs;
}

// ── Memory-health scoring ────────────────────────────────────────────────────────────────────────
// DDD context 6. A dimension that was NOT probed is listed in notTested[] and contributes to NEITHER
// the numerator nor the denominator — it can never inflate OR deflate the score. A tested dimension
// that is FAIL caps the whole score below "healthy" (house rule: a known-broken dimension caps it,
// no inflated scores). Nothing is ever scored from an assumption.
export const MEMORY_DIMENSIONS = [
  { key: 'liveness', label: 'Liveness', weight: 25, why: 'a real store→search round-trip on the path actually in use' },
  { key: 'coverage', label: 'Coverage', weight: 20, why: 'a project checkpoint exists and is fresh' },
  { key: 'recallQuality', label: 'Recall quality', weight: 25, why: 'a synthetic question actually surfaces the checkpoint in top-k' },
  { key: 'compactionSurvival', label: 'Compaction survival', weight: 15, why: 'a PreCompact snapshot was written' },
  { key: 'sessionSurfacing', label: 'Session surfacing', weight: 15, why: 'session start puts project state in front of the model' },
];

// probes: { [key]: { status: 'ok'|'warn'|'fail'|'notTested', detail } }. A key absent from probes,
// or explicitly 'notTested', is treated as not probed.
export function scoreMemoryHealth({ project, probes = {} }) {
  const earnedFor = (status, weight) => (status === 'ok' ? weight : status === 'warn' ? weight * 0.5 : 0);
  const dimensions = [];
  const notTested = [];
  let earned = 0, testedWeight = 0, anyFail = false;

  for (const d of MEMORY_DIMENSIONS) {
    const p = probes[d.key];
    const status = p?.status ?? 'notTested';
    if (status === 'notTested') {
      notTested.push(d.key);
      dimensions.push({ key: d.key, label: d.label, status: 'notTested', detail: p?.detail ?? `not checked this session — ${d.why}`, deduction: 0, weight: d.weight });
      continue;
    }
    const e = earnedFor(status, d.weight);
    earned += e; testedWeight += d.weight;
    if (status === 'fail') anyFail = true;
    dimensions.push({ key: d.key, label: d.label, status, detail: p.detail ?? d.why, deduction: +(d.weight - e).toFixed(1), weight: d.weight });
  }

  // No tested dimension ⇒ no score. We refuse to emit a number we did not measure (ADR verification #4).
  const raw = testedWeight === 0 ? null : Math.round((earned / testedWeight) * 100);
  const score = raw === null ? null : (anyFail ? Math.min(raw, 49) : raw);
  const summary = score === null
    ? 'not enough probed to score — nothing measured this session'
    : `${score}/100 across ${MEMORY_DIMENSIONS.length - notTested.length} probed dimension${MEMORY_DIMENSIONS.length - notTested.length === 1 ? '' : 's'}` +
      (notTested.length ? `; ${notTested.length} not checked` : '') + (anyFail ? '; capped by a broken dimension' : '');

  return { project: project ?? null, score, dimensions, notTested, cappedByFailure: anyFail, summary };
}

// ── Wiring summary (pure) ───────────────────────────────────────────────────────────────────────
export function summarizeWiring(sites = []) {
  const s = { npx: 0, global: 0, mcp: 0, plugin: 0, projectsWithNpx: 0 };
  const npxProjects = new Set();
  for (const site of sites) {
    if (site.mechanism === 'NPX') { s.npx++; npxProjects.add(site.project); }
    else if (site.mechanism === 'GLOBAL_BINARY') s.global++;
    else if (site.mechanism === 'MCP') s.mcp++;
    else if (site.mechanism === 'PLUGIN') s.plugin++;
  }
  s.projectsWithNpx = npxProjects.size;
  return s;
}

// Re-export the single comparator so nothing downstream is tempted to compare versions itself.
export { cmpVersion };
