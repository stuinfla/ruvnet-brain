// The optional write guard (work package 10): "search before you hand-write what rUv already ships",
// rebuilt so it cannot trap a session (defects C3, C4, H20 of 4.7.28).
//
// One hook program, run before a file write (stdin: the host's hook message). Its rules:
//   - It is OFF unless the user turned it on (`ruvnet-brain guard on` writes state/config.json
//     guard: true). The installer never turns it on.
//   - It reads only the CONTENT being written (never the path or the rest of the message) for the
//     product names in guard.json.
//   - It checks the one health verdict first. When search is not ok it allows the write with one
//     honest line: a health problem never blocks work.
//   - A write passes when this session has a search_ruvnet result from the installed pack within
//     freshMinutes. That record is the host's own transcript of this session (the path the host
//     gives), and a result counts only when one of its citations re-hashes to the cited sha256
//     against the installed pack. There is no stamp file and nothing that writes one.
//   - An in-file line (guard.json override) lets the write through; it is recorded.
//   - It never runs, imports or reads a file from the project: everything it loads is beside it.
//   - One failure mode: anything it cannot decide (an unreadable record, a damaged pack, an internal
//     error) allows the write with one line saying why. The only non-zero exit is the refusal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { brainHome, isMain, paths, readConfig, readJson } from '../contract/home.mjs';
import { assessHome } from '../health/assess.mjs';
import { redact } from '../cli/redact.mjs';

const G = JSON.parse(fs.readFileSync(new URL('./guard.json', import.meta.url), 'utf8'));
const TAG = '[RuvNet Brain guard]';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const CITE = /^\d+\. (\S+) · lines (\d+)-(\d+) · commit \S+ · standing \S+ · date \S+ · sha256 ([0-9a-f]{64})/;

/** The text a write would put in a file, from the host's tool input. */
export function contentOf(input) {
  const t = input?.tool_input ?? {};
  const parts = [t.content, t.new_string, t.new_source, ...(Array.isArray(t.edits) ? t.edits.map((e) => e?.new_string) : [])];
  return parts.filter((p) => typeof p === 'string').join('\n');
}

export function termIn(text) {
  const low = text.toLowerCase();
  return G.terms.find((t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[-]/g, '\\-')}([^a-z0-9]|$)`).test(low)) ?? null;
}

function overrideIn(text) {
  for (const line of text.split('\n')) {
    const i = line.indexOf(G.override);
    if (i < 0) continue;
    const reason = line.slice(i + G.override.length).replace(/(\*\/|-->|#}|%>)\s*$/, '').trim();
    if (reason.length >= 3) return reason;
  }
  return null;
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('') : '');

/** search_ruvnet results of this session within the window, newest first: [{ at, text }]. */
export function sessionResults(transcript, now) {
  const calls = new Map();
  const out = [];
  for (const raw of fs.readFileSync(transcript, 'utf8').split('\n')) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      continue;
    }
    const at = Date.parse(m?.timestamp ?? '');
    for (const c of Array.isArray(m?.message?.content) ? m.message.content : []) {
      if (c?.type === 'tool_use' && typeof c.name === 'string' && (c.name === G.toolSuffix || c.name.endsWith(`__${G.toolSuffix}`))) calls.set(c.id, c.name);
      if (c?.type === 'tool_result' && calls.has(c.tool_use_id) && !c.is_error && Number.isFinite(at) && now - at <= G.freshMinutes * 60_000 && at <= now + 60_000) {
        out.push({ at, text: textOf(c.content) });
      }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** True when one citation of the result re-hashes to its sha256 against the installed pack. */
export async function verifiedAgainstPack(home, results) {
  const cur = readJson(paths(home).current, null);
  if (!cur) return false;
  const engine = await import('../engine/index.mjs');
  const gens = [cur.pack, cur.previous?.pack].filter(Boolean);
  for (const gen of gens) {
    const packDir = path.join(paths(home).packs, gen);
    if (!fs.existsSync(packDir)) continue;
    const h = engine.open(packDir);
    try {
      for (const r of results) {
        if (!r.text.startsWith(G.resultHeader) || !r.text.split('\n')[0].includes(`pack ${gen}`)) continue;
        for (const line of r.text.split('\n')) {
          const c = CITE.exec(line);
          if (!c) continue;
          const [ref, a, b, hash] = [c[1], Number(c[2]), Number(c[3]), c[4]];
          for (let i = ref.indexOf('/'); i > 0; i = ref.indexOf('/', i + 1)) {
            const rows = engine.read(h, ref.slice(0, i), ref.slice(i + 1));
            if (!rows.length) continue;
            const lines = [];
            for (const row of rows) String(row.text).split('\n').forEach((t, k) => (lines[row.start_line + k] = t.trim() ? t : ''));
            const cited = Array.from({ length: b - a + 1 }, (_, k) => lines[a + k] ?? '').join('\n');
            if (sha(cited) === hash) return true;
          }
        }
      }
    } finally {
      engine.close(h);
    }
  }
  return false;
}

/** The one file the guard writes, inside the brain home, and only when an override is used. */
export const OVERRIDE_LOG = 'state/guard-overrides.jsonl';

function record(home, entry) {
  const file = path.join(home, ...OVERRIDE_LOG.split('/'));
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {}
  lines.push(JSON.stringify(entry));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.slice(-G.logMax).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The decision for one hook message: { action: off|allow|advise|override|refuse, line }. */
export async function decide(input, { home = brainHome(), now = Date.now() } = {}) {
  if (readConfig(home).guard !== true) return { action: 'off' };
  const text = contentOf(input);
  const term = termIn(text);
  if (!term) return { action: 'allow' };
  const file = String(input?.tool_input?.file_path ?? input?.tool_input?.notebook_path ?? '(unnamed file)');
  const reason = overrideIn(text);
  if (reason) {
    // The log and the line carry the reason and path with secret-shaped values masked (review F21).
    const said = redact(reason);
    record(home, { at: new Date(now).toISOString(), file: redact(file), term, reason: said });
    return { action: 'override', line: `${TAG} override recorded for ${redact(path.basename(file))}: ${said}` };
  }
  const v = assessHome(home, { now });
  if (v.state !== 'ok') return { action: 'advise', line: `${TAG} advisory only: search is ${v.label} (${v.reason}), so this write is not checked; it names ${term}, so search_ruvnet when the Brain is back` };
  if (!input?.transcript_path) return { action: 'advise', line: `${TAG} advisory only: the host gave no session record, so this write is not checked; it names ${term}` };
  const results = sessionResults(input.transcript_path, now);
  if (results.length && (await verifiedAgainstPack(home, results))) return { action: 'allow' };
  return {
    action: 'refuse',
    line: `${TAG} this file names ${term}, and this session has no search_ruvnet result from the installed pack in the last ${G.freshMinutes} minutes. Search first with search_ruvnet, or put this line in the file to write it anyway: ${G.override} <your reason>`,
  };
}

/** Runs the hook: reads the message from stdin, prints at most one line, exits 2 only to refuse. */
export async function hook({ stdin = process.stdin, out = process.stdout, err = process.stderr, home = brainHome() } = {}) {
  let d;
  try {
    let raw = '';
    for await (const chunk of stdin) raw += chunk;
    d = await decide(JSON.parse(raw || '{}'), { home });
  } catch (e) {
    d = { action: 'advise', line: `${TAG} advisory only: the guard could not decide (${String(e?.message ?? e).split('\n')[0].slice(0, 120)}), so the write is allowed` };
  }
  if (d.action === 'refuse') {
    err.write(`${d.line}\n`);
    return 2;
  }
  if (d.line) out.write(`${JSON.stringify({ systemMessage: d.line })}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await hook();
