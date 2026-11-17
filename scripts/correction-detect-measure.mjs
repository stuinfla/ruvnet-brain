#!/usr/bin/env node
/**
 * correction-detect-measure.mjs — the measurement harness ADR-033 §2 requires and correction-
 * detect.mjs's own header cites, but that never existed as a script: something that walks the REAL
 * transcript corpus, builds the (promptText, precedingAssistantAction) pairs detectCorrection()
 * actually consumes, runs the detector, and reports precision/recall on a held-out split — so the
 * numbers in correction-detect.mjs's header are reproducible, not asserted.
 *
 * WHY A FILE-LEVEL TUNE/HOLDOUT SPLIT, NOT A RANDOM ROW SPLIT. Two rows from the same transcript
 * session are not independent draws — they share the user's phrasing habits for that session, and
 * sometimes repeat the same correction verbatim minutes apart. Splitting by ROW would leak: a
 * heuristic tuned on one half of a duplicated correction would trivially "recall" the other half.
 * Splitting by FILE (a deterministic hash of the transcript filename, not a random seed, so re-runs
 * are reproducible) keeps every row from one session on one side of the line.
 *
 * WHAT THIS DOES NOT DO. It does not hand-label anything — that is a human's job, and doing it
 * mechanically here would be the exact "the fixture cannot falsify its own choice" trap this
 * measurement exists to avoid. `--dump-pool` writes a lexically-loose CANDIDATE POOL (a superset of
 * what the real detector would ever fire on) to a file OUTSIDE this repo by default, for a human to
 * read and label true/false. Real user transcripts can contain secrets, business content, or simply
 * more of a conversation than its owner intends to publish — this script never writes transcript
 * text into the repo, and the default output path is under the OS temp directory for exactly that
 * reason. Committing labelled examples back into tests/unit/correction-detect.test.mjs is a separate,
 * deliberate, human-reviewed step (see that file's "FROM THE REAL CORPUS" entries for the precedent).
 *
 * USAGE
 *   node scripts/correction-detect-measure.mjs
 *       Reports adjacency-candidate counts and detection counts/rates, split tune vs. holdout, for
 *       whichever corpus directory is being read (default: this project's own Claude Code transcript
 *       directory, i.e. `~/.claude/projects/<mangled-cwd>`).
 *
 *   node scripts/correction-detect-measure.mjs --corpus-dir <path>
 *       Point at a different transcript directory (e.g. to reproduce this measurement on someone
 *       else's machine, or a different project's history).
 *
 *   node scripts/correction-detect-measure.mjs --dump-pool <path> [--split tune|holdout|all]
 *       Additionally writes the loose-net candidate pool (JSONL: file, turnIndex, promptText,
 *       precedingAssistantAction, split, detectorResult) to <path> for hand-labelling. Defaults to
 *       tune+holdout combined; pass --split to isolate one side.
 *
 * BROADENING RESULT, 2026-07-24 (agent-directed-imperative signal, see correction-detect.mjs).
 *
 * Acting on the recall finding below: added one gated signal class — directives whose object is the
 * agent ("I want you to X", "you need to Y"), which the quantifier net structurally could not see —
 * requiring strong rejection valence so a first-time request stays silent. MEASURED effect on the
 * real corpus: holdout firings 3 -> 10 (total 7 -> 19). All 94 detector unit tests stay green, so no
 * blind-rater-certified case regressed.
 *
 * THE TRADE, stated honestly: single-rater inspection of the 10 holdout firings read ~7 genuine
 * corrections and ~3 borderline false positives (directives phrased as questions). That is a ~70%
 * point estimate — HIGHER RECALL, slightly LOWER precision point-estimate than the narrow net's
 * 77.8%. Neither is certifiable: 10 firings still cannot bound precision above 74.1% (needs n>=29),
 * and single-rater labels are direction-finding, not the blind 3-rater majority a floor claim needs.
 * The structural win is the VOLUME: 10 is most of the way to the n>=29 that any future >=90%
 * certification requires — you cannot certify a floor on n=3 at all. Deliberately NOT tuned further
 * against the holdout firings above: tuning on the set you measure with corrupts the only unbiased
 * measurement you have. Further tuning belongs on the tune split, with blind labelling.
 *
 * HAND-LABELLED FINDINGS, 2026-07-24 — N3 IS A RECALL PROBLEM, NOT A PRECISION PROBLEM.
 *
 * The open work item read "raise correction-detect precision 27% -> 90%". A hand-labelling pass over
 * this pool says that framing is wrong, and it is worth writing down before anyone tunes a regex again.
 *
 *   PRECISION, holdout firings: 2 of 3 correct. Also uncertifiable — see the certifiability block at
 *   the bottom of main(): three firings cannot bound precision above 36.8% no matter what, and >=90%
 *   needs n >= 29. No regex change moves that; only more firings do.
 *
 *   BASE RATE, 28-row holdout sample of NON-firing candidates: after discarding harness artifacts,
 *   13 of 20 real user turns (65%) were genuine corrections the detector did not catch.
 *
 *   RECALL, extrapolated over 156 holdout non-firings: roughly 73 missed against 2 caught, i.e.
 *   ABOUT 3%. The detector misses ~97% of the corrections in front of it.
 *
 * So precision was never the binding constraint. And the two problems share ONE fix: broadening the
 * net raises recall AND produces the firing volume that certifying precision requires. Tuning for
 * precision on n=3 does neither, while looking like progress.
 *
 * CAVEAT ON THESE LABELS, stated because it bounds them: they are ONE rater's judgement (mine), not
 * the blind 3-rater majority the earlier 77.8% figure used. Treat them as a direction-finding
 * measurement that reframes the problem, not as a certified precision number. The certified number
 * still requires the volume above.
 *
 * THE NUMBERS THIS PRODUCED ON 2026-07-23 are recorded in correction-detect.mjs's own header
 * (search that file for "MEASURED ON THE REAL CORPUS, 2026-07-23") rather than duplicated here,
 * since a measurement script that also claims to BE the measurement is how numbers rot out of sync
 * with the code they describe.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { lfLines } from '../plugin/scripts/lf-lines.mjs';
import { detectCorrection, HARNESS_TEMPLATES } from './correction-detect.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const defaultCorpusDir = path.join(
  os.homedir(), '.claude', 'projects',
  process.cwd().replace(/\//g, '-'),
);
const CORPUS_DIR = flag('--corpus-dir', defaultCorpusDir);
const DUMP_POOL = flag('--dump-pool', null);
const SPLIT_FILTER = flag('--split', 'all'); // tune | holdout | all

/** Deterministic 55/45 tune/holdout split BY TRANSCRIPT FILE, fixed so re-runs are reproducible. */
function splitOf(fileName) {
  const h = crypto.createHash('md5').update(fileName).digest('hex');
  const n = parseInt(h.slice(0, 8), 16) % 100;
  return n < 55 ? 'tune' : 'holdout';
}

/** Best-effort one-line description of a tool_use block, mirroring how a real hook would summarise it. */
function summarizeToolUse(block) {
  const name = block.name || 'unknown';
  const input = block.input || {};
  let detail;
  if (name === 'Bash') detail = input.command;
  else if (['Edit', 'Write', 'NotebookEdit', 'Read'].includes(name)) detail = input.file_path;
  else if (['Grep', 'Glob'].includes(name)) detail = input.pattern;
  else if (name === 'Task') detail = input.description || input.prompt;
  else if (name === 'TodoWrite') detail = 'todo update';
  else detail = JSON.stringify(input);
  return { tool: name, summary: String(detail ?? '').slice(0, 200) };
}

/**
 * Walk one transcript, emitting a candidate row for every genuinely-typed user turn (string
 * `message.content`, never a tool_result array) that has SOME preceding assistant turn — a tool
 * action if the assistant's last message used one, otherwise a truncated summary of what it said.
 * A pure-text-then-nothing-since boundary correctly resets this to null, matching Signal 1's actual
 * meaning: "is there something for this utterance to be responding to."
 */
async function extractFromFile(file) {
  const rows = [];
  let lastAssistantAction = null;
  let turnIndex = 0;
  const rl = lfLines(fs.createReadStream(file, { encoding: 'utf8' })); // LF only (4.7.31)
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      const toolUses = obj.message.content.filter((b) => b && b.type === 'tool_use');
      if (toolUses.length) {
        lastAssistantAction = summarizeToolUse(toolUses[toolUses.length - 1]);
      } else {
        const text = obj.message.content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join(' ').trim();
        lastAssistantAction = text ? { tool: null, summary: text.slice(0, 200) } : null;
      }
      continue;
    }

    if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
      turnIndex += 1;
      if (lastAssistantAction && (lastAssistantAction.summary || lastAssistantAction.tool)) {
        rows.push({
          file: path.basename(file), turnIndex, timestamp: obj.timestamp,
          promptText: obj.message.content, precedingAssistantAction: lastAssistantAction,
        });
      }
    }
  }
  return rows;
}

/** A deliberately LOOSE lexical net — a superset of every signal the real detector requires — used
 *  only to build a candidate pool small enough for a human to hand-label, never to decide anything. */
const BROAD_NET = /\b(?:always|never|no longer|no more|constantly|repeatedly|stop\b|don'?t\b|do not\b|quit\b|wrong\b|incorrect\b|instead of|rather than|isn'?t what|why (?:did|didn'?t|are|aren'?t) you|you keep|you always|i (?:told|asked) you|already (?:told|asked|said)|should have|failed to|forgot to|from now on|going forward|in the future|henceforth|next time|that'?s not|not what i (?:asked|wanted|said))\b/i;

async function main() {
  let files;
  try {
    files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(CORPUS_DIR, f));
  } catch (e) {
    console.error(`Cannot read corpus dir ${CORPUS_DIR}: ${e.message}`);
    console.error('Pass --corpus-dir <path> to point at a real Claude Code transcript directory.');
    process.exit(1);
  }
  console.error(`[measure] ${files.length} transcript file(s) in ${CORPUS_DIR}`);

  const bySplit = { tune: { total: 0, hits: 0 }, holdout: { total: 0, hits: 0 } };
  const poolRows = [];
  let userTurns = 0;

  for (const file of files) {
    let rows;
    try { rows = await extractFromFile(file); } catch (e) { console.error(`[measure] skip ${file}: ${e.message}`); continue; }
    const split = splitOf(path.basename(file));
    for (const row of rows) {
      userTurns += 1;
      bySplit[split].total += 1;
      const got = detectCorrection(row.promptText, {
        precedingAssistantAction: row.precedingAssistantAction,
        transcriptPath: row.file, turnIndex: row.turnIndex, timestamp: row.timestamp,
      });
      if (got) bySplit[split].hits += 1;

      // Harness artifacts are excluded from the LABELLING POOL, not just from detection. The
      // detector already rejects them (correction-detect.mjs HARNESS_TEMPLATES), so they could never
      // fire — but they were still written out for a human to label. MEASURED in a 28-row holdout
      // sample: 8 of them (29%) were <local-command-caveat> blocks, i.e. a third of the labelling
      // effort spent on rows that are not user speech and whose answer is definitionally "no".
      // Labelled examples are the scarcest resource in this problem; spending 29% of them on
      // harness noise is why the pool looked bigger than it usefully was.
      const isArtifact = HARNESS_TEMPLATES.some((re) => re.test(row.promptText));
      if (DUMP_POOL && !isArtifact && (SPLIT_FILTER === 'all' || SPLIT_FILTER === split)
          && row.promptText.length <= 2000 && BROAD_NET.test(row.promptText)) {
        poolRows.push({ ...row, split, detectorResult: got });
      }
    }
  }

  const total = bySplit.tune.total + bySplit.holdout.total;
  const hits = bySplit.tune.hits + bySplit.holdout.hits;
  console.log(`\nadjacency candidates (Signal 1): ${total}  (tune ${bySplit.tune.total} / holdout ${bySplit.holdout.total})`);
  console.log(`detections: ${hits}  (tune ${bySplit.tune.hits} / holdout ${bySplit.holdout.hits})`);
  console.log(`rate: ${(100 * hits / total).toFixed(3)}%  (tune ${(100 * bySplit.tune.hits / bySplit.tune.total).toFixed(3)}% / holdout ${(100 * bySplit.holdout.hits / bySplit.holdout.total).toFixed(3)}%)`);
  console.log(`\nPrecision and recall require HAND-LABELLING — this script only counts firings.`);
  console.log(`Use --dump-pool <path> to write a labellable candidate pool; the holdout half is the`);
  console.log(`only one whose precision/recall counts as an unbiased measurement.`);

  // ── CAN THE ≥90% FLOOR EVEN BE CERTIFIED FROM THIS MUCH DATA? ────────────────────────────────────
  // ADR-033 holds lesson auto-extraction behind a ≥90% precision floor, and the open work item read
  // "raise correction-detect precision 27% -> 90%" — which frames it as a TUNING problem. It is not,
  // and stating the arithmetic here is what stops it being mistaken for one again.
  //
  // Precision is estimated from the detections, not from the candidate pool, so the holdout FIRING
  // count is the sample size. With every single detection correct, the exact (Clopper-Pearson) 95%
  // one-sided lower bound is p = alpha^(1/n) — closed form, checkable by hand: for n=3 that is the
  // cube root of 0.05, 36.8%. Clearing 90% needs n >= 29 CONSECUTIVE correct detections, and any
  // error pushes the requirement higher still.
  //
  // So a "77.8% at n=19" measurement cannot certify a 90% floor even in principle — at n=19 a PERFECT
  // 19/19 bounds at only 85.4%. Tuning the regex until the point estimate crosses 0.90 on a sample
  // this small is fitting the sample, not the property, and it would produce exactly the confident
  // wrong number this project keeps catching elsewhere.
  const holdoutHits = bySplit.holdout.hits;
  const lowerBoundIfPerfect = holdoutHits > 0 ? Math.pow(0.05, 1 / holdoutHits) : 0;
  const N_FOR_90 = 29;
  console.log(`\ncertifiability of the ADR-033 >=90% precision floor, from THIS run:`);
  console.log(`  holdout detections (the precision sample) : ${holdoutHits}`);
  console.log(`  best possible 95% lower bound (all correct): ${(lowerBoundIfPerfect * 100).toFixed(1)}%`);
  if (lowerBoundIfPerfect >= 0.90) {
    console.log(`  => the sample is LARGE ENOUGH to certify 90% — hand-label the holdout detections.`);
  } else {
    console.log(`  => NOT CERTIFIABLE at any precision: ${holdoutHits} detections cannot bound above`);
    console.log(`     ${(lowerBoundIfPerfect * 100).toFixed(1)}%, and >=90% requires n >= ${N_FOR_90} consecutive correct.`);
    console.log(`     N3 is blocked on LABELLED VOLUME, not on the detector. Tuning against a sample`);
    console.log(`     this small overfits it. The unblock is more transcript corpus (or a broader net`);
    console.log(`     that fires more often), then hand-labelling — not another regex pass.`);
  }

  if (DUMP_POOL) {
    fs.writeFileSync(DUMP_POOL, poolRows.map((r) => JSON.stringify(r)).join('\n') + (poolRows.length ? '\n' : ''));
    console.log(`\nWrote ${poolRows.length} candidate(s) to ${DUMP_POOL} for hand-labelling.`);
    console.log(`This file may contain real transcript text — do not commit it into the repo.`);
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith(`correction-detect-measure${path.extname(process.argv[1])}`);
if (invokedDirectly) main();

export { extractFromFile, splitOf, BROAD_NET };
