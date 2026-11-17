// A strict reader for the YAML subset the v5 workflow files are written in (block mappings and
// sequences, plain and quoted scalars, `[a, b]`, `{}`, `|` literal blocks, comments). Anything
// outside that subset (anchors, folded blocks, flow mappings, tabs, duplicate keys) throws, so a
// workflow cannot hide a key from the wp6 workflow test by using a form this reader skips. Node has
// no YAML parser and the v5 suite adds no dependency; actionlint and PyYAML were used by hand to
// confirm this reader agrees with a full parser on the committed files.
const KEY = /^([A-Za-z0-9_.-]+|'[^']*'|"[^"]*"):(?:\s+(.*))?$/;

function stripComment(s) {
  let q = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k);
  }
  return s;
}

function scalar(raw, where) {
  const s = raw.trim();
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`${where}: unterminated quote`);
    return s.slice(1, -1).replaceAll("''", "'");
  }
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`${where}: unsupported flow sequence`);
    const body = s.slice(1, -1).trim();
    return body ? body.split(',').map((x) => scalar(x, where)) : [];
  }
  if (s === '{}') return {};
  if (/^[{&*!|>%@`]/.test(s)) throw new Error(`${where}: unsupported YAML form ${s.slice(0, 20)}`);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(text, name = 'yaml') {
  if (text.includes('\t')) throw new Error(`${name}: tab characters are not allowed`);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const ind = (l) => l.length - l.trimStart().length;
  const sig = (l) => l.trim() !== '' && !l.trim().startsWith('#');
  const skip = () => {
    while (i < lines.length && !sig(lines[i])) i++;
  };
  const at = () => `${name}:${i + 1}`;

  function literal(indent, mode) {
    const body = [];
    let bi = null;
    while (i < lines.length && (lines[i].trim() === '' || ind(lines[i]) > indent)) {
      if (lines[i].trim() !== '' && bi === null) bi = ind(lines[i]);
      body.push(lines[i]);
      i++;
    }
    while (body.length && body.at(-1).trim() === '') body.pop();
    const text = body.map((l) => l.slice(bi ?? 0)).join('\n');
    return mode === '|-' ? text : `${text}\n`;
  }

  function map(indent) {
    const out = {};
    for (;;) {
      skip();
      if (i >= lines.length || ind(lines[i]) < indent) return out;
      if (ind(lines[i]) > indent) throw new Error(`${at()}: unexpected indentation`);
      const t = lines[i].slice(indent);
      if (t.startsWith('- ') || t === '-') return out;
      const m = KEY.exec(stripComment(t).trimEnd());
      if (!m) throw new Error(`${at()}: not a key: value line: ${t.slice(0, 60)}`);
      const key = /^['"]/.test(m[1]) ? scalar(m[1], at()) : m[1];
      if (Object.hasOwn(out, key)) throw new Error(`${at()}: duplicate key ${key}`);
      const rest = (m[2] ?? '').trim();
      i++;
      if (rest === '|' || rest === '|-') out[key] = literal(indent, rest);
      else if (rest !== '') out[key] = scalar(rest, at());
      else {
        skip();
        out[key] = i < lines.length && ind(lines[i]) > indent ? block(ind(lines[i])) : null;
      }
    }
  }

  function seq(indent) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length || ind(lines[i]) < indent) return out;
      if (ind(lines[i]) > indent) throw new Error(`${at()}: unexpected indentation`);
      const t = lines[i].slice(indent);
      if (!t.startsWith('- ')) return out;
      const body = t.slice(2);
      if (KEY.test(stripComment(body).trimEnd())) {
        lines[i] = ' '.repeat(indent + 2) + body;
        out.push(map(indent + 2));
      } else {
        i++;
        out.push(scalar(stripComment(body), at()));
      }
    }
  }

  function block(indent) {
    skip();
    const t = lines[i].slice(indent);
    return t.startsWith('- ') ? seq(indent) : map(indent);
  }

  skip();
  const doc = block(0);
  skip();
  if (i < lines.length) throw new Error(`${at()}: content after the document`);
  return doc;
}
