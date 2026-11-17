// L2 code extractors of the layered store (ported unchanged in behaviour from the L+ prototype,
// layered/lib/extract-code.mjs): flag, command, mcp-tool, mcp-schema, const, default, env, signature, test.
// Each extractor returns rows {kind, symbol, line_start, line_end, anchor, term}; text is filled by the caller
// from the exact line range, so stored text can never differ from the file.
import { matchBalanced, lineStarts, offsetToLine, indentOf, LIT } from './scan.mjs';

const strVal = (s) => { const m = /^\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(s); return m ? m[2] : null; };

// ---------- CLI commands and flags (ruflo `Command` objects, commander, clap) ----------
export function extractCli(lines, src, lang) {
  const rows = [];
  if (lang === 'js') {
    const starts = lineStarts(lines);
    // const objects: varName -> {name, a, b, subs[]}
    const objs = [];
    const reConst = /^(?:export\s+)?const\s+(\w+)(?:\s*:\s*[\w<>[\]]+)?\s*=\s*\{/;
    lines.forEach((l, i) => {
      const m = reConst.exec(l); if (!m) return;
      const open = starts[i] + l.lastIndexOf('{');
      const close = matchBalanced(src, open, 'js'); if (close < 0) return;
      const b = offsetToLine(starts, close);
      const body = lines.slice(i + 1, b);
      const nameLine = body.findIndex((x) => /^\s{2}name:\s*['"`]/.test(x));
      if (nameLine < 0) return;
      const subsM = /subcommands:\s*\[([^\]]*)\]/.exec(src.slice(open, close));
      objs.push({ v: m[1], name: strVal(body[nameLine].replace(/^\s*name:/, '')), a: i + 1, b, subs: subsM ? subsM[1].split(/[\s,]+/).filter(Boolean) : [] });
    });
    const parentOf = {};
    for (const o of objs) for (const s of o.subs) parentOf[s] = o;
    const pathOf = (o) => { const p = []; let cur = o, guard = 0; while (cur && guard++ < 6) { p.unshift(cur.name); cur = parentOf[cur.v]; } return p.join(' '); };
    // command rows: each const object that has description+ (action|options|subcommands)
    for (const o of objs) {
      const text = lines.slice(o.a - 1, o.b).join('\n');
      if (!/\n\s{2}description:/.test(text) || !/\n\s{2}(action|options|subcommands):/.test(text)) continue;
      const nl = lines.slice(o.a - 1, o.b).findIndex((x) => /^\s{2}name:/.test(x)) + o.a;
      const dl = lines.slice(o.a - 1, o.b).findIndex((x) => /^\s{2}description:/.test(x)) + o.a;
      const a = Math.min(nl, dl), b = Math.max(nl, dl);
      if (b - a <= 14) rows.push({ kind: 'command', symbol: pathOf(o), line_start: a, line_end: b, top: !parentOf[o.v], descLine: dl });
    }
    // options arrays
    lines.forEach((l, i) => {
      const m = /\boptions:\s*\[/.exec(l); if (!m) return;
      const ind = indentOf(l);
      const open = starts[i] + l.indexOf('[', m.index);
      const close = matchBalanced(src, open, 'js'); if (close < 0) return;
      const owner = objs.find((o) => o.a <= i + 1 && o.b >= i + 1);
      let cmd = owner ? pathOf(owner) : null;
      // inline (non-const) command object: nearest preceding `name:` at the same indent
      for (let k = i - 1; k >= Math.max(0, i - 60); k--) {
        if (indentOf(lines[k]) < ind && lines[k].trim()) break;
        if (indentOf(lines[k]) === ind && /^\s*name:\s*['"`]/.test(lines[k])) {
          const nm = strVal(lines[k].replace(/^\s*name:/, ''));
          if (owner && nm !== owner.name) cmd = `${pathOf(owner)} ${nm}`; else if (!owner) cmd = nm;
          break;
        }
      }
      // walk top-level elements of the array
      let j = open + 1;
      while (j < close) {
        const c = src[j];
        if (c === '{') {
          const e = matchBalanced(src, j, 'js'); if (e < 0 || e > close) break;
          const body = src.slice(j, e + 1);
          const nm = /(?:^|[{,\s])name:\s*(['"`])([^'"`]+)\1/.exec(body);
          if (nm && /\b(type|description|short|default)\s*:/.test(body) && !/\bvalue\s*:/.test(body)) {
            const a = offsetToLine(starts, j), b = offsetToLine(starts, e);
            const dm = /\bdefault:\s*([^,\n}]+)/.exec(body);
            rows.push({ kind: 'flag', symbol: `${cmd || '?'} --${nm[2]}`, line_start: a, line_end: b, term: dm ? `default=${dm[1].trim()}` : null });
          }
          j = e + 1; continue;
        }
        if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) break; continue; }
        j++;
      }
    });
    // commander .option('--x <v>', 'desc', default)
    lines.forEach((l, i) => {
      const m = /\.(?:option|requiredOption)\(\s*(['"`])([^'"`]*--[\w-]+[^'"`]*)\1/.exec(l);
      if (m) rows.push({ kind: 'flag', symbol: m[2].match(/--[\w-]+/)[0], line_start: i + 1, line_end: i + 1, term: 'commander' });
    });
  }
  if (lang === 'rs') {
    lines.forEach((l, i) => {
      if (!/^\s*#\[(arg|clap)\(/.test(l)) return;
      let b = i; while (b < lines.length - 1 && b - i < 10 && !/^\s*(pub\s+)?\w+\s*:/.test(lines[b + 1]) ) b++;
      b = Math.min(b + 1, lines.length - 1);
      const f = /^\s*(?:pub\s+)?(\w+)\s*:/.exec(lines[b]);
      if (b - i <= 14) rows.push({ kind: 'flag', symbol: f ? `--${f[1].replace(/_/g, '-')}` : '?', line_start: i + 1, line_end: b + 1, term: /default_value/.test(lines.slice(i, b + 1).join(' ')) ? 'clap-default' : 'clap' });
    });
  }
  if (lang === 'js') {
    // commander / yargs: .command('name ...') lines
    lines.forEach((l, i) => {
      const m = /\.command\(\s*(['"`])([\w:-]+)[^'"`]*\1/.exec(l);
      if (m) rows.push({ kind: 'command', symbol: m[2], line_start: i + 1, line_end: i + 1, term: 'commander' });
    });
  }
  if (lang === 'py') {
    const starts = lineStarts(lines);
    // argparse add_argument / click & typer option decorators: whole call, bracket-matched
    lines.forEach((l, i) => {
      const m = /(?:\.add_argument|@(?:click|typer)\.(?:option|argument)|\btyper\.Option)\(\s*(['"])(-{0,2}[\w-]+)\1/.exec(l);
      if (!m) return;
      const open = starts[i] + l.indexOf('(', m.index);
      const close = matchBalanced(src, open, 'py');
      const b = close < 0 ? i + 1 : offsetToLine(starts, close);
      if (b - i <= 15) rows.push({ kind: 'flag', symbol: m[2], line_start: i + 1, line_end: b, term: /\bdefault\s*=/.test(lines.slice(i, b).join(' ')) ? 'py-default' : 'py' });
    });
    // click/typer command decorators: decorator line through the def line
    lines.forEach((l, i) => {
      if (!/^\s*@(?:\w+\.)?(?:command|group)\(/.test(l)) return;
      for (let k = i + 1; k < Math.min(lines.length, i + 12); k++) { const d = /^\s*(?:async\s+)?def\s+(\w+)/.exec(lines[k]); if (d) { rows.push({ kind: 'command', symbol: d[1], line_start: i + 1, line_end: k + 1, term: 'py-command' }); break; } }
    });
  }
  return rows;
}

// ---------- MCP tools: object with name + (inputSchema|input_schema); also .tool('x' / registerTool( ----------
export function extractMcp(lines, src, lang) {
  const rows = [];
  if (lang !== 'js' && lang !== 'rs' && lang !== 'py') return rows;
  const starts = lineStarts(lines);
  const reKey = /^(\s*)["']?(inputSchema|input_schema)["']?\s*[:=]/;
  const reName = /^\s*["']?name["']?\s*[:=]\s*(?:String::from\()?["'`]([\w.:\-/]+)["'`]/;
  lines.forEach((l, i) => {
    const one = /\bname:\s*['"`]([\w.:\-/]+)['"`][^\n]*\binputSchema\s*:/.exec(l); // whole tool on one line
    if (one && !reKey.test(l)) rows.push({ kind: 'mcp-tool', symbol: one[1], line_start: i + 1, line_end: i + 1, term: 'single-line', descLine: i + 1 });
    const m = reKey.exec(l); if (!m) return;
    const ind = m[1].length;
    let nameLine = -1, name = null;
    for (let k = i - 1; k >= Math.max(0, i - 60); k--) {
      if (lines[k].trim() && indentOf(lines[k]) < ind) break;
      const nm = reName.exec(lines[k]);
      if (nm && indentOf(lines[k]) === ind) { nameLine = k; name = nm[1]; break; }
    }
    if (nameLine < 0) return;
    rows.push({ kind: 'mcp-tool', symbol: name, line_start: nameLine + 1, line_end: i, term: 'name+description', descLine: findDesc(lines, nameLine, i, ind) });
    const brace = l.search(/[{(]/, m[0].length);
    const openIdx = l.slice(m[0].length).search(/[{(]/);
    let b = i + 1;
    if (openIdx >= 0) {
      const close = matchBalanced(src, starts[i] + m[0].length + openIdx, lang === 'py' ? 'py' : lang);
      if (close >= 0) b = offsetToLine(starts, close);
    }
    void brace;
    rows.push({ kind: 'mcp-schema', symbol: name, line_start: i + 1, line_end: b, term: m[2] });
  });
  lines.forEach((l, i) => {
    const m = /\.(tool|registerTool)\(\s*['"`]([\w.:\-/]+)['"`]/.exec(l);
    // definitions only: a client invoking a tool (`await client.tool('x', args)`, `callTool`) is not a definition
    if (m && /\b(?:await\s+[\w.]*|client\w*\.|session\.)(?:tool|registerTool)\(/.test(l)) return;
    if (m) rows.push({ kind: 'mcp-tool', symbol: m[2], line_start: i + 1, line_end: Math.min(lines.length, i + 4), term: m[1] });
  });
  // decorator / attribute style: Python @mcp.tool(...) / @server.tool(), Rust rmcp #[tool(...)] -> next def/fn
  lines.forEach((l, i) => {
    const py = lang === 'py' && /^\s*@\w+\.tool\b/.test(l);
    const rs = lang === 'rs' && /^\s*#\[tool\b/.test(l);
    if (!py && !rs) return;
    const fnRe = py ? /^\s*(?:async\s+)?def\s+(\w+)/ : /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?fn\s+(\w+)/;
    for (let k = i + 1; k < Math.min(lines.length, i + 15); k++) {
      const f = fnRe.exec(lines[k]);
      if (f) { const nm = /name\s*=\s*["']([\w.:-]+)["']/.exec(lines.slice(i, k).join(' ')); rows.push({ kind: 'mcp-tool', symbol: nm ? nm[1] : f[1], line_start: i + 1, line_end: k + 1, term: py ? 'py-decorator' : 'rmcp-attribute', descLine: i + 1 }); break; }
    }
  });
  return rows;
}
function findDesc(lines, a, b, ind) {
  for (let k = a; k < b; k++) if (indentOf(lines[k]) === ind && /^\s*["']?description["']?\s*[:=]/.test(lines[k])) return k + 1;
  return null;
}

// ---------- constants and defaults ----------
const RE_FALLBACK = new RegExp(String.raw`([\w$.?\[\]'"]+)\s*(\?\?|\|\|)\s*(${LIT})(?![\w.])`, 'g');
const RE_PARAM = new RegExp(String.raw`[(,{]\s*(\w+)\s*(?:\??:\s*[\w.<>\[\]| '"]+?)?\s*=\s*(${LIT})\s*(?=[,)}])`, 'g');
export function extractDefaults(lines, src, lang) {
  const rows = [];
  const starts = lineStarts(lines);
  const push = (kind, symbol, a, b, term) => rows.push({ kind, symbol, line_start: a, line_end: b, term });
  if (lang === 'js') {
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      let m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\b(?:\s*:[^=]+)?\s*=\s*(.*)$/.exec(l);
      const objM = /^\s*(?:export\s+)?(?:const|let|var)\s+(\w*(?:Config|CONFIG|Defaults|DEFAULTS|defaults|DEFAULT|Options|Settings|Limits|LIMITS)\w*)\b(?:\s*:[^=]+)?\s*=\s*(?:Object\.freeze\()?\{/.exec(l);
      if (m && !/^[{[(]/.test(m[2].trim()) && !objM) {
        let b = i; while (b < lines.length - 1 && b - i < 14 && !/;\s*(\/\/.*)?$/.test(lines[b]) && /[,(+?:|&]\s*$|^\s*$/.test(lines[b] + '')) b++;
        push('const', m[1], i + 1, b + 1, null);
      }
      const objName = objM ? objM[1] : (m && /^[{[]/.test(m[2].trim()) ? m[1] : null);
      if (objName) {
        const open = starts[i] + l.lastIndexOf(/\[\s*$/.test(l) ? '[' : '{');
        const close = matchBalanced(src, open, 'js');
        const b = close < 0 ? i + 1 : offsetToLine(starts, close);
        push('const', objName, i + 1, Math.min(i + 1, b), 'object-head');
        const keyRe = new RegExp(String.raw`^\s*['"]?([\w-]+)['"]?\s*:\s*(${LIT})\s*,?\s*(//.*)?$`);
        for (let k = i + 1; k < b - 1; k++) { const km = keyRe.exec(lines[k]); if (km) push('default', `${objName}.${km[1]}`, k + 1, k + 1, 'object-key'); }
      }
      for (const fm of l.matchAll(RE_PARAM)) if (!/^\s*(const|let|var)\s/.test(l) || /=>|function/.test(l)) push('default', fm[1], i + 1, i + 1, 'param');
      for (const fm of l.matchAll(RE_FALLBACK)) push('default', fm[1], i + 1, i + 1, fm[2]);
      const cf = new RegExp(String.raw`^\s*(?:(?:private|public|protected|readonly|static)\s+)+(\w+)\s*(?::[^=]+)?=\s*(${LIT})\s*;`).exec(l);
      if (cf) push('default', cf[1], i + 1, i + 1, 'class-field');
    });
  }
  if (lang === 'rs') {
    lines.forEach((l, i) => {
      if (/^\s*\/\//.test(l)) return;
      const c = /^\s*(?:pub(?:\([\w:]+\))?\s+)?(const|static)\s+([A-Z_][A-Z0-9_]*)\s*:/.exec(l);
      if (c) { let b = i; while (b < lines.length - 1 && b - i < 14 && !/;\s*(\/\/.*)?$/.test(lines[b])) b++; push('const', c[2], i + 1, b + 1, c[1]); }
      const d = /^\s*impl(?:<[^>]*>)?\s+Default\s+for\s+(\w+)/.exec(l);
      if (d) {
        const open = starts[i] + (l.indexOf('{') >= 0 ? l.indexOf('{') : -1);
        if (open >= starts[i]) {
          const close = matchBalanced(src, open, 'rs'); const b = close < 0 ? i + 1 : offsetToLine(starts, close);
          push('default', `${d[1]}::default`, i + 1, i + 1, 'impl-default');
          for (let k = i + 1; k < b - 1; k++) {
            if (/^\s*\/\//.test(lines[k])) continue;
            if (/->|^\s*(let|fn|if|match|for|while)\b/.test(lines[k])) continue;
            for (const fm of lines[k].matchAll(/(?:^\s*|[{,]\s*)(\w+)\s*:\s*([^,{}]+?)\s*(?=,|}|$)/g)) {
              if (/^(fn|let|Self|impl|pub|where)$/.test(fm[1]) || /^:/.test(fm[2])) continue;
              push('default', `${d[1]}.${fm[1]}`, k + 1, k + 1, 'impl-default-field');
            }
          }
        }
      }
      const s = /#\[serde\([^)]*\bdefault\b/.exec(l);
      if (s) { const f = /^\s*(?:pub\s+)?(\w+)\s*:/.exec(lines[i + 1] || ''); push('default', f ? f[1] : 'serde', i + 1, Math.min(lines.length, i + 2), 'serde-default'); }
      for (const fm of l.matchAll(/([\w.()]+)\.unwrap_or\(\s*([^()]{1,40}?)\s*\)/g)) push('default', fm[1], i + 1, i + 1, 'unwrap_or');
      const df = /^\s*(?:pub\s+)?fn\s+(default_\w+)\s*\(\s*\)/.exec(l);
      if (df) { let b = i; while (b < lines.length - 1 && b - i < 6 && !/^\s*}\s*$/.test(lines[b]) && !/}\s*$/.test(lines[b])) b++; push('default', df[1], i + 1, b + 1, 'serde-default-fn'); }
    });
  }
  if (lang === 'py') {
    lines.forEach((l, i) => {
      const f = /(\w+)\s*(?::[^=]+)?=\s*Field\(\s*default\s*=/.exec(l); if (f) push('default', f[1], i + 1, i + 1, 'pydantic');
      const c = /^([A-Z_][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(.+)$/.exec(l); if (c) push('const', c[1], i + 1, i + 1, null);
      const dc = new RegExp(String.raw`^\s{4}(\w+)\s*:\s*[\w\[\], .|]+=\s*(${LIT})\s*(#.*)?$`).exec(l); if (dc) push('default', dc[1], i + 1, i + 1, 'class-attr');
      for (const fm of l.matchAll(new RegExp(String.raw`[(,]\s*(\w+)\s*(?::\s*[\w\[\], .|]+?)?\s*=\s*(${LIT})\s*(?=[,)])`, 'g'))) if (/def\s|^\s+\w+.*[,(]/.test(l)) push('default', fm[1], i + 1, i + 1, 'param');
    });
  }
  return rows;
}

// ---------- environment variables ----------
const ENV_RES = [
  [/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, 'process.env'],
  [/process\.env\[\s*['"`]([^'"`]+)['"`]\s*\]/g, 'process.env'],
  [/(?:std::)?env::var(?:_os)?\(\s*"([^"]+)"/g, 'env::var'],
  [/\b(?:option_)?env!\(\s*"([^"]+)"/g, 'env!'],
  [/os\.(?:getenv|environ\.get|environ\.setdefault)\(\s*['"]([^'"]+)['"]/g, 'os.getenv'],
  [/os\.environ\[\s*['"]([^'"]+)['"]\s*\]/g, 'os.environ'],
  [/Deno\.env\.get\(\s*['"]([^'"]+)['"]/g, 'Deno.env'],
];
export function extractEnv(lines, lang) {
  const rows = [];
  lines.forEach((l, i) => {
    const seen = new Set();
    if (lang === 'js' || lang === 'rs' || lang === 'py') for (const [re, term] of ENV_RES) for (const m of l.matchAll(re)) seen.add(`${m[1]}\u0000${term}`);
    if (lang === 'sh') for (const m of l.matchAll(/\$\{([A-Z_][A-Z0-9_]*):?[-=]/g)) seen.add(`${m[1]}\u0000sh-default`);
    for (const k of seen) { const [sym, term] = k.split('\u0000'); rows.push({ kind: 'env', symbol: sym, line_start: i + 1, line_end: i + 1, term }); }
  });
  return rows;
}

// ---------- exported signatures ----------
export function extractSignatures(lines, lang) {
  const rows = [];
  const add = (sym, a, sigA, b) => { if (b - a > 29) a = sigA; rows.push({ kind: 'signature', symbol: sym, line_start: a, line_end: b }); };
  lines.forEach((l, i) => {
    let m, sym = null;
    if (lang === 'js') {
      if ((m = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|interface|type|enum|const|let|namespace)\s+([\w$]+)/.exec(l))) sym = m[2];
      else if ((m = /^export\s+(?:type\s+)?\{/.exec(l))) {
        let b = i; while (b < lines.length - 1 && b - i < 14 && !/\}/.test(lines[b])) b++;
        rows.push({ kind: 'signature', symbol: 're-export', line_start: i + 1, line_end: b + 1, term: 're-export' }); return;
      }
      else if ((m = /^(?:module\.exports|exports\.(\w+))\s*=/.exec(l))) { rows.push({ kind: 'signature', symbol: m[1] || 'module.exports', line_start: i + 1, line_end: i + 1, term: 'commonjs' }); return; }
      else if ((m = /^export\s+\*\s+from/.exec(l))) { rows.push({ kind: 'signature', symbol: 're-export', line_start: i + 1, line_end: i + 1, term: 're-export' }); return; }
    } else if (lang === 'rs') {
      if ((m = /^\s*pub\s+(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"C"\s+)?(fn|struct|enum|trait|type|mod|union)\s+(\w+)/.exec(l))) sym = m[2];
    } else if (lang === 'py') {
      if ((m = /^(?:async\s+)?(def|class)\s+(\w+)/.exec(l)) && !m[2].startsWith('_')) sym = m[2];
    }
    if (!sym) return;
    let a = i; // doc comments/attributes directly above
    const docRe = lang === 'rs' ? /^\s*(\/\/\/|\/\/!|#\[)/ : lang === 'js' ? /^\s*(\/\*\*|\*|\*\/|@\w)/ : /^\s*@/;
    while (a > 0 && docRe.test(lines[a - 1]) && i - a < 25) a--;
    let b = i; const stop = lang === 'py' ? /:\s*(#.*)?$/ : /[{;]\s*(\/\/.*)?$|=>|=\s*$|^\s*\w.*=\s*[^=>]/;
    while (b < lines.length - 1 && b - i < 7 && !stop.test(lines[b])) b++;
    add(sym, a + 1, i + 1, b + 1);
  });
  return rows;
}

// ---------- tests (behaviour names) ----------
export function extractTests(lines, lang) {
  const rows = [];
  lines.forEach((l, i) => {
    if (lang === 'js') { const m = /\b(it|test|describe)(?:\.\w+)?\(\s*(['"`])(.+?)\2/.exec(l); if (m) rows.push({ kind: 'test', symbol: m[3].slice(0, 200), line_start: i + 1, line_end: i + 1, term: m[1] }); }
    if (lang === 'rs' && /^\s*#\[(?:tokio::)?test\b/.test(l)) {
      for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) { const f = /fn\s+(\w+)/.exec(lines[k]); if (f) { rows.push({ kind: 'test', symbol: f[1], line_start: i + 1, line_end: k + 1, term: 'rust-test' }); break; } }
    }
    if (lang === 'py') { const m = /^\s*def\s+(test_\w+)/.exec(l); if (m) rows.push({ kind: 'test', symbol: m[1], line_start: i + 1, line_end: i + 1, term: 'pytest' }); }
  });
  return rows;
}
