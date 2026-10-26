#!/usr/bin/env node
// scripts/ascii-drift.mjs — ADR-055 §8. The DETERMINISTIC half of the owner's second rule.
//
//   node scripts/ascii-drift.mjs            report: stale tracked diagrams + untracked candidates
//   node scripts/ascii-drift.mjs --json     machine-readable, same evaluation
//   node scripts/ascii-drift.mjs --quiet    one line, or nothing at all — for the session-start hook
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT A CONVERTER, AND WHY IT IS NOT A HOOK THAT CONVERTS.
//
// The `ascii-to-svg` skill has advertised, since 2026-01-08, that it is "Fully automatic via global
// PostToolUse hook ~/.claude/hooks/ascii-svg-auto-sync.sh … set-and-forget." Measured 2026-07-27:
// THAT FILE DOES NOT EXIST and never did; the manifest was last written 2026-06-29. It could not
// have existed — converting a diagram needs a model, and a PostToolUse hook has a ~5s budget, no
// session and no tokens.
//
// The first draft of ADR-055 then proposed conversion "at pre-push" and reproduced the identical
// impossibility one chokepoint over: a pre-push git hook is also a shell process with no model. Both
// duel reviewers caught it. So the work is SPLIT along the line that actually exists:
//
//   DETERMINISTIC (this file)  hashing, scoring, comparing. No model, no network, no writes.
//   GENERATIVE  (the skill)    the conversion itself, invoked by a model that is actually present.
//
// and the deterministic half reports AT SESSION START — the one chokepoint where a model is in the
// room and can act on what it is told.
//
// THIS FILE OWNS NO FORMAT. Every rule below is the SKILL's, read from its own files, because
// naming our own would be the silent substitution `substitution:check` exists to prevent:
//   · confidence scoring + negative signals + thresholds  -> the skill's detection.md
//   · override markers                                    -> the skill's SKILL.md ("Override Markers")
//   · manifest schema + ASCII normalization               -> the skill's change-tracking.md
// If the skill changes its spec, this file is wrong and must follow it, not the other way round.
//
// IT NEVER BLOCKS AND NEVER WRITES. A stale picture is not a correctness defect, and a gate that
// refuses a push over a diagram is a gate removed within the week (DDD-0008, the cut Diagram
// aggregate). Worst case here is a line of text nobody acts on.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const MANIFEST = '.ascii-to-svg-manifest.json';

// Generated / vendored markdown is not authored — same exclusion list as the stamp sweep.
const EXCLUDED = ['node_modules', '.git', 'kb', 'dist', 'clones', 'archive', '.agentic-qe', 'coverage', 'build', 'tmp', '.swarm'];

// ── the skill's normalization (change-tracking.md, "Hash Calculation") ────────────────────────────
// 1. trim leading/trailing whitespace from each line · 2. drop empty lines at start/end
// 3. normalize line endings to \n · 4. remove the fence markers themselves
export function normalizeAscii(block) {
  const lines = String(block).replace(/\r\n?/g, '\n').split('\n')
    .filter((l) => !/^\s*(```|~~~)/.test(l))
    .map((l) => l.trim());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

export function hashAscii(block) {
  return 'sha256:' + crypto.createHash('sha256').update(normalizeAscii(block), 'utf8').digest('hex');
}

// ── the skill's confidence scoring (detection.md, "Detection Signals") ────────────────────────────
const STRONG = [/[─│┌┐└┘├┤┬┴┼╔╗╚╝║═]/, /[→←↑↓↔↕▶◀▲▼►◄]/];
const MEDIUM = [/\+-{1,}\+/, /(-->|<--|->|<-|=>|<=|~>)/, /^\s*([-=_]{3,})\s*$/m];
const WEAK = [/[│┌└├].*[A-Za-z0-9]/, /^\s*[\^v]\s*$/m];
// Negative signals — the half a naive "has box characters" test throws away, and the reason
// terminal transcripts, tables and `tree` output do not become permanent false candidates.
const NEGATIVE = [
  { re: /^\s*\|.*\|\s*$[\s\S]*?^\s*\|[\s:-]+\|\s*$/m, why: 'markdown table' },
  { re: /\b(function|const|let|var|def|class|import|return|if|for|while)\b/, why: 'source code' },
  { re: /^\s*[$#>%]\s+\S/m, why: 'shell transcript' },
  { re: /\b\d{4}-\d{2}-\d{2}\b|\[(INFO|WARN|ERROR|DEBUG)\]/, why: 'log output' },
  { re: /^\s*[\w.-]+\s*[=:]\s*\S+\s*$/m, why: 'config key/value' },
];
const CONTEXT_WORDS = /(diagram|architecture|flow|structure|overview|schema|layout|design)/i;

export function scoreBlock(body, { lang = '', preceding = '' } = {}) {
  const reasons = [];
  let score = 0;
  for (const re of STRONG) if (re.test(body)) { score += 25; reasons.push('+25 box/arrow glyphs'); }
  for (const re of MEDIUM) if (re.test(body)) { score += 15; reasons.push('+15 ascii box/arrow pattern'); }
  for (const re of WEAK) if (re.test(body)) { score += 10; reasons.push('+10 weak layout signal'); }
  for (const n of NEGATIVE) if (n.re.test(body)) { score -= 20; reasons.push(`-20 ${n.why}`); }
  if (CONTEXT_WORDS.test(preceding)) { score += 15; reasons.push('+15 diagram-ish context'); }
  if (/^(diagram|ascii|art|chart|graph)$/i.test(lang)) { score += 15; reasons.push('+15 fence language hint'); }
  if (normalizeAscii(body).split('\n').length < 3) { score -= 20; reasons.push('-20 fewer than 3 lines'); }
  return { confidence: Math.max(0, Math.min(100, score)), reasons };
}

// ── the skill's override markers (SKILL.md, "Override Markers") ───────────────────────────────────
const SKIP_MARKER = /<!--\s*skip-ascii-to-svg\s*-->/;
const FORCE_MARKER = /<!--\s*convert-to-svg(?::\s*[\w-]+)?\s*-->/;

/** Every fenced block in a document, with the two lines of context that precede it. */
export function fencedBlocks(text) {
  const out = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(```|~~~)(\w*)/);
    if (!open && m) { open = { fence: m[1], lang: m[2] || '', start: i, body: [] }; continue; }
    if (open && m && m[1] === open.fence) {
      const preceding = lines.slice(Math.max(0, open.start - 3), open.start).join('\n');
      out.push({ line: open.start + 1, lang: open.lang, body: open.body.join('\n'), preceding });
      open = null; continue;
    }
    if (open) open.body.push(lines[i]);
  }
  return out;
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

export function authoredDocs(root = REPO_ROOT) {
  const ls = git(root, ['ls-files', '--', '*.md']);
  if (!ls.ok) return [];
  return ls.out.split('\n').filter(Boolean)
    .filter((rel) => !rel.split('/').some((s) => EXCLUDED.includes(s)));
}

export function readManifest(root = REPO_ROOT) {
  try { return JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')); }
  catch { return { version: '1.0.0', diagrams: [] }; }
}

/**
 * STALE = a tracked diagram whose stored asciiHash matches NO block in its source file any more.
 * Matched by hash across the whole file rather than by `sourceLine`, deliberately: line numbers
 * drift on every edit above the block, and a line-anchored check would report drift for edits that
 * never touched the diagram — the false-positive shape that gets a channel ignored.
 */
export function evaluate(root = REPO_ROOT, { threshold = 40 } = {}) {
  const manifest = readManifest(root);
  const tracked = Array.isArray(manifest.diagrams) ? manifest.diagrams : [];
  const stale = [];
  const candidates = [];
  const byFile = new Map();

  for (const rel of authoredDocs(root)) {
    let text; try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    byFile.set(rel, fencedBlocks(text).map((b) => ({ ...b, hash: hashAscii(b.body) })));
  }

  // THREE OUTCOMES, NOT TWO — and getting this wrong is how the channel dies on day one.
  // First run of this detector reported all 5 tracked README diagrams as STALE. They are not:
  // README carries NO box-drawing characters at all, the ASCII fallbacks were removed when the
  // diagrams were converted, and all 5 SVGs exist (2.5-4KB) and are referenced 7 times from the
  // page. That is the HEALTHY END STATE of a conversion, reported as a defect. Five false alarms
  // out of five tracked items, on the very first run, in a channel whose only job is to be believed.
  //   · SVG missing                      -> BROKEN, always worth saying
  //   · hash gone + no ASCII left in file -> CONVERTED, the fallback was removed. Silent.
  //   · hash gone + ASCII still in file   -> genuinely STALE: the source is there and it differs.
  for (const d of tracked) {
    const blocks = byFile.get(d.sourceFile);
    if (!blocks) { stale.push({ ...d, why: 'source file is gone or no longer scanned' }); continue; }
    if (blocks.some((b) => b.hash === d.asciiHash)) continue;             // exact match: current
    if (!fs.existsSync(path.join(root, d.svgFile || ''))) {
      stale.push({ ...d, why: 'the SVG file is MISSING — the page renders a broken image' });
      continue;
    }
    // The SVG is present. Is any ASCII still sitting in the source that could have drifted from it?
    const leftover = blocks.some((b) => scoreBlock(b.body, { lang: b.lang, preceding: b.preceding }).confidence >= threshold);
    if (leftover) stale.push({ ...d, why: 'ASCII source is still present in the file and no longer matches the generated SVG' });
    // else: converted and the fallback was removed — the intended end state. Say nothing.
  }

  const trackedHashes = new Set(tracked.map((d) => d.asciiHash));
  for (const [rel, blocks] of byFile) {
    for (const b of blocks) {
      if (trackedHashes.has(b.hash)) continue;                 // already converted
      if (SKIP_MARKER.test(b.preceding)) continue;             // the skill's explicit opt-out
      const forced = FORCE_MARKER.test(b.preceding);
      const s = scoreBlock(b.body, { lang: b.lang, preceding: b.preceding });
      const confidence = forced ? 100 : s.confidence;
      if (confidence >= threshold) {
        candidates.push({ file: rel, line: b.line, confidence, forced, reasons: s.reasons, lines: normalizeAscii(b.body).split('\n').length });
      }
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  return { stale, candidates, trackedCount: tracked.length, scanned: byFile.size };
}

function main() {
  const argv = process.argv.slice(2);
  const r = evaluate();

  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }

  if (argv.includes('--quiet')) {
    // The session-start voice: say something ONLY when there is something to do, and say it in one
    // line. A channel that speaks every session about nothing is a channel that gets tuned out.
    const bits = [];
    if (r.stale.length) bits.push(`${r.stale.length} SVG diagram(s) out of date with their ASCII source`);
    if (r.candidates.length) bits.push(`${r.candidates.length} ASCII block(s) that look like diagrams and have no SVG`);
    if (bits.length) {
      console.log(`[ASCII→SVG] ${bits.join(' · ')}. Say "convert the ascii diagrams" and the `
        + `ascii-to-svg skill will render them (it owns the conversion; this check only measures).`);
    }
    return 0;
  }

  console.log(`\nascii→svg drift — ${r.scanned} authored document(s), ${r.trackedCount} tracked diagram(s)\n`);
  if (r.stale.length) {
    console.log(`  ${r.stale.length} STALE — the SVG no longer matches its ASCII source:\n`);
    for (const s of r.stale) console.log(`    ▲ ${s.id}  (${s.sourceFile} → ${s.svgFile})\n       ${s.why}`);
    console.log('');
  }
  if (r.candidates.length) {
    console.log(`  ${r.candidates.length} CANDIDATE(S) — scored by the skill's own heuristics, never auto-converted:\n`);
    for (const c of r.candidates) {
      console.log(`    ○ ${c.file}:${c.line}  confidence ${c.confidence}${c.forced ? ' (forced by marker)' : ''}, ${c.lines} lines`);
      console.log(`       ${c.reasons.join(' · ')}`);
    }
    console.log('\n  To decline one permanently, put the skill\'s own marker above the block:');
    console.log('      <!-- skip-ascii-to-svg -->');
    console.log('  That is the skill\'s convention, not ours — a candidate you have judged stays judged.');
  }
  if (!r.stale.length && !r.candidates.length) console.log('  nothing stale, nothing unconverted worth flagging.');
  console.log('\nThis check never converts and never blocks. Conversion belongs to the ascii-to-svg skill.\n');
  return 0;
}

function isMain() {
  try { return isDirectInvocation(import.meta.url); }
  catch { return false; }
}
if (isMain()) process.exit(main());
