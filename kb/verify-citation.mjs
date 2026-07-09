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

/** Parse the reader's stdout into structured citations. Never throws; unparseable input → []. */
export function parseCitations(stdout) {
  const out = [];
  const text = String(stdout ?? '');
  const blockRe = /^#(\d+)\s+repo=(\S+)(?:\s+ce=(-?[\d.]+))?(?:\s+vec=(-?[\d.]+))?(?:\s+kind=(\S+))?/gm;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const rest = text.slice(m.index);
    const pathM = /^path\s*:\s*(.+)$/m.exec(rest);
    const titleM = /^title\s*:\s*(.+)$/m.exec(rest);
    if (!pathM) continue;
    const repo = m[2];
    const fullPath = pathM[1].trim();
    // Strip the repo prefix the reader adds, so the remainder can be matched against the store.
    const docPath = fullPath.startsWith(`${repo}/`) ? fullPath.slice(repo.length + 1) : fullPath;
    out.push({
      rank: Number(m[1]),
      repo,
      ce: m[3] !== undefined ? Number(m[3]) : null,
      vec: m[4] !== undefined ? Number(m[4]) : null,
      kind: m[5] ?? null,
      fullPath,
      docPath,
      title: titleM ? titleM[1].trim() : null,
    });
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
