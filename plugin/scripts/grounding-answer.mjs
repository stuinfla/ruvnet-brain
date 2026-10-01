#!/usr/bin/env node
/**
 * grounding-answer.mjs — the ONE predicate for "did search_ruvnet actually answer?", shared by the
 * PostToolUse stamp (grounding-stamp.sh calls this file as a CLI) and the Stop gate
 * (grounding-turn-evidence.mjs imports brainAnsweredResponse).
 *
 * 4.4.0 ADVERSARIAL REVIEW, BLOCKER B1. The previous predicate matched success markers anywhere in
 * the tool response. But every lane echoes the MODEL's query back at structuredContent.retrieval.query
 * (kb/grounded-response.mjs) — including the router-decline lane ("NO SEARCH WAS RUN",
 * kb/search-outcome.mjs) and source discovery. A query that merely contained `Searched 37 RuvNet repos`
 * turned a search that never ran into a 24-hour stamp, and the long-turn fallback then trusted it.
 *
 * THE RULE NOW: success is read from the ANSWER TEXT only — `answer` or `content[].text`, never
 * `retrieval`, `grounding`, `routing` or any other echoed field — and the answer must BEGIN with the
 * header the brain itself prints (kb/search-outcome.mjs, kb/card-lane.mjs renderCardHit), optionally
 * after the degraded-search paragraph. Text the model controls never sits at the start of the answer.
 * An oversize result counts only when the host's own notice is the WHOLE response's beginning and the
 * saved file is the host's: under $HOME/.claude/projects/<p>/…/tool-results/, a regular file, not a
 * link, written no later than the tool call, and itself beginning with an answer that passes this rule.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNER = /^Searched \d+ RuvNet repos \(/;
const CARD = /^⚡ FAST LANE — [^\n]*\n#1  repo=\S+  evidence=curated-capability-card\n/;
// The first failed repo's error is quoted inside this paragraph and can itself contain newlines, so the
// paragraph is matched up to its fixed closing sentence, bounded, not up to the first newline.
const DEGRADED = /^⚠ DEGRADED SEARCH: [\s\S]{0,4000}?\nResults below cover only the healthy repos\. Mention this degradation to the user\.\n\n/;
const EMPTY = '(no results — the search ran';
const OVERSIZE = /^Error: result \([\d,]+ characters\) exceeds maximum allowed tokens\. Output has been saved to (\S+?\.txt)\./;
const PERSISTED = /^<persisted-output>\nOutput too large \([^)]*\)\. Full output saved to: (\S+?\.txt)\n/;

/** Does this ANSWER TEXT carry the brain's own success header at its start (and not the empty result)? */
export function answerTextAnswered(text) {
  const t = String(text ?? '').replace(DEGRADED, '');
  if (CARD.test(t)) return true;
  if (!BANNER.test(t)) return false;
  const empty = t.indexOf(EMPTY);
  return empty < 0 || (t.indexOf('#1  repo=') >= 0 && t.indexOf('#1  repo=') < empty);
}

/** JSON-unescape the leading string value of a truncated `{"answer":"…` document (no full parse possible). */
function leadingAnswer(raw) {
  const m = /^\s*\{\s*"answer"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch {
    // Truncated mid-escape: drop a dangling backslash sequence and retry once.
    try { return JSON.parse(`"${m[1].replace(/\\[^"]?$|\\u[0-9a-fA-F]{0,3}$/, '')}"`); } catch { return null; }
  }
}

/** The answer text of a tool response in any shape a host delivers it, or null. Never an echoed field. */
export function answerOf(response) {
  if (response == null) return null;
  if (Array.isArray(response)) {
    const texts = response.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    return texts.length ? answerOf(texts[0]) : null;
  }
  if (typeof response === 'object') {
    if (typeof response.answer === 'string') return response.answer;
    if (Array.isArray(response.content)) return answerOf(response.content);
    if (response.structuredContent && typeof response.structuredContent.answer === 'string') return response.structuredContent.answer;
    return null;
  }
  const s = String(response);
  if (/^\s*[{[]/.test(s)) {
    try { return answerOf(JSON.parse(s)); } catch { return leadingAnswer(s); }
  }
  return s;   // plain text content
}

/** The host's saved-result path when the response IS the host's oversize notice, else null. */
export function oversizePath(response) {
  if (typeof response !== 'string') return null;
  const m = OVERSIZE.exec(response) || PERSISTED.exec(response);
  return m ? m[1] : null;
}

/**
 * Did the brain answer? `notAfterMs`: the file must not be modified after this instant (the tool
 * call's end); `notBeforeMs`: nor long before it (a file planted earlier is not this call's output).
 */
export function brainAnsweredResponse(response, { home = os.homedir(), notAfterMs = null, notBeforeMs = null } = {}) {
  const file = oversizePath(response);
  if (!file) return answerTextAnswered(answerOf(response));
  const projects = path.join(home, '.claude', 'projects') + path.sep;
  if (file.includes('..') || !file.startsWith(projects)
    || !/^[^\\/].*[\\/]tool-results[\\/][^\\/]+$/.test(file.slice(projects.length))) return false;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    if (notAfterMs != null && st.mtimeMs > notAfterMs) return false;
    if (notBeforeMs != null && st.mtimeMs < notBeforeMs) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
      return answerTextAnswered(answerOf(head));
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** CLI for grounding-stamp.sh: a PostToolUse payload on stdin → prints `answered` or nothing. Exit 0. */
async function main() {
  const chunks = [];
  let bytes = 0;
  await new Promise((resolve) => {
    const done = () => resolve();
    const t = setTimeout(done, 3000); t.unref?.();
    process.stdin.on('data', (c) => { if (bytes < 2_097_152) { chunks.push(c); bytes += c.length; } });
    process.stdin.once('end', done); process.stdin.once('error', done);
  });
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const now = Date.now();
    if (brainAnsweredResponse(payload?.tool_response, { notAfterMs: now + 2000, notBeforeMs: now - 300_000 })) {
      process.stdout.write('answered\n');
    }
  } catch { /* unparseable payload: nothing minted */ }
  process.exit(0);
}

function isMain() {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMain()) main();
