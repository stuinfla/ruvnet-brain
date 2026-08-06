#!/usr/bin/env node
/**
 * lesson-promote.mjs — mine project-scoped lessons, find the UNIVERSAL ones, promote them.
 *
 * THE PROBLEM, MEASURED (2026-07-22, on the owner's own machine — this is not hypothetical):
 *
 *     736 lessons across 48 project memory stores.
 *     284 of them are `type: feedback` — "how I want you to WORK", which is almost never
 *     project-specific — and they are scattered across 33 separate stores.
 *
 *     "Test before claiming done"      taught 87 times across 19 projects
 *     "Versioning / release discipline" taught 52 times across 14 projects
 *     "Never fabricate / be honest"     taught 37 times across 14 projects
 *
 * The owner did not repeat himself because he forgot. He repeated himself because a lesson learned
 * in project A physically cannot reach project B: Claude Code scopes memory to
 * ~/.claude/projects/<project>/memory/, and nothing promotes upward. His words: "I shouldn't ever
 * have to tell you twice." He has had to tell us 87 times.
 *
 * THE PROMOTION RULE IS NOT OURS. It is rUv's, from ruflo ADR-G008 ("Win Twice to Promote",
 * Accepted/implemented): a rule may not enter the constitution on one good result, because one
 * result is noise. We apply the same test with the strongest evidence available here — INDEPENDENT
 * REDISCOVERY. A lesson the user taught in two or more separate projects has already won twice, in
 * the only arena that matters: he needed it more than once, in places that could not see each other.
 *
 * That is deliberately NOT a similarity score or an LLM judgment call. It is a count of how many
 * times a human independently arrived at the same instruction. Cheap, explainable, and impossible
 * to fudge — which matters, because a promotion engine that guesses will pollute the global rules
 * that govern every project, and a bad global rule is far more expensive than a missing one.
 *
 * READ-ONLY BY DEFAULT. Promotion writes to the user's global instructions, which is the highest
 * blast-radius write this project performs. It requires --apply, backs up first, and is reversible.
 *
 * Usage:
 *   node scripts/lesson-promote.mjs                 # report only — what WOULD be promoted, and why
 *   node scripts/lesson-promote.mjs --json          # machine-readable, for the console
 *   node scripts/lesson-promote.mjs --apply         # write the promotion block (backs up first)
 *   node scripts/lesson-promote.mjs --min-projects 3
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// A lesson must have been independently learned in at least this many DISTINCT projects to be
// considered universal. 2 is ADR-G008's "win twice"; the flag exists so a cautious user can demand
// more evidence, never less — the floor is enforced below.
const MIN_PROJECTS = Math.max(2, parseInt(arg('--min-projects', '2'), 10) || 2);

/**
 * Themes are the unit of promotion, not individual files.
 *
 * Promoting 87 near-identical "test first" lessons verbatim would be worse than promoting none —
 * it would bury the global instructions under duplicates and make them unreadable, which is how a
 * constitution stops being read. We cluster to the PROCESS, then promote one canonical statement of
 * it, citing the projects that independently discovered it as the evidence.
 *
 * Deliberately keyword-based rather than embedding-based. An embedding cluster is a black box the
 * user cannot audit, and this writes to the file that governs every project he owns. He must be able
 * to read the rule that decided, disagree with it, and edit it. Legibility beats cleverness here.
 */
const THEMES = [
  { key: 'release-discipline', label: 'Versioning and release discipline',
    match: /version|semver|bump|release|ship|deploy|publish|rollback/i },
  { key: 'proof-before-done', label: 'Prove it works before calling it done',
    match: /test|verify|prove|validat|\bqa\b|gate|green|passes/i },
  { key: 'honesty', label: 'Never fabricate, never assume, never inflate',
    match: /honest|lie|fabricat|assum|guess|placeholder|inflat|real data|made up/i },
  { key: 'docs-upkeep', label: 'Keep docs and README current with the code',
    match: /readme|document|changelog|\bdocs?\b|narrative/i },
  { key: 'people', label: 'How to communicate with people',
    match: /thank|contributor|personal|tone|nudge|deferential|communicat/i },
  { key: 'tooling-discipline', label: 'Use the real tool; never hand-roll a substitute',
    match: /hand-roll|impersonat|substitut|reinvent|use the tool|existing tool|ruvnet wins/i },
  { key: 'cost-routing', label: 'Route work to the cheapest capable model',
    match: /cheap|cost|route|routing|model selection|budget|spend/i },
];

/** Every lesson file on this machine, with its project, type, and text. */
export function collectLessons(root = PROJECTS) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const p of dirs) {
    const md = path.join(root, p, 'memory');
    if (!fs.existsSync(md)) continue;
    let files = [];
    try { files = fs.readdirSync(md); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      let s = '';
      try { s = fs.readFileSync(path.join(md, f), 'utf8'); } catch { continue; }
      const type = (s.match(/^\s*type:\s*(\w+)/m) || [])[1] || 'unknown';
      const desc = (s.match(/^description:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
      out.push({
        project: p.replace(/^-Users-[^-]+-/, ''),
        file: f.replace(/\.md$/, ''),
        type, desc,
        // name + description only — never the body. The body can hold project specifics (paths,
        // client names, URLs); the identity of a PROCESS lives in its title. Classifying on the body
        // would drag project facts into a global rule, which is the one thing promotion must not do.
        text: `${f} ${desc}`,
      });
    }
  }
  return out;
}

/**
 * Cluster lessons into themes and decide which have won often enough to be universal.
 *
 * Only `feedback` lessons are eligible. `project` lessons are, by their own declared type, about one
 * codebase; promoting them would be a category error and would leak one client's details into every
 * other project's context.
 */
/**
 * Themes the user has explicitly rejected. Read from the lesson store's demoted rows.
 *
 * WITHOUT THIS, DEMOTION WAS THEATRE. `lesson-ratify.mjs --demote` set a flag the miner never
 * looked at, so the next mining run would re-propose the exact rule the user had just deleted.
 * ADR-030 §5 states the requirement plainly — "a one-click demote that the next nightly silently
 * undoes is worse than no demote at all, because the user stops trusting the control and, correctly,
 * stops using it" — and the code did not implement it. Verified 2026-07-22: zero references to
 * `demoted` in this file.
 *
 * Read defensively: the store may be absent, locked, or from a newer schema. A miner that throws
 * because it could not read an optional file is worse than one that proposes a rejected theme.
 */
function demotedThemeKeys() {
  try {
    const file = process.env.RUVNET_LESSON_STORE
      || path.join(os.homedir(), '.config', 'ruvnet-brain', 'lessons.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(
      (raw.lessons || [])
        .filter((l) => l && l.demoted === true && typeof l.themeKey === 'string')
        .map((l) => l.themeKey),
    );
  } catch { return new Set(); }
}

export function analyze(lessons, { minProjects = MIN_PROJECTS, rejected = null } = {}) {
  // Injectable for tests; defaults to the real store so the CLI honours real demotions.
  const demoted = rejected instanceof Set ? rejected : demotedThemeKeys();
  const eligible = lessons.filter((l) => l.type === 'feedback');
  const themes = [];
  for (const t of THEMES) {
    const hits = eligible.filter((l) => t.match.test(l.text));
    if (!hits.length) continue;
    const projects = [...new Set(hits.map((h) => h.project))].sort();
    // A theme the user has demoted is NEVER re-proposed. Sticky across every future run.
    if (demoted.has(t.key)) continue;
    themes.push({
      key: t.key,
      label: t.label,
      lessons: hits.length,
      projects,
      projectCount: projects.length,
      // The whole verdict, in one line anyone can check by hand.
      universal: projects.length >= minProjects,
      evidence: `taught ${hits.length} time${hits.length === 1 ? '' : 's'} across ${projects.length} independent project${projects.length === 1 ? '' : 's'}`,
      examples: hits.slice(0, 4).map((h) => `${h.project}: ${h.file}`),
    });
  }
  themes.sort((a, b) => b.projectCount - a.projectCount || b.lessons - a.lessons);

  const promotable = themes.filter((t) => t.universal);
  return {
    scanned: { projects: new Set(lessons.map((l) => l.project)).size, lessons: lessons.length, feedback: eligible.length },
    minProjects,
    themes,
    promotable,
    // The headline the console should say out loud, computed rather than written.
    headline: promotable.length
      ? `${promotable.length} process${promotable.length === 1 ? '' : 'es'} you have taught in ${minProjects}+ separate projects are still trapped at project level`
      : 'no cross-project process has met the promotion bar yet',
  };
}

/** Render the promotion block. Idempotent, fenced, and safe to regenerate. */
export function renderBlock(result, now) {
  const lines = [];
  lines.push(BEGIN);
  lines.push('<!-- Generated by scripts/lesson-promote.mjs. Regeneration REPLACES this fenced block');
  lines.push('     wholesale on the next --apply — do NOT hand-edit between the markers, those changes');
  lines.push('     are overwritten. Everything OUTSIDE the markers is left untouched. -->');
  lines.push('');
  lines.push(`## Cross-project lessons (promoted ${now})`);
  lines.push('');
  lines.push('These processes were learned independently in multiple projects. Per ruflo ADR-G008');
  lines.push('("win twice to promote"), independent rediscovery IS the evidence — each one below was');
  lines.push('needed more than once, in places that could not see each other.');
  lines.push('');
  for (const t of result.promotable) {
    lines.push(`- **${t.label}** — ${t.evidence}.`);
    lines.push(`  <sub>projects: ${t.projects.slice(0, 6).join(', ')}${t.projects.length > 6 ? `, +${t.projects.length - 6} more` : ''}</sub>`);
  }
  lines.push('');
  lines.push(END);
  return lines.join('\n');
}

const BEGIN = '<!-- BEGIN ruvnet-brain: promoted-lessons -->';
const END = '<!-- END ruvnet-brain: promoted-lessons -->';

/** Write the block into the user's global CLAUDE.md, backing up first. Reversible by design. */
export function applyPromotion(result, { file, now }) {
  if (!result.promotable.length) return { ok: true, noop: true, log: 'nothing met the promotion bar — nothing written' };
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, log: `cannot read ${file}` }; }

  const backup = `${file}.bak-promote-${now.replace(/[:.]/g, '-')}`;
  try { fs.copyFileSync(file, backup); } catch (e) { return { ok: false, log: `refusing to write — backup failed: ${e.message}` }; }

  const block = renderBlock(result, now);
  const next = existing.includes(BEGIN)
    ? existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block)   // replace ONLY our fence
    : `${existing.trimEnd()}\n\n${block}\n`;                            // first run: append

  try { fs.writeFileSync(file, next); } catch (e) { return { ok: false, log: `write failed: ${e.message}; backup at ${backup}` }; }
  return { ok: true, backup, promoted: result.promotable.length, log: `promoted ${result.promotable.length} process(es) into ${file.replace(HOME, '~')}` };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('lesson-promote.mjs');
if (invokedDirectly) {
  const result = analyze(collectLessons());
  if (has('--json')) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

  console.log(`\n  Scanned ${result.scanned.lessons} lessons across ${result.scanned.projects} projects `
    + `(${result.scanned.feedback} are about how you want work done).\n`);
  console.log(`  ${result.headline}.\n`);
  const w = 42;
  for (const t of result.themes) {
    const mark = t.universal ? '  ⬆ PROMOTE ' : '  · project ';
    console.log(`${mark}${t.label.padEnd(w)} ${String(t.lessons).padStart(3)} lessons · ${t.projectCount} projects`);
  }
  if (result.promotable.length) {
    console.log(`\n  Evidence for each (independent rediscovery — ADR-G008 "win twice"):`);
    for (const t of result.promotable) {
      console.log(`\n    ${t.label}`);
      console.log(`      ${t.evidence}`);
      for (const ex of t.examples) console.log(`        · ${ex}`);
    }
  }

  if (has('--apply')) {
    const file = arg('--file', path.join(HOME, '.claude', 'CLAUDE.md'));
    const res = applyPromotion(result, { file, now: new Date().toISOString().slice(0, 10) });
    console.log(`\n  ${res.ok ? '✓' : '✗'} ${res.log}`);
    if (res.backup) console.log(`     backup: ${res.backup.replace(HOME, '~')}`);
    process.exit(res.ok ? 0 : 1);
  } else {
    console.log(`\n  This was a REPORT — nothing was written.`);
    console.log(`  To promote these into your global instructions:  node scripts/lesson-promote.mjs --apply\n`);
  }
}
