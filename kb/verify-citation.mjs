#!/usr/bin/env node
// verify-citation.mjs — decide whether an answer is GROUNDED, by ground truth rather than by vibes.
//
// WHY THIS EXISTS
// ---------------
// The old grounding check asked: does the answer contain the string "rvf" or "ruvector"? A model
// that hallucinated "just use RVF!" with zero sources passed. So did an answer citing a file that
// does not exist. Keyword presence is not evidence — an LLM panel once scored a zero-citation
// answer 98/100 on this repo.
//
// A citation is only real if it RESOLVES: the repo must be an indexed store on disk, and the cited
// document path must appear as the `path` of an actual passage inside that store's passages file.
// That is checkable without a model, without the network, and without trusting anything the model
// said. This module does exactly that and nothing else.
//
// The reader (`forge-ask-all.mjs`) prints each hit as:
//     #1  repo=concepts  ce=0.201  vec=0.8686  kind=doc
//     path : concepts/ruvector/CARD/ruvector-card
//     title: ruvector — Capability
// Note the printed path is `<repo>/<docPath>`; inside `concepts.passages.jsonl` the stored `path`
// is just `ruvector/CARD/ruvector-card` (optionally suffixed `#0`, `#1`, … when chunked).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Parse the reader's stdout into structured citations. Never throws; unparseable input → [].
 *
 * STRUCTURE, NOT TEXT PATTERNS (ADR-0102 G-004, #236). The reader dumps each hit's full document body
 * inline, and a retrieved document can contain text shaped exactly like a hit header — including a forged
 * "#N+1 repo=…" block that predicts the next rank, which the old next-header/next-rank guards could not
 * stop ("not airtight"). The reader prints, before each body, `chars: <exact body length>`; the parser
 * consumes the body BY THAT COUNT and requires the 67-'=' terminator right after it, so nothing inside a
 * body is ever scanned for headers. A declared length that does not land on the terminator fails closed:
 * that hit keeps no body and nothing after it is trusted; so does a body without `chars:` once an earlier
 * hit carried one. Output with no `chars:` line at all (a reader older than this field) keeps the previous
 * bounded-span parsing; a header with no body keeps none. `path`/`title`/scores come only from the header lines between
 * a hit's header and its body, never from a body, and hits are numbered #1, #2, … strictly in order.
 */
const SEPARATOR = '='.repeat(67);
export function parseCitations(stdout) {
  const out = [];
  const text = String(stdout ?? '');
  const headerRe = /^#(\d+)[ \t]+repo=(\S+)([^\r\n]*)/gm;
  const nextHeaderRe = /^#\d+\s+repo=\S+/gm;
  const markerRe = /^----- full document -----\r?\n/gm;
  let m;
  let expectedRank = 1;
  let structured = false;
  while ((m = headerRe.exec(text)) !== null) {
    const rank = Number(m[1]);
    if (rank !== expectedRank) continue; // out-of-sequence header: a look-alike, not a real hit
    const headStart = m.index + m[0].length;
    nextHeaderRe.lastIndex = headStart;
    const next = nextHeaderRe.exec(text);
    const nextAt = next ? next.index : text.length;
    markerRe.lastIndex = headStart;
    const marker = markerRe.exec(text);
    const markerAt = marker && marker.index < nextAt ? marker.index : -1;
    const head = text.slice(headStart, markerAt >= 0 ? markerAt : nextAt);
    const pathM = /^path\s*:\s*(.+)$/m.exec(head);
    const titleM = /^title\s*:\s*(.+)$/m.exec(head);
    const charsM = /^chars:\s*(\d+)\b/m.exec(head);
    // A pathless match does not fill (or burn) its rank: real reader output never omits path, and a
    // look-alike fragment consuming the slot would reject the real citation that fills it later.
    if (!pathM) continue;
    let returnedText = null;
    let stop = false;
    if (charsM && markerAt >= 0) {
      const bodyStart = markerAt + marker[0].length;
      const bodyEnd = bodyStart + Number(charsM[1]);
      const terminator = text.startsWith(`\n${SEPARATOR}`, bodyEnd) ? 1 + SEPARATOR.length
        : text.startsWith(`\r\n${SEPARATOR}`, bodyEnd) ? 2 + SEPARATOR.length : 0;
      if (terminator) {
        returnedText = text.slice(bodyStart, bodyEnd);
        structured = true;
        headerRe.lastIndex = bodyEnd + terminator; // resume AFTER the body: its contents are never parsed
      } else stop = true; // the declared body does not end where it says: its boundary, and all after it, is unknown
    } else if (markerAt >= 0 && structured) {
      stop = true; // a body with no declared length after length-bound hits: its boundary is unknown
    } else if (markerAt >= 0) {
      // A reader older than `chars:`: the body is the bounded span up to the next header.
      const body = /^----- full document -----\r?\n([\s\S]*?)\r?\n={67}(?:\r?\n|$)/m.exec(text.slice(headStart, nextAt));
      returnedText = body ? body[1] : null;
    }
    expectedRank = rank + 1;
    const repo = m[2];
    // Metadata comes only from the header, never from a retrieved document body.
    // A proof label is descriptive; consumers must independently validate its evidence.
    const field = (name) => new RegExp(`(?:^|[ \\t])${name}=([^ \\t]+)`).exec(m[3])?.[1] ?? null;
    const score = (name) => {
      const value = field(name);
      return value !== null && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
    };
    const fullPath = pathM[1].trim();
    // Strip the repo prefix the reader adds, so the remainder can be matched against the store.
    const docPath = fullPath.startsWith(`${repo}/`) ? fullPath.slice(repo.length + 1) : fullPath;
    out.push({
      rank,
      repo,
      ce: score('ce'),
      vec: score('vec'),
      kind: field('kind'),
      proofMethod: field('proof'),
      returnedText,
      fullPath,
      docPath,
      title: titleM ? titleM[1].trim() : null,
    });
    if (stop) break;
  }
  return out;
}

/** The passages files that could hold a repo's documents — the slim store and the deep `.big` one. */
export function passagesFilesFor(repo, kbDir) {
  return [path.join(kbDir, `${repo}.passages.jsonl`), path.join(kbDir, `${repo}.big.passages.jsonl`)]
    .filter((p) => fs.existsSync(p));
}

/** True when `stored` is the cited doc, allowing for the `#N` chunk suffix the builder appends. */
function samePath(stored, docPath) {
  return stored === docPath || stored.startsWith(`${docPath}#`);
}

/**
 * Does this citation point at a passage that really exists on disk?
 * Streams the file and stops at the first match, so a 500MB `.big` store costs only as much as it
 * takes to reach the hit. A malformed JSON line is skipped, never fatal.
 */
export async function citationResolves(citation, kbDir) {
  const files = passagesFilesFor(citation.repo, kbDir);
  if (!files.length) return { resolved: false, reason: 'no-store', file: null, storedPath: null };
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (typeof rec?.path === 'string' && samePath(rec.path, citation.docPath)) {
          return { resolved: true, reason: 'ok', file: path.basename(file), storedPath: rec.path };
        }
      }
    } finally {
      rl.close();
    }
  }
  return { resolved: false, reason: 'path-not-in-store', file: null, storedPath: null };
}

/**
 * The gate. An answer is grounded only when it cites at least one passage that resolves on disk.
 * Returns the receipt so a caller can PRINT the evidence instead of asserting a conclusion.
 */
export async function verifyGrounding(stdout, kbDir) {
  const citations = parseCitations(stdout);
  if (!citations.length) {
    return { grounded: false, reason: 'no-citations', citations: [], receipt: null };
  }
  for (const citation of citations) {
    const r = await citationResolves(citation, kbDir);
    if (r.resolved) {
      return {
        grounded: true,
        reason: 'ok',
        citations,
        receipt: { repo: citation.repo, path: citation.fullPath, title: citation.title, file: r.file, storedPath: r.storedPath },
      };
    }
  }
  return { grounded: false, reason: 'citations-do-not-resolve', citations, receipt: null };
}
