#!/usr/bin/env node
/**
 * lesson-lifecycle.mjs — the two ends of a lesson's life that were never built: when it stops
 * mattering, and when it turns out to matter everywhere.
 *
 * WHY THIS FILE EXISTS. ADR-029 shipped promotion and then said, in its own "Deliberately NOT in
 * this round":
 *
 *     "Demotion. A promoted rule that stops being useful should fall back out... We have no outcome
 *      signal yet, so we cannot honestly implement it — and a promotion system with no demotion
 *      accumulates cruft forever. Tracked, not pretended."
 *
 * That was the right call then and it is the reason this file is shaped the way it is. There are two
 * opposite ways to get retirement wrong, and only one of them is ever discussed:
 *
 *   the loud failure    the store fills with dead rules nobody reads, and a gate nobody reads is
 *                       prose with extra latency — the exact thing lesson-store.mjs exists to escape
 *   the silent failure  a safety rule is deleted because it HAPPENED NOT TO FIRE. A rule about not
 *                       leaking credentials fires once a year. Its silence is the rule WORKING.
 *
 * The second failure is unrecoverable and invisible, so the whole module is biased against it:
 *
 *   1. NOTHING HERE DELETES. Both functions return a PROPOSAL for a human. This module exports no
 *      writer at all — no save, no apply, no prune — and `tests/unit/lesson-lifecycle.test.mjs`
 *      asserts that by enumerating the exports. Removal stays where the user already controls it:
 *      `lesson-ratify.mjs --demote`, which is sticky (ADR-030 §5).
 *   2. A high-severity ratified rule can NEVER be auto-retired, under any signal, including a decade
 *      of silence. Rarity is what high severity MEANS; treating rarity as irrelevance inverts it.
 *   3. NO SIGNAL → NO PROPOSAL. "We never observed this" and "we watched and it never fired" are
 *      different facts, and only the second is evidence. Absent an outcome signal this module stays
 *      silent, which is ADR-029's position, still honoured rather than quietly abandoned.
 *
 * AND ON GENERALIZATION — the honest limit, stated up front. This does NOT rewrite a project rule
 * into a universal one. There is no model in this process, and a regex that strips the project noun
 * out of "always run scripts/gate.sh before shipping" yields "always run before shipping" — a
 * sentence that survives the filter and means nothing. So generalization here is a VERIFIER, not an
 * author: it takes a statement that is ALREADY free of project nouns, checks it was independently
 * rediscovered elsewhere (ADR-G008 "win twice", the same bar lesson-promote.mjs uses), and proposes
 * promoting it verbatim. Anything carrying a path, filename, repo, host, env var or product name is
 * refused and named. That refusal is the feature: a wrongly-promoted rule misdirects every project
 * at once, so this errs toward refusing good generalizations rather than accepting one bad one.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ORIGIN, SOURCE_CLASS, STATUS, ENFORCEMENT, loadLessons } from './lesson-store.mjs';

// ── The bars, in one place, as numbers a human can argue with ────────────────────────────────────
export const RETIREMENT = Object.freeze({
  // How long the outcome system must have WATCHED a lesson before its silence counts as evidence,
  // and how long since its last fire before that silence is called dormancy. One number for both,
  // because they are the same claim: "we looked for a quarter and nothing happened."
  SILENCE_DAYS: 90,
  // A lesson must have actually fired this many times before an override RATE means anything.
  // Two overrides out of two fires is a coin landing heads twice, not a verdict on the rule.
  MIN_FIRES_FOR_OVERRIDE: 5,
  // ...and then it must be overridden essentially always. A rule obeyed 1 time in 4 is still working
  // 25% of the time, and retiring it converts a partial win into a total loss.
  OVERRIDE_RATE: 0.8,
});

/** The minimum independent projects for generalization. ADR-G008's "win twice" — a floor, never a dial. */
export const MIN_PROJECTS = 2;

// ── Retirement ───────────────────────────────────────────────────────────────────────────────────

/**
 * Lessons that are NEVER auto-retired, no matter what the signals say.
 *
 * Both cases below are rules a human has already looked at and agreed to. The system does not get to
 * un-agree on their behalf because a counter stayed at zero — that is the model overturning the user
 * silently, which is the failure mode the whole trust boundary in lesson-store.mjs was built to stop,
 * pointed in the other direction.
 */
export function protectedFrom(lesson) {
  const ratified = lesson?.status === STATUS.RATIFIED || lesson?.status === STATUS.ACTIVE;
  if (!ratified) return null;
  if (lesson.severity === 'high') {
    return 'high-severity and ratified by a human — a rule that fires rarely is what "rare catastrophe" '
      + 'means, not evidence it stopped mattering. Only you can remove it: lesson-ratify --demote';
  }
  if (lesson.enforcement === ENFORCEMENT.BLOCK) {
    return 'a ratified blocking rule — blocking is reserved for non-negotiables, and a non-negotiable '
      + 'does not expire because it was not tested lately. Only you can remove it: lesson-ratify --demote';
  }
  return null;
}

/**
 * Read the outcome signals, refusing anything we cannot defend.
 *
 * Returns `{ ok: false, why }` for missing, incomplete, impossible or too-young data. Every one of
 * those is a case where the honest output is silence — a wrong retirement proposal costs the user
 * trust in the whole surface, and a user who stops trusting the list stops reading it.
 *
 * Expected shape (all counted within one observation window):
 *   { observedDays, fires, overrides, lastFiredDaysAgo? }
 */
export function readSignals(signals) {
  if (!signals || typeof signals !== 'object') {
    return { ok: false, why: 'no outcome signal has been recorded for this lesson — nothing to judge it on' };
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const observedDays = num(signals.observedDays);
  const fires = num(signals.fires);
  const overrides = num(signals.overrides ?? 0);
  const lastFiredDaysAgo = signals.lastFiredDaysAgo == null ? null : num(signals.lastFiredDaysAgo);

  if (observedDays === null || fires === null || overrides === null) {
    return { ok: false, why: 'outcome signal is incomplete (observedDays and fires are both required)' };
  }
  // Impossible readings mean the collector is broken. Acting on a broken collector is how the
  // read-only-connection failure (L01) happened: the measurement could not see what it claimed to.
  if (observedDays < 0 || fires < 0 || overrides < 0) {
    return { ok: false, why: 'outcome signal is malformed (negative counts) — the collector is wrong, not the lesson' };
  }
  if (overrides > fires) {
    return { ok: false, why: `outcome signal is impossible (${overrides} overrides of ${fires} fires) — a lesson cannot be overridden more often than it fired` };
  }
  if (observedDays < RETIREMENT.SILENCE_DAYS && fires === 0) {
    return {
      ok: false,
      why: `watched for only ${observedDays} of the ${RETIREMENT.SILENCE_DAYS} days required before silence means anything — not observed, which is not the same as not needed`,
    };
  }
  return { ok: true, observedDays, fires, overrides, lastFiredDaysAgo };
}

/**
 * Should this lesson be PROPOSED for retirement?
 *
 * `retire: true` never means "removed". It means "put this in front of the human with its numbers".
 * The returned `action` is `propose-to-human` in every branch that can reach it; there is no branch
 * that returns anything else, because there is no code here that removes anything.
 *
 * @param {object} lesson  a lesson from lesson-store.mjs
 * @param {object} signals { observedDays, fires, overrides, lastFiredDaysAgo? }
 * @returns {{retire: boolean, why: string, action: string, rule: string|null, protected: boolean, evidence: Array}}
 */
export function shouldRetire(lesson, signals) {
  const no = (why, extra = {}) => ({ retire: false, why, action: 'none', rule: null, protected: false, evidence: [], ...extra });

  if (!lesson || typeof lesson !== 'object') return no('not a lesson');
  // The user already said no to this one. Retirement has nothing to add, and re-surfacing a rejected
  // rule as "shall we reject it again?" is how a control starts feeling like noise.
  if (lesson.demoted) return no('already demoted by you — it never fires, so there is nothing to retire');

  const shield = protectedFrom(lesson);
  const read = readSignals(signals);

  // Protection is checked BEFORE the signals are even consulted, so that no arrangement of counters
  // — however extreme — can reach a retirement proposal for a rule a human ratified as critical.
  if (shield) return no(`never auto-retired: ${shield}`, { protected: true });
  if (!read.ok) return no(read.why);

  const { observedDays, fires, overrides, lastFiredDaysAgo } = read;

  // RULE 1 — dormancy. Deliberately unavailable to high-severity lessons even when unratified: their
  // whole point is a failure that is rare, so counting rarity against them is a category error.
  if (lesson.severity !== 'high') {
    if (fires === 0) {
      return {
        retire: true, action: 'propose-to-human', rule: 'dormant', protected: false,
        why: `never fired once in ${observedDays} days of observation at "${lesson.trigger}"`,
        evidence: [{ observed: `watched ${observedDays} days (bar: ${RETIREMENT.SILENCE_DAYS}); fired 0 times` }],
      };
    }
    if (lastFiredDaysAgo !== null && lastFiredDaysAgo >= RETIREMENT.SILENCE_DAYS && observedDays >= RETIREMENT.SILENCE_DAYS) {
      return {
        retire: true, action: 'propose-to-human', rule: 'dormant', protected: false,
        why: `last fired ${lastFiredDaysAgo} days ago, over ${observedDays} days of observation at "${lesson.trigger}"`,
        evidence: [{ observed: `fired ${fires} times total, none in the last ${lastFiredDaysAgo} days (bar: ${RETIREMENT.SILENCE_DAYS})` }],
      };
    }
  }

  // Reached only by a high-severity lesson, since the non-severe case returned above. Said out loud
  // rather than falling through to a generic "too few to judge", because the reason matters here.
  if (fires === 0) {
    return no(`no fires in ${observedDays} days, but this is high-severity — rarity is what high severity MEANS, so silence is not evidence against it`);
  }

  // RULE 2 — it fires and you ignore it. This one IS available to high-severity lessons that no human
  // has ratified, because here the user is actively voting against it every time it appears; silence
  // is absence of evidence, but a standing override is evidence.
  if (fires >= RETIREMENT.MIN_FIRES_FOR_OVERRIDE) {
    const rate = overrides / fires;
    if (rate >= RETIREMENT.OVERRIDE_RATE) {
      return {
        retire: true, action: 'propose-to-human', rule: 'always-overridden', protected: false,
        why: `fired ${fires} times and you proceeded anyway ${overrides} of those times (${Math.round(rate * 100)}%) — it is interrupting without changing anything`,
        evidence: [{ observed: `${overrides}/${fires} overrides = ${Math.round(rate * 100)}% (bar: ${Math.round(RETIREMENT.OVERRIDE_RATE * 100)}% over at least ${RETIREMENT.MIN_FIRES_FOR_OVERRIDE} fires)` }],
      };
    }
    return no(`fired ${fires} times and was obeyed ${fires - overrides} of them — still working`);
  }

  return no(`fired ${fires} time${fires === 1 ? '' : 's'} in ${observedDays} days — too few to judge either way (bar: ${RETIREMENT.MIN_FIRES_FOR_OVERRIDE})`);
}

/** Roll retirement up for a whole store. Read-only: returns a report, writes nothing. */
export function retirementReport(lessons = [], signalsById = {}) {
  const proposals = [];
  let shielded = 0;
  let unobserved = 0;
  for (const l of lessons) {
    const r = shouldRetire(l, signalsById[l.id]);
    if (r.retire) proposals.push({ id: l.id, statement: l.statement, ...r });
    else if (r.protected) shielded++;
    else if (!l.demoted && !signalsById[l.id]) unobserved++;
  }
  return {
    proposals,
    shielded,
    unobserved,
    scanned: lessons.length,
    headline: proposals.length
      ? `${proposals.length} lesson(s) have stopped earning their interruption`
      : 'nothing has met the retirement bar — no lesson is proposed for removal',
  };
}

// ── Generalization ───────────────────────────────────────────────────────────────────────────────

/**
 * PROJECT NOUNS — the tokens that must never be dragged into a universal rule.
 *
 * Each detector is narrow and named, so a refusal can say WHICH token blocked it and the user can
 * disagree with a specific thing rather than with a black box. Two deliberate omissions, stated
 * rather than hidden:
 *
 *   • Bare ALL-CAPS words are NOT treated as acronyms. The lessons in this very repo write
 *     "read a live source THIS TURN" — emphasis in caps is house style, and a detector that refused
 *     every emphatic sentence would refuse everything. Env-var shapes (underscored or digit-bearing)
 *     are still caught.
 *   • Lowercase hyphenated slugs (`ruvnet-brain`) are only caught via `knownProjects`, because the
 *     generic form is indistinguishable from ordinary English ("cross-project", "read-write").
 *
 * Both gaps are covered in practice by passing the project names, which the caller always has.
 */
const DETECTORS = [
  { kind: 'path', why: 'a filesystem path', re: /(?:^|[\s"'`([])(?:~|\.{1,2})?\/[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*/g },
  { kind: 'path', why: 'a Windows path', re: /\b[A-Za-z]:\\[^\s"']+/g },
  { kind: 'filename', why: 'a filename', re: /\b[\w-]+\.(?:mjs|cjs|jsx?|tsx?|json|jsonl|md|py|rs|sh|ya?ml|toml|sql|txt|html?|css|env|lock|db|rvf|ini|cfg|log)\b/gi },
  { kind: 'package', why: 'a scoped package name', re: /@[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/g },
  { kind: 'repo', why: 'an owner/repo or vendor/module slug', re: /\b[A-Za-z0-9]*[-_0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+|\b[A-Za-z]+\/[A-Za-z0-9._-]*[-_0-9][A-Za-z0-9._-]*/g },
  { kind: 'url', why: 'a URL', re: /(?:https?:\/\/|www\.)\S+/gi },
  { kind: 'host', why: 'a hostname', re: /\b[A-Za-z0-9-]+\.(?:com|io|dev|ai|org|net|sh|app|co|xyz|cloud)\b/gi },
  { kind: 'env-var', why: 'an environment variable', re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
  { kind: 'port', why: 'a port or address', re: /\bport\s*:?\s*\d{2,5}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/gi },
  { kind: 'product', why: 'a product or CamelCase proper noun', re: /\b[A-Z]?[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g },
  { kind: 'client', why: 'a client or company name', re: /\bclient\s+[A-Z][A-Za-z]+|\b[A-Z][A-Za-z]+\s+(?:Corp|Inc|LLC|Ltd|GmbH|PLC)\b/g },
];

/** Normalize a project directory name to the slug a statement would mention. */
function projectSlug(p) {
  return String(p || '')
    .replace(/^-Users-[^-]+-/, '')
    .replace(/^Code-/, '')
    .trim();
}

/**
 * Every project-specific noun in a text, as `{kind, why, token}`.
 * Exported because a refusal the user cannot inspect is a refusal they cannot argue with.
 */
export function projectNouns(text, { knownProjects = [] } = {}) {
  const s = String(text ?? '');
  const found = [];
  const seen = new Set();
  const add = (kind, why, token) => {
    const t = String(token).trim();
    const key = `${kind}:${t.toLowerCase()}`;
    if (!t || seen.has(key)) return;
    seen.add(key);
    found.push({ kind, why, token: t });
  };

  for (const d of DETECTORS) {
    for (const m of s.matchAll(d.re)) add(d.kind, d.why, m[0]);
  }

  // The strongest detector, because it needs no heuristic at all: the caller knows the project names.
  // Short slugs are skipped — a project called "brain" would match the word in any sentence about one.
  for (const p of knownProjects) {
    const slug = projectSlug(p);
    if (slug.length < 5) continue;
    for (const variant of new Set([slug, slug.replace(/-/g, ' '), slug.replace(/-/g, '')])) {
      const re = new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const m = s.match(re);
      if (m) add('project-name', 'the name of a project', m[0]);
    }
  }
  return found;
}

/** Collapse a statement to compare wording across projects. */
const normalizeText = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The full generalization decision WITH its reason, including on refusal.
 *
 * `proposeGeneralization` returns `null` on refusal per its contract; this is the version that says
 * why, so the console and the tests can show the user which specific thing blocked promotion instead
 * of a silent nothing.
 */
export function explainGeneralization(lesson, otherProjects = [], { minProjects = MIN_PROJECTS } = {}) {
  // A caller may demand MORE evidence, never less — the same clamp lesson-promote.mjs applies, for
  // the same reason: the bar is a property of the design, not a parameter of the call site.
  const bar = Math.max(MIN_PROJECTS, Number.isFinite(minProjects) ? minProjects : MIN_PROJECTS);
  const refuse = (why, extra = {}) => ({ ok: false, why, proposal: null, ...extra });

  if (!lesson || typeof lesson.statement !== 'string') return refuse('not a lesson');
  if (lesson.demoted) {
    return refuse('you demoted this lesson — generalization must never resurrect a rule you rejected, in any scope');
  }
  if (lesson.statement.trim().length < 15) return refuse('statement is too short to stand alone as a rule');

  // 1. INDEPENDENT REDISCOVERY. Counted from the corroborating projects the caller observed, NOT from
  //    the lesson's own `projects[]` — that array is written by whoever wrote the lesson, and the
  //    adversarial review's exact scenario was a planted lesson claiming its own cross-project
  //    provenance. Self-reported breadth is not evidence of breadth.
  const home = new Set((lesson.projects || []).map((p) => projectSlug(p).toLowerCase()));
  const corroborators = [];
  const seenProjects = new Set();
  for (const entry of Array.isArray(otherProjects) ? otherProjects : []) {
    const project = typeof entry === 'string' ? entry : entry?.project;
    const slug = projectSlug(project);
    if (!slug) continue;
    const key = slug.toLowerCase();
    if (seenProjects.has(key)) continue;          // the same project twice is once
    seenProjects.add(key);
    if (home.has(key)) continue;                  // its own project cannot corroborate itself
    corroborators.push({ project: slug, statement: typeof entry === 'string' ? null : entry?.statement ?? null });
  }

  const independent = 1 + corroborators.length;
  if (independent < bar) {
    return refuse(
      `learned in ${independent} project${independent === 1 ? '' : 's'}; the bar is ${bar} independent ones `
      + '(ruflo ADR-G008 "win twice"). One project finding a rule useful means that project is hard, not that the rule is universal.',
      { independent, bar },
    );
  }

  // 2. TEMPLATE CONTAMINATION. Two people who independently arrive at the same rule do not phrase it
  //    identically. Byte-identical wording across projects is the signature of one file copied twice
  //    — which is precisely the forged-rediscovery path the adversarial review found, and it would
  //    otherwise read as the STRONGEST possible evidence.
  const mine = normalizeText(lesson.statement);
  const twin = corroborators.find((c) => c.statement && normalizeText(c.statement) === mine);
  if (twin) {
    return refuse(
      `wording in "${twin.project}" is identical to this one — that is a copied template, not independent rediscovery. `
      + 'Forged breadth is the one thing that must never clear this bar.',
      { contaminatedBy: twin.project },
    );
  }

  // 3. PROJECT NOUNS. The single outcome promotion must never produce.
  const known = [...(lesson.projects || []), ...corroborators.map((c) => c.project)];
  const nouns = projectNouns(lesson.statement, { knownProjects: known });
  if (nouns.length) {
    const n = nouns[0];
    return refuse(
      `the statement names ${n.why} ("${n.token}") — a rule carrying a project-specific noun is not universal, `
      + 'and this does not rewrite statements (a regex that deletes the noun produces a sentence that means nothing).',
      { nouns },
    );
  }

  // 4. The proposal. Verbatim statement, quarantined provenance, its own namespaced id.
  const projects = [...new Set([...(lesson.projects || []).map(projectSlug).filter(Boolean), ...corroborators.map((c) => c.project)])].sort();
  const digest = crypto.createHash('sha256').update(mine).digest('hex').slice(0, 8);

  const proposal = {
    // A DISTINCT id, namespaced. Ratification maps over every row matching an id, so a generalization
    // sharing its parent's id would be silently ratified by one click meant for the parent — one
    // human decision, two rules in force, one of them never read.
    id: `G-${digest}-${lesson.id}`,
    statement: lesson.statement,
    trigger: lesson.trigger,
    // CONSTRAINT: anything this function produces is the MODEL's inference that a rule is universal.
    // The user stated the rule; nobody stated its scope. These three fields are last in any spread of
    // `{...lesson, ...proposal}`, so the result cannot block even if the source lesson was ratified
    // and blocking — the trust boundary is enforced by the data, not by the caller remembering.
    origin: ORIGIN.MODEL_INFERRED,
    sourceClass: SOURCE_CLASS.MODEL_INFERRED,
    status: STATUS.CANDIDATE,
    enforcement: ENFORCEMENT.CHECKLIST,
    intendedEnforcement: null,
    ratifiedBy: null,
    severity: lesson.severity === 'high' ? 'high' : 'normal',
    projects,
    repeatCount: lesson.repeatCount || 0,
    evidence: [
      { observed: `independently learned in ${independent} projects that cannot see each other: ${projects.join(', ')}` },
      // Only claimable when wording was actually supplied to compare. Asserting "phrased differently"
      // without having seen the other phrasings would be a fabricated piece of evidence in the
      // audit trail of a rule that governs every project — the exact class of claim L04 forbids.
      ...(corroborators.some((c) => c.statement)
        ? [{ observed: 'each project phrased it differently, so this is rediscovery rather than one template copied twice' }]
        : []),
      { observed: `statement checked for project-specific nouns (paths, filenames, repos, hosts, env vars, ports, product and project names) — none found` },
      { observed: `promotion bar: ruflo ADR-G008 "win twice" — ${independent} independent projects, bar ${bar}` },
    ],
  };
  return { ok: true, why: `universal on ${independent} independent projects, and free of project-specific nouns`, proposal, independent, bar };
}

/**
 * Propose promoting a project lesson to a universal one — or `null` if it has not earned it.
 * See `explainGeneralization` for the reason behind a `null`.
 */
export function proposeGeneralization(lesson, otherProjects = [], opts = {}) {
  return explainGeneralization(lesson, otherProjects, opts).proposal;
}

// ── CLI — read-only, by construction: this file contains no write of any kind ─────────────────────
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('lesson-lifecycle.mjs');
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  let signalsById = {};
  const sigFile = arg('--signals');
  if (sigFile) { try { signalsById = JSON.parse(fs.readFileSync(sigFile, 'utf8')); } catch { signalsById = {}; } }

  const lessons = loadLessons();
  const report = retirementReport(lessons, signalsById);

  if (argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  console.log(`\n  ${report.scanned} lessons examined. ${report.headline}.\n`);
  if (!Object.keys(signalsById).length) {
    console.log('  No outcome signal is recorded yet, so nothing can be proposed — that is the honest');
    console.log('  answer, not a bug. ADR-029 refused to implement demotion without one, and until a');
    console.log('  fire/override counter exists, "it never fired" and "we never looked" are the same');
    console.log('  observation. Pass --signals <file> once that counter is real.\n');
  }
  for (const p of report.proposals) {
    console.log(`  ○ ${p.id}  [${p.rule}]`);
    console.log(`      ${p.statement.slice(0, 110)}${p.statement.length > 110 ? '…' : ''}`);
    console.log(`      ${p.why}`);
  }
  if (report.shielded) {
    console.log(`\n  ${report.shielded} ratified critical rule(s) were not even considered — those are yours to remove, not mine.`);
  }
  console.log('\n  This was a PROPOSAL. Nothing was changed; this file cannot change anything.');
  console.log('  To act on one:  node scripts/lesson-ratify.mjs --demote <id>\n');
}
