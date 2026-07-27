#!/usr/bin/env node
// plugin/scripts/hook-input.mjs — the ONE parser every PreToolUse gate uses to read Claude Code's
// hook event.
//
// WHY (2026-07-18, ADR-0021). Every gate hand-rolled a bash regex to pull fields out of the JSON
// payload: field() { local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""; ... }. `([^"]*)` cannot
// cross a `"`, and a JSON-escaped `\"` is still a literal `"` byte in the raw text — so ANY command
// containing a quote was silently TRUNCATED at the first one. That fails OPEN on exactly the commands
// most worth inspecting (issue #13 fixed this in verify-interface.sh, but design-wall.sh — written
// AFTER — reintroduced the identical bug, because the fix lived in one file's inline `node -e` instead
// of a shared, tested module). JSON string escaping is not a regular language; only a real parser is
// correct. This is that parser, in ONE place, with ONE known-bad fixture test (hook-input.test.mjs),
// imported by every gate.
//
// CLI (what the bash gates call — mirrors the inline `node -e` they used to each carry):
//   printf '%s' "$INPUT" | node hook-input.mjs tool_name        -> prints event.tool_name
//   printf '%s' "$INPUT" | node hook-input.mjs command          -> prints tool_input.command (|| .command)
//   printf '%s' "$INPUT" | node hook-input.mjs field a.b.c      -> prints an arbitrary dotted path
//   printf '%s' "$INPUT" | node hook-input.mjs invocations a,b  -> one TAB-separated line per
//                                                                   EXECUTABLE invocation of any
//                                                                   named tool, anywhere in the
//                                                                   command: `tool<TAB>arg…`
//                                                                   (issues #12/#17/#41/#44)
//
// CONTRACT: prints "" and exits 0 on ANY parse failure or missing field. It NEVER throws to the caller
// and NEVER exits nonzero on bad input — a gate that breaks the shell protects nothing, so fail-open
// (empty string, exit 0) is the invariant. The gate decides policy from the (possibly empty) value.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse the raw stdin payload into the hook event object, or null if it isn't valid JSON. */
export function parseHookEvent(raw) {
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** The tool being invoked ("Bash", "Write", …), or "" if absent. */
export function toolName(ev) {
  return ev && typeof ev.tool_name === 'string' ? ev.tool_name : '';
}

/**
 * The Bash command, read from tool_input.command (Claude Code's real shape) with a top-level
 * `.command` fallback. Correctly returns the WHOLE string including embedded quotes — the bug the
 * old bash regex could not: `git commit -m "fix \"x\""` came back truncated at the first quote.
 */
export function commandOf(ev) {
  if (!ev) return '';
  const c = (ev.tool_input && ev.tool_input.command) ?? ev.command;
  return typeof c === 'string' ? c : '';
}

/** Arbitrary dotted-path lookup (e.g. "tool_input.file_path"); "" if any segment is missing. */
export function field(ev, dottedPath) {
  if (!ev || !dottedPath) return '';
  let cur = ev;
  for (const k of String(dottedPath).split('.')) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = cur[k];
  }
  if (cur == null) return '';
  return typeof cur === 'string' ? cur : String(cur);
}
// ── Shell command classification ─────────────────────────────────────────────────────────────────
//
// WHY THIS IS A PARSER AND NOT A REGEX (2026-07-27, after issues #12, #13, #17, #41, #44 — four
// filed defects and one live capture, all in 13 days, all the SAME defect in two different files).
//
//   #12 (07-13)  matched a tool name in PROSE and in a different binary (`ruflo-source-patch`).
//   #13 (07-14)  a bash regex over the JSON payload truncated the command at the first quote.
//   #41 (07-24)  a `|` inside a quoted grep pattern read as a real shell separator.
//   #44 (07-26)  invocations nested in `bash -lc '…'`, backticks, and `"$( … )"` bypassed the gate.
//   #17 (07-17)  design-wall.sh, a DIFFERENT gate: `[[ $CMD == *"git commit"* ]]` fires on prose.
//                (The reporter said so verbatim in #17 and it was never acted on.)
//   live (07-27) design-wall.sh blocked a maintainer because the words "agentic-qe integration plan"
//                appeared inside a HEREDOC. Prose. Again.
//
// Every one of those fixes upgraded a pattern match over a FLAT STRING, and the next one arrived
// within days. The class does not live in any of those patterns; it lives in the decision to ask a
// string question about a structural fact. `ruflo memory search` is an invocation when `ruflo` is in
// EXECUTABLE POSITION and text when it is not, and no amount of masking, anchoring, or escaping
// makes a flat string able to tell those apart — the fifth patch would have failed the same way.
//
// THE INVARIANT, from here on: an enforcement gate classifies EXECUTABLE STRUCTURE, never a flat
// string. This module is the one classifier. There is deliberately no regex fallback path in any
// gate — a second path is exactly how this class survived four fixes.
//
// ── ARCHITECTURAL NOTE: THIS IS STILL THE WRONG BOUNDARY ─────────────────────────────────────────
// Read this before adding a sixth patch to it.
//
// A parser beats the four regexes that preceded it, and it is still GOVERNING AT AN UNSTRUCTURED
// BOUNDARY. The input is a shell command — a string a human or a model wrote, in a language with
// quoting, substitution, heredocs, aliases, functions and `eval` — and this file's job is to
// reconstruct the structure that the string only implies. Reconstruction is inference, inference has
// a residual error rate, and every one of #12/#13/#41/#44 plus the 07-27 heredoc misfire is a sample
// from it. Being right about all five is not the same as being right about the next one.
//
// rUv's own ecosystem does not do this. It governs where the structure is ALREADY EXPLICIT:
//   • ruvector/npm/packages/ruvector/bin/mcp-policy.js (ADR-256) decides by TOOL NAME over the MCP
//     tool registry — an allowlist with a default-deny posture, precedence DENY > ALLOW/PROFILE.
//     There is no string to parse: the caller already said which tool it wants, by name.
//   • cognitum-seed's src/cognitum-agent/src/mcp_tools.rs maps tool name → AuthClass over a declared
//     tool table, and `tool_auth_class()` returns `AuthClass::Paired` for an unknown name — an
//     explicit SAFE DEFAULT for the case this file has to guess at.
// Both are total functions over a finite, declared surface. Neither can be fooled by a quote.
//
// THE LONG-TERM FIX, recorded so it is not rediscovered a sixth time: move interface verification to
// the structured boundary — the tool-call surface, where the tool name and its arguments arrive as
// fields rather than as text to be re-derived — and shrink string handling to the minimum that the
// remaining raw-Bash surface genuinely requires. This file should get smaller over time, not larger.
// A new patch here is a signal to move the boundary, not to deepen the parser.
// Filed as stuinfla/ruvnet-brain#48, which is where this decision lives until an ADR supersedes it.
// (An earlier draft of this line also claimed an ADR-055 conflict-matrix row; that row was never
// written — ADR-055 carries F1–F22 and none of them is this. A pointer to a doc that does not say
// what the pointer claims is the same defect class this file exists to stop: asserting structure
// that is not actually there.)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// WHAT IS A COMMAND, AND WHAT IS DATA:
//   COMMAND  simple commands split at `;` `&&` `||` `|` `&` newline and group boundaries; `$( … )`
//            and backticks (live at top level AND inside double quotes); process substitutions
//            `<( … )`; literal `sh -c` / `bash -lc` / `bash -ic` / `/bin/sh -c` payloads, recursively.
//   DATA     every quoted ARGUMENT, heredoc bodies, herestrings, `#` comments, single-quoted `$( … )`
//            (single quotes suppress substitution), and `$(( … ))` arithmetic.
//   UNKNOWN  a dynamic executable (`$TOOL foo`, `eval "$cmd"`, `bash -c "$cmd"`). The name is not in
//            the text, so there is nothing to classify: it is reported as NOT a managed invocation
//            and the gate fails open — #12's lesson, kept.

const SHELL_EXES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const NPX_WRAPPERS = new Set(['npx', 'bunx', 'pnpx']);
const MAX_DEPTH = 8;    // `bash -c 'bash -c "…"'` nests; hostile input must still terminate
const MAX_NODES = 256;  // and must not produce unbounded output

function baseName(p) { const i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); }

/** Skip a double-quoted region; `i` is the index just past the opening quote. Returns the index past its close. */
function skipDouble(src, i) {
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === '`') { i = readBacktick(src, i).next; continue; }
    if (c === '$' && src[i + 1] === '(') { i = readParen(src, i + 2).next; continue; }
    i++;
  }
  return src.length;
}

/** Read a `$( … )` body; `start` is the index just past `$(`. Quote- and nesting-aware. */
function readParen(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '"') { i = skipDouble(src, i + 1); continue; }
    if (c === '`') { i = readBacktick(src, i).next; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; if (depth === 0) return { body: src.slice(start, i), next: i + 1 }; i++; continue; }
    i++;
  }
  return { body: src.slice(start), next: src.length };
}

/** Read a backtick substitution; `i` is the index of the opening backtick. */
function readBacktick(src, i) {
  let j = i + 1;
  let body = '';
  while (j < src.length) {
    if (src[j] === '\\' && j + 1 < src.length && '$`\\'.includes(src[j + 1])) { body += src[j + 1]; j += 2; continue; }
    if (src[j] === '`') return { body, next: j + 1 };
    body += src[j]; j++;
  }
  return { body, next: src.length };
}

/** Skip `$(( … ))` arithmetic — not a command substitution, and its `<<` is not a heredoc. */
function readArith(src, i) {
  let depth = 0;
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) return { next: j + 1 }; }
    j++;
  }
  return { next: src.length };
}

/** Skip a heredoc body (DATA, never commands) and its terminator line. */
function skipHeredocBody(src, from, hd) {
  let i = from;
  while (i < src.length) {
    let eol = src.indexOf('\n', i);
    if (eol === -1) eol = src.length;
    const line = src.slice(i, eol);
    i = eol < src.length ? eol + 1 : src.length;
    if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) break;
  }
  return i;
}

/**
 * Split ONE level of shell text into simple commands (each a word list) plus the source text of
 * every command substitution found in it. Words carry `dynamic` when any part of them came from an
 * expansion, because a word whose text is not fully known cannot be classified.
 */
function parseLevel(src) {
  const nodes = [];
  const subs = [];
  let words = [];
  let cur = null;
  const heredocQ = [];
  let i = 0;
  const n = src.length;

  const add = (t) => { if (!cur) cur = { text: '', dynamic: false }; cur.text += t; };
  const mark = () => { if (!cur) cur = { text: '', dynamic: false }; cur.dynamic = true; };
  const endWord = () => { if (cur) { words.push(cur); cur = null; } };
  const endNode = () => { endWord(); if (words.length) nodes.push(words); words = []; };

  while (i < n) {
    const ch = src[i];

    if (ch === '\\' && i + 1 < n) {                       // escape: the next byte is literal text
      if (src[i + 1] !== '\n') add(src[i + 1]);           // (a `\<newline>` is a line continuation)
      i += 2; continue;
    }

    if (ch === "'") {                                     // single quotes: literal, no escapes, no
      const e = src.indexOf("'", i + 1);                  // substitution — pure DATA
      const end = e === -1 ? n : e;
      add(src.slice(i + 1, end));
      i = end + 1; continue;
    }

    if (ch === '"') {                                     // double quotes: DATA, except substitutions
      i++;
      if (!cur) cur = { text: '', dynamic: false };
      while (i < n) {
        const c = src[i];
        if (c === '\\' && i + 1 < n && '$`"\\\n'.includes(src[i + 1])) {
          if (src[i + 1] !== '\n') add(src[i + 1]);
          i += 2; continue;
        }
        if (c === '"') { i++; break; }
        if (c === '`') { const r = readBacktick(src, i); subs.push(r.body); mark(); i = r.next; continue; }
        if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') { mark(); i = readArith(src, i).next; continue; }
        if (c === '$' && src[i + 1] === '(') { const r = readParen(src, i + 2); subs.push(r.body); mark(); i = r.next; continue; }
        if (c === '$') { mark(); add('$'); i++; continue; }
        add(c); i++;
      }
      continue;
    }

    if (ch === '`') { const r = readBacktick(src, i); subs.push(r.body); mark(); i = r.next; continue; }
    if (ch === '$' && src[i + 1] === '(' && src[i + 2] === '(') { mark(); i = readArith(src, i).next; continue; }
    if (ch === '$' && src[i + 1] === '(') { const r = readParen(src, i + 2); subs.push(r.body); mark(); i = r.next; continue; }
    if (ch === '$') { mark(); add('$'); i++; continue; }

    if ((ch === '<' || ch === '>') && src[i + 1] === '(') {   // process substitution — a real command
      const r = readParen(src, i + 2);
      subs.push(r.body); endWord(); i = r.next; continue;
    }

    if (ch === '<' && src[i + 1] === '<' && src[i + 2] === '<') { endWord(); i += 3; continue; } // herestring: DATA

    if (ch === '<' && src[i + 1] === '<') {                   // heredoc: body is DATA, skipped whole
      let j = i + 2;
      let strip = false;
      if (src[j] === '-') { strip = true; j++; }
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      let delim = '';
      while (j < n && !' \t\n;&|<>()'.includes(src[j])) {
        const c = src[j];
        if (c === "'" || c === '"') {
          const e = src.indexOf(c, j + 1);
          const end = e === -1 ? n : e;
          delim += src.slice(j + 1, end); j = end + 1; continue;
        }
        if (c === '\\' && j + 1 < n) { delim += src[j + 1]; j += 2; continue; }
        delim += c; j++;
      }
      endWord();
      if (delim) heredocQ.push({ delim, strip });
      i = j; continue;
    }

    if (ch === '<' || ch === '>') {                           // redirection: a word boundary
      endWord(); i++;
      if (src[i] === '>') i++;
      if (src[i] === '&') i++;
      continue;
    }

    if (ch === '#' && !cur && (i === 0 || ' \t\n;&|('.includes(src[i - 1]))) {  // comment: DATA
      const eol = src.indexOf('\n', i);
      i = eol === -1 ? n : eol; continue;
    }

    if (ch === ';') { endNode(); i++; continue; }
    if (ch === '&') { endNode(); i++; if (src[i] === '&') i++; continue; }
    if (ch === '|') { endNode(); i++; if (src[i] === '|') i++; continue; }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') { endNode(); i++; continue; }
    if (ch === ' ' || ch === '\t') { endWord(); i++; continue; }

    if (ch === '\n') {
      endNode(); i++;
      while (heredocQ.length && i < n) i = skipHeredocBody(src, i, heredocQ.shift());
      continue;
    }

    add(ch); i++;
  }
  endNode();
  return { nodes, subs };
}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Every EXECUTABLE command node in `cmd`, recursively — the one question this module answers.
 *
 * Each node: { exe, argv, assigns, dynamic }. `argv[0]` is the executable as written; an argument
 * whose text is not fully known (it contained an expansion) is reported as `''`, never as a
 * half-word that could be mistaken for a literal token. `dynamic: true` means the EXECUTABLE itself
 * is unknown — the caller must fail open.
 */
export function commandNodes(cmd, depth = 0, acc = []) {
  if (typeof cmd !== 'string' || !cmd || depth > MAX_DEPTH || acc.length >= MAX_NODES) return acc;
  const { nodes, subs } = parseLevel(cmd);
  const payloads = [];

  for (const words of nodes) {
    if (acc.length >= MAX_NODES) break;
    let k = 0;
    const assigns = [];
    while (k < words.length && ASSIGN_RE.test(words[k].text)) { assigns.push(words[k].text); k++; }
    const rest = words.slice(k);
    if (!rest.length) continue;
    const node = {
      assigns,
      dynamic: rest[0].dynamic,
      exe: rest[0].dynamic ? '' : rest[0].text,
      argv: rest.map((w) => (w.dynamic ? '' : w.text)),
    };
    acc.push(node);

    // `sh -c '…'` / `bash -lc '…'`: the argument after a short-flag cluster ending in `c` is a
    // command string BY DEFINITION. If it is not literal it comes through as '' and is skipped —
    // `bash -c "$cmd"` has nothing to classify, so the gate fails open.
    if (!node.dynamic && SHELL_EXES.has(baseName(node.exe))) {
      for (let a = 1; a < node.argv.length; a++) {
        const w = node.argv[a];
        if (!w.startsWith('-')) break;
        if (/^-[A-Za-z]*c$/.test(w)) { if (node.argv[a + 1]) payloads.push(node.argv[a + 1]); break; }
      }
    }
  }

  for (const s of subs) commandNodes(s, depth + 1, acc);
  for (const p of payloads) commandNodes(p, depth + 1, acc);
  return acc;
}

/**
 * Does `cmd` invoke any of `tools` AS AN EXECUTABLE, anywhere — nested shells, substitutions and
 * all? Returns one entry per invocation: { tool, args }, where `args` is that node's own argument
 * list. Prose, comments, heredoc text, quoted arguments and dynamic executables return nothing.
 *
 * `npx`/`bunx`/`pnpx` wrappers are transparent, and a `@version` suffix is stripped — but ONLY at an
 * explicit `@`, so `ruflo-source-patch` is a different binary and not `ruflo` (issue #12).
 */
export function findInvocations(cmd, tools) {
  const want = new Set((Array.isArray(tools) ? tools : String(tools || '').split(',')).map((t) => t.trim()).filter(Boolean));
  const out = [];
  if (!want.size) return out;
  for (const node of commandNodes(cmd)) {
    if (node.dynamic || !node.argv.length) continue;
    let idx = 0;
    if (NPX_WRAPPERS.has(baseName(node.argv[0]))) {
      idx = 1;
      while (idx < node.argv.length && node.argv[idx].startsWith('-')) idx++;
      if (idx >= node.argv.length) continue;
    }
    let name = baseName(node.argv[idx]);
    const at = name.indexOf('@');
    if (at > 0) name = name.slice(0, at);
    if (!want.has(name)) continue;
    out.push({ tool: name, args: node.argv.slice(idx + 1) });
  }
  return out;
}

/** The findInvocations answer as TAB-separated lines (`tool<TAB>arg…`), one per invocation. */
export function invocationLines(cmd, tools) {
  const clean = (s) => String(s).replace(/[\t\r\n]/g, ' ');
  return findInvocations(cmd, tools)
    .map((inv) => [inv.tool, ...inv.args].map(clean).join('\t'))
    .join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const which = process.argv[2] || '';
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    const ev = parseHookEvent(raw);
    let out = '';
    if (which === 'tool_name') out = toolName(ev);
    else if (which === 'command') out = commandOf(ev);
    else if (which === 'field') out = field(ev, process.argv[3] || '');
    else if (which === 'invocations') out = invocationLines(commandOf(ev), process.argv[3] || '');
    process.stdout.write(out);
    // ALWAYS exit 0: a parse miss is an empty string, never a crash the gate has to survive.
    process.exit(0);
  });
  // Empty/again-fail-open: if stdin never sends 'end' with content, don't hang the shell forever.
  process.stdin.on('error', () => { process.stdout.write(''); process.exit(0); });
}
