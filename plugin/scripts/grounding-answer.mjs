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
import { normalizeToolOutcome } from './continuity-events.mjs';

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

const rejectedExecution = (response) => {
  const execution = normalizeToolOutcome({ content: response });
  return execution.uncertain || ['fail', 'pending', 'interrupted'].includes(execution.outcome);
};

/** The answer text of a tool response in any shape a host delivers it, or null. Never an echoed field. */
export function answerOf(response, depth = 0) {
  if (response == null || depth > 8 || rejectedExecution(response)) return null;
  if (Array.isArray(response)) {
    const block = response.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    return block ? answerOf(block, depth + 1) : null;
  }
  if (typeof response === 'object') {
    if (typeof response.answer === 'string') return response.answer;
    if (Array.isArray(response.content)) return answerOf(response.content, depth + 1);
    if (response.structuredContent && typeof response.structuredContent.answer === 'string') return answerOf(response.structuredContent, depth + 1);
    if (response.type === 'text' && typeof response.text === 'string') return answerOf(response.text, depth + 1);
    return null;
  }
  const s = String(response);
  if (/^\s*[{[]/.test(s)) {
    // The exact envelope supplying an answer must be complete: a prefix can hide later error flags.
    if (Buffer.byteLength(s, 'utf8') > 2_097_152) return null;
    try { return answerOf(JSON.parse(s), depth + 1); } catch { return null; }
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
  if (rejectedExecution(response)) return false;
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
    // Grok duplicates the result as camelCase `toolResult`; read either (its capture also carries tool_response).
    const execution = normalizeToolOutcome({ ...payload, content: payload?.tool_response ?? payload?.toolResult });
    if (execution.uncertain || ['fail', 'pending', 'interrupted'].includes(execution.outcome)) process.exit(0);
    if (brainAnsweredResponse(payload?.tool_response ?? payload?.toolResult, { notAfterMs: now + 2000, notBeforeMs: now - 300_000 })) {
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
