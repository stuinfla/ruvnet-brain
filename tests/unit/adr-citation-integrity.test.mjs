// adr-citation-integrity.test.mjs — B3 (2026-07-18): console/tips.html grounded the marketing
// figure "28.5% cheaper at 98.1% bar-compliance" in `<code>ADR-073</code>` and called it "rUv's own
// ACCEPTED ADR" — but agentic-flow's ADR-073 is Status **Proposed** and the string "28.5%" appears
// NOWHERE in its body; the figure lives only in ADR-076 (Accepted), which merely *references* 073.
// That is false attribution: citing a decision that neither states the number nor is accepted, to
// make an inference look grounded. This gate makes that class un-shippable.
//
// THE RULE: when a user-facing surface puts a precise decimal figure (28.5%, 98.1%, $0.267) next to
// an `ADR-NNN` citation, that ADR must (a) actually contain the figure verbatim in its own body, and
// (b) be Accepted/Implemented — you cannot ground a live claim in a Proposed decision. Resolves ADR
// numbers against BOTH ruvnet-brain's own docs/adr and the cloned upstream repos' docs/adr(s).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// ── resolve every ADR the repo can see, keyed by its numeric id ──────────────────────────────────
function readStatus(text) {
  // rUv's shape: a line like "**Status**: Accepted" (sometimes "Accepted — implemented in 2.1.0").
  const m = text.match(/\*\*Status\*\*:\s*([^\n]+)/i);
  return m ? m[1].trim() : '';
}
function walkAdrDirs(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Only descend into plausible ADR homes to keep this cheap; clones/*/docs/adr(s) + our own.
      if (/(^|\/)(docs|adr|adrs|clones)$/.test(p) || /clones\//.test(p)) walkAdrDirs(p, out);
      else if (e.name === 'docs' || e.name === 'clones' || e.name === 'adr' || e.name === 'adrs') walkAdrDirs(p, out);
      continue;
    }
    const m = e.name.match(/^ADR-0*(\d+)/i);
    if (!m || !e.name.endsWith('.md')) continue;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const num = Number(m[1]);
    (out[num] ||= []).push({ path: p, status: readStatus(text), text });
  }
}
export function collectAdrs(root = ROOT) {
  const out = {};
  walkAdrDirs(path.join(root, 'docs', 'adr'), out);
  walkAdrDirs(path.join(root, 'docs', 'adrs'), out);
  // upstream clones (agentic-flow etc.) — ADR-073/075/076 live here
  const clones = path.join(root, 'clones');
  try {
    for (const repo of fs.readdirSync(clones)) {
      walkAdrDirs(path.join(clones, repo, 'docs', 'adr'), out);
      walkAdrDirs(path.join(clones, repo, 'docs', 'adrs'), out);
    }
  } catch { /* no clones on a bare CI runner — see SKIP logic in the describe block */ }
  return out;
}

const ACCEPTED = /\b(Accepted|Implemented)\b/i;
const FIGURE_RE = /(\d{1,3}\.\d+)%|\$(\d+\.\d+)/g; // precise decimal claims: 28.5%, 98.1%, $0.267
const ADR_RE = /ADR-0*(\d+)/gi;
const WINDOW = 60; // an ADR token this close to a figure is asserted to be that figure's source

/**
 * Every precise figure that sits within WINDOW chars of an ADR citation must be backed by that ADR:
 * the figure string appears in the ADR's own body AND the ADR is Accepted/Implemented.
 * @returns {{figure:string, adr:number, reason:string}[]}
 */
export function adrCitationViolations(surface, adrMap) {
  const adrs = [...surface.matchAll(ADR_RE)].map((m) => ({ num: Number(m[1]), at: m.index }));
  if (!adrs.length) return [];
  const violations = [];
  for (const fm of surface.matchAll(FIGURE_RE)) {
    const figure = fm[0]; // e.g. "28.5%" or "$0.267"
    const at = fm.index;
    // nearest ADR whose token is within WINDOW of the figure
    let best = null;
    for (const a of adrs) {
      const dist = a.at >= at ? a.at - (at + figure.length) : at - (a.at + `ADR-${a.num}`.length);
      if (dist <= WINDOW && (best === null || dist < best.dist)) best = { ...a, dist };
    }
    if (!best) continue; // figure not attributed to any ADR — not this gate's concern
    const resolved = adrMap[best.num];
    if (!resolved || !resolved.length) {
      violations.push({ figure, adr: best.num, reason: `cites ADR-${best.num} for "${figure}" but no such ADR resolves in docs/adr or clones/*/docs/adr` });
      continue;
    }
    const inBody = resolved.some((r) => r.text.includes(figure));
    const isAccepted = resolved.some((r) => ACCEPTED.test(r.status));
    if (!inBody) violations.push({ figure, adr: best.num, reason: `"${figure}" attributed to ADR-${best.num}, but that string appears nowhere in ADR-${best.num}'s own body (statuses: ${resolved.map((r) => r.status).join(' | ')})` });
    else if (!isAccepted) violations.push({ figure, adr: best.num, reason: `"${figure}" grounded in ADR-${best.num}, whose status is "${resolved.map((r) => r.status).join(' | ')}" — a live figure may not be grounded in a non-Accepted decision` });
  }
  return violations;
}

// Live public surfaces that attribute figures to ADRs.
const SURFACES = ['console/tips.html', 'console/app.js', 'explainer/index.html'];
const ASSET_DIRS = ['console/assets', 'explainer/assets'];
for (const d of ASSET_DIRS) {
  try {
    for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.svg')) SURFACES.push(path.join(d, f));
  } catch { /* dir absent */ }
}

describe('ADR-citation integrity — a figure cited to an ADR must live in that ADR, and it must be Accepted', () => {
  const adrMap = collectAdrs();
  // The upstream ADRs this gate trusts must actually RESOLVE, not merely a clones/ folder exist: an
  // empty clones/ used to make every case "run" and fail with "no such ADR resolves", and no clones/
  // at all made every case return early and pass with no assertion. Both now skip visibly instead.
  const haveUpstream = Boolean(adrMap[73]?.length && adrMap[76]?.length);
  const NO_UPSTREAM = 'skipped: agentic-flow ADR-073/076 do not resolve under clones/*/docs/adr here';

  for (const rel of SURFACES) {
    const p = path.join(ROOT, rel);
    const present = fs.existsSync(p);
    const src = present ? fs.readFileSync(p, 'utf8') : '';
    // A surface that cites an upstream (3-digit-numbered) ADR cannot be judged without the clones.
    const needsUpstream = /ADR-0*(\d{3})\b/.test(src);
    const skip = !present || (needsUpstream && !haveUpstream);
    const why = !present ? ' (skipped: surface not in this checkout)' : skip ? ` (${NO_UPSTREAM})` : '';
    it.skipIf(skip)(`${rel} — no figure is falsely attributed to an ADR${why}`, () => {
      const v = adrCitationViolations(src, adrMap);
      expect(v.map((x) => x.reason), `${rel}: ${v.map((x) => x.reason).join(' ; ')}`).toEqual([]);
    });
  }

  // Runs everywhere, upstream or not: the detector itself against a synthetic map with the exact B3
  // ground truth (073 Proposed without the figure, 076 Accepted with it). This is the part that keeps
  // the gate from being vacuous on a runner with no clones.
  const SYNTHETIC = {
    73: [{ path: 'ADR-073.md', status: 'Proposed', text: '**Status**: Proposed\nSee ADR-076 for measurements.' }],
    76: [{ path: 'ADR-076.md', status: 'Accepted', text: '**Status**: Accepted\n28.5% cheaper at 98.1% bar-compliance.' }],
  };
  const KNOWN_BAD = 'Grounded in rUv&rsquo;s own accepted ADRs — four pillars <code>ADR-076</code> · the measured 28.5% <code>ADR-073</code>. Nothing here is inferred.';
  const KNOWN_GOOD = 'Per agentic-flow ADR-076: 28.5% cheaper at 98.1% bar-compliance.';

  it('detector (synthetic ground truth): catches a figure cited to a Proposed ADR that lacks it, clears the fix', () => {
    const v = adrCitationViolations(KNOWN_BAD, SYNTHETIC);
    expect(v.filter((x) => x.adr === 73)).toHaveLength(1);
    expect(v[0].reason).toMatch(/appears nowhere in ADR-73/);
    expect(adrCitationViolations(KNOWN_GOOD, SYNTHETIC)).toEqual([]);
    // Each half of the rule bites on its own: figure present but not Accepted; ADR that does not resolve.
    const proposedWithFigure = { 76: [{ ...SYNTHETIC[76][0], status: 'Proposed' }] };
    expect(adrCitationViolations(KNOWN_GOOD, proposedWithFigure).map((x) => x.reason).join()).toMatch(/non-Accepted/);
    expect(adrCitationViolations(KNOWN_GOOD, {}).map((x) => x.reason).join()).toMatch(/no such ADR resolves/);
  });

  // Self-proving on the EXACT B3 lie (verbatim pre-fix tips.html wording) and the fix, on the real ADRs.
  it.skipIf(!haveUpstream)(`detector: FAILS on the pre-fix wording — "measured 28.5% ADR-073" (Proposed, figure not in its body)${haveUpstream ? '' : ` (${NO_UPSTREAM})`}`, () => {
    const v = adrCitationViolations(KNOWN_BAD, adrMap);
    expect(v.length, 'expected the 28.5%→ADR-073 false attribution to be caught').toBeGreaterThan(0);
    expect(v.some((x) => x.adr === 73)).toBe(true);
  });

  it.skipIf(!haveUpstream)(`detector: PASSES on the fix — "per agentic-flow ADR-076: 28.5% cheaper at 98.1% bar-compliance"${haveUpstream ? '' : ` (${NO_UPSTREAM})`}`, () => {
    expect(adrCitationViolations(KNOWN_GOOD, adrMap)).toEqual([]);
  });

  it.skipIf(!haveUpstream)(`sanity: ADR-076 resolves and is Accepted, ADR-073 resolves and is Proposed (the ground truth this gate trusts)${haveUpstream ? '' : ` (${NO_UPSTREAM})`}`, () => {
    expect(adrMap[76]?.some((r) => ACCEPTED.test(r.status))).toBe(true);
    expect(adrMap[73]?.some((r) => /Proposed/i.test(r.status))).toBe(true);
    expect(adrMap[76]?.some((r) => r.text.includes('28.5%'))).toBe(true);
    expect(adrMap[73]?.some((r) => r.text.includes('28.5%'))).toBe(false);
  });
});
