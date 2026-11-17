// L1 from manifests (ported from the L+ prototype, layered/lib/manifests.mjs): Cargo.toml, package.json,
// pyproject.toml, setup.py, plugin.json. Every one-line description is a verbatim source line with its
// pointer. Nothing is generated. Dependencies become typed edges.
import { toLines } from './scan.mjs';
import { dirname, posix } from 'node:path';

function tomlSections(lines) {
  const secs = []; let cur = { name: '', start: 0, items: [] }; secs.push(cur);
  lines.forEach((l, i) => {
    const h = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(l);
    if (h) { cur = { name: h[1], start: i + 1, items: [] }; secs.push(cur); return; }
    const kv = /^\s*([\w.\-"]+)\s*=\s*(.*)$/.exec(l);
    if (kv) cur.items.push({ key: kv[1].replace(/"/g, ''), val: kv[2], line: i + 1 });
  });
  return secs;
}
const tomlStr = (v) => { const m = /^\s*"((?:\\.|[^"\\])*)"/.exec(v); return m ? m[1] : null; };

export function parseCargo(path, text) {
  const lines = toLines(text); const secs = tomlSections(lines);
  const pkg = secs.find((s) => s.name === 'package');
  const ws = secs.find((s) => s.name === 'workspace');
  const wsPkg = secs.find((s) => s.name === 'workspace.package');
  const get = (s, k) => s && s.items.find((it) => it.key === k);
  const out = { path, kind: pkg ? 'crate' : ws ? 'cargo-workspace' : 'cargo-manifest', name: null, version: null, desc: null, descLine: null, descInherited: false, deps: [], wsDesc: null };
  if (pkg) {
    const n = get(pkg, 'name'); out.name = n && tomlStr(n.val);
    const v = get(pkg, 'version'); out.version = v ? (tomlStr(v.val) || v.val.trim()) : null;
    const d = get(pkg, 'description');
    const dw = get(pkg, 'description.workspace');
    if (d && tomlStr(d.val) !== null) { out.desc = tomlStr(d.val); out.descLine = d.line; }
    else if (dw || (d && /workspace\s*=\s*true/.test(d.val))) out.descInherited = true;
  }
  if (wsPkg) { const d = get(wsPkg, 'description'); if (d && tomlStr(d.val) !== null) out.wsDesc = { desc: tomlStr(d.val), line: d.line }; }
  if (!out.name) out.name = posix.basename(dirname(path)) || path;
  for (const s of secs) {
    const m = /^(?:target\.[^\]]+\.)?(dependencies|build-dependencies)(?:\.([\w-]+))?$/.exec(s.name);
    if (m && m[2]) { out.deps.push({ name: m[2], line: s.start, kind: m[1] }); continue; }
    if (m) for (const it of s.items) { if (it.key.includes('.')) { const [dn] = it.key.split('.'); if (!out.deps.find((x) => x.name === dn)) out.deps.push({ name: dn, line: it.line, kind: m[1] }); } else out.deps.push({ name: it.key, line: it.line, kind: m[1], pkgAlias: (/package\s*=\s*"([^"]+)"/.exec(it.val) || [])[1] }); }
    if (s.name === 'workspace.dependencies') for (const it of s.items) out.deps.push({ name: it.key.split('.')[0], line: it.line, kind: 'workspace-dependency' });
  }
  return out;
}

// Python: pyproject.toml ([project] or [tool.poetry]) and setup.py (literal keyword arguments only).
export function parsePyproject(path, text) {
  const lines = toLines(text); const secs = tomlSections(lines);
  const sec = secs.find((s) => s.name === 'project') || secs.find((s) => s.name === 'tool.poetry');
  if (!sec) return { error: 'no [project] or [tool.poetry] table' };
  const get = (k) => sec.items.find((it) => it.key === k);
  const n = get('name'), v = get('version'), d = get('description');
  const out = { path, kind: 'python-package', name: (n && tomlStr(n.val)) || posix.basename(dirname(path)), version: v ? tomlStr(v.val) : null, desc: d ? tomlStr(d.val) : null, descLine: d && tomlStr(d.val) !== null ? d.line : null, deps: [] };
  const dep = get('dependencies');
  if (dep && sec.name === 'project') {
    for (let i = dep.line - 1; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/"([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*[<>=!~;" ]/g)) out.deps.push({ name: m[1], line: i + 1, kind: 'dependencies' });
      if (/\]/.test(lines[i])) break;
    }
  }
  const pd = secs.find((s) => s.name === 'tool.poetry.dependencies');
  if (pd) for (const it of pd.items) if (it.key !== 'python') out.deps.push({ name: it.key, line: it.line, kind: 'dependencies' });
  return out;
}
export function parseSetupPy(path, text) {
  const lines = toLines(text);
  const find = (k) => { for (let i = 0; i < lines.length; i++) { const m = new RegExp(`\\b${k}\\s*=\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(lines[i]); if (m) return { val: m[2], line: i + 1 }; } return null; };
  const n = find('name'); if (!n) return { error: 'setup.py without a literal name= argument' };
  const d = find('description'), v = find('version');
  return { path, kind: 'python-package', name: n.val, version: v ? v.val : null, desc: d ? d.val : null, descLine: d ? d.line : null, deps: [] };
}

const lineOfJsonKey =(lines, key, after = 0) => { const re = new RegExp(`^\\s*"${key}"\\s*:`); for (let i = after; i < lines.length; i++) if (re.test(lines[i])) return i + 1; return null; };

export function parsePackageJson(path, text) {
  let j; try { j = JSON.parse(text); } catch (e) { return { error: `invalid JSON: ${e.message.slice(0, 80)}` }; }
  const lines = toLines(text);
  if (!j || typeof j !== 'object' || !j.name) return { error: 'no "name" field (not a package)' };
  const out = { path, kind: 'npm-package', name: j.name, version: j.version || null, desc: typeof j.description === 'string' ? j.description : null, descLine: typeof j.description === 'string' ? lineOfJsonKey(lines, 'description') : null, deps: [], bin: j.bin ? (typeof j.bin === 'string' ? { [j.name]: j.bin } : j.bin) : null, main: j.main || j.module || null };
  for (const sec of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!j[sec]) continue;
    const secLine = lineOfJsonKey(lines, sec) || 1;
    for (const dn of Object.keys(j[sec])) {
      const re = new RegExp(`^\\s*"${dn.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\s*:`);
      let ln = secLine; for (let i = secLine; i < lines.length; i++) if (re.test(lines[i])) { ln = i + 1; break; }
      out.deps.push({ name: dn, line: ln, kind: sec });
    }
  }
  return out;
}

export function parsePluginJson(path, text, allFiles) {
  let j; try { j = JSON.parse(text); } catch (e) { return { error: `invalid JSON: ${e.message.slice(0, 80)}` }; }
  const lines = toLines(text);
  const root = dirname(dirname(path)) === '.' ? '' : dirname(dirname(path));
  const host = /\.codex-plugin\//.test(path) ? 'codex' : 'claude';
  const out = { path, kind: host === 'codex' ? 'codex-plugin' : 'ruflo-plugin', name: j.name || posix.basename(root), version: j.version || null, desc: typeof j.description === 'string' ? j.description : null, descLine: lineOfJsonKey(lines, 'description'), deps: [], provides: [] };
  const pre = root ? root + '/' : '';
  for (const f of allFiles) {
    if (!f.startsWith(pre)) continue;
    const rel = f.slice(pre.length);
    let m;
    if ((m = /^skills\/([^/]+)\/SKILL\.md$/.exec(rel))) out.provides.push({ type: 'plugin-provides-skill', dst: m[1], path: f });
    else if ((m = /^commands\/(.+)\.md$/.exec(rel))) out.provides.push({ type: 'plugin-provides-command', dst: m[1], path: f });
    else if ((m = /^agents\/(.+)\.md$/.exec(rel))) out.provides.push({ type: 'plugin-provides-agent', dst: m[1], path: f });
    else if (/^hooks\/hooks\.json$/.test(rel)) out.provides.push({ type: 'plugin-provides-hooks', dst: 'hooks.json', path: f });
  }
  if (j.mcpServers && typeof j.mcpServers === 'object') for (const k of Object.keys(j.mcpServers)) out.provides.push({ type: 'plugin-provides-mcp-server', dst: k, path, line: lineOfJsonKey(lines, k) });
  return out;
}

// First sentence of a README (verbatim substring of one line) as the fallback source line.
export function readmeFirstSentence(text) {
  const lines = toLines(text); let inFence = false, inHtml = false;
  for (let i = 0; i < Math.min(lines.length, 120); i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^\s*<!--/.test(l)) inHtml = !/-->/.test(l);
    if (inHtml) { if (/-->/.test(l)) inHtml = false; continue; }
    const t = l.trim();
    if (!t || /^(#|<|!\[|\[!\[|\||---|===|>?\s*\[!|>\s*#|\*\*\*)/.test(t) || t.length < 25 || !/[a-z]{3,}\s+[a-z]{2,}/i.test(t)) continue;
    const m = /^(.+?[.!?])(\s|$)/.exec(t);
    return { line: i + 1, text: l, sentence: m ? m[1] : t };
  }
  return null;
}
