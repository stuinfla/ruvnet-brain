// Optional conservative #373 projection. Uncertainty keeps the original raw bash gate.
// Keep executable strings and paths: mentioning a product in code still requires grounding.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function codeWithoutInertText(source, python = false) {
  // Template interpolation and Python f-string expressions need a parser, not a guessed lexer.
  if ((!python && source.includes('`')) || (python && /(?:^|[^\w])(?:fr|rf|f)["']/i.test(source))) throw new Error('Interpolation requires original scan');
  let out = ''; let i = 0;
  while (i < source.length) {
    const c = source[i]; const pair = source.slice(i, i + 2);
    if ((python && c === '#') || (!python && pair === '//')) {
      const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue;
    }
    if (!python && pair === '/*') {
      const end = source.indexOf('*/', i + 2); if (end < 0) throw new Error('Incomplete comment');
      out += ' '; i = end + 2; continue;
    }
    if (c === '"' || c === "'" || (!python && c === '`')) {
      const start = i; const triple = python && source.slice(i, i + 3) === c.repeat(3);
      const delimiter = triple ? c.repeat(3) : c;
      i += delimiter.length;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source.slice(i, i + delimiter.length) === delimiter) { i += delimiter.length; closed = true; break; }
        if (!triple && c !== '`' && /[\r\n]/.test(source[i])) throw new Error('Incomplete string');
        i++;
      }
      if (!closed) throw new Error('Incomplete string');
      // Plain standalone Python string statements are inert, including module/function docs.
      // Prefixes (especially f-strings), assignments, call arguments and inline suites stay intact.
      const before = source.slice(source.lastIndexOf('\n', start - 1) + 1, start);
      const endOfLine = source.indexOf('\n', i); const after = source.slice(i, endOfLine < 0 ? source.length : endOfLine);
      const inert = triple && !/\b(?:exec|eval|compile|__doc__)\b/.test(source) && /^[ \t]*$/.test(before) && /^[ \t\r]*(?:#.*)?$/.test(after);
      out += inert ? ' ' : source.slice(start, i); continue;
    }
    // Regex literals, heredocs, language-specific nested comments etc. are not guessed.
    if (!python && c === '/') throw new Error('Ambiguous slash');
    if (!python && pair === '<' + '<') throw new Error('Unsupported heredoc');
    out += c; i++;
  }
  return out;
}

export function projectGroundingInput(raw) {
  const event = JSON.parse(raw); const input = event.tool_input ?? event.toolInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unknown write input');
  const file = input.file_path; if (typeof file !== 'string') throw new Error('Unknown path');
  // Limited lexical scope; other languages retain their existing strict gate.
  if (!/\.(?:py|[cm]?js|jsx|ts|tsx)$/.test(file)) throw new Error('Unsupported language');
  const fragments = [];
  for (const part of Array.isArray(input.edits) ? input.edits : [input]) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Unknown edit');
    const values = ['content', 'old_string', 'new_string'].filter((key) => Object.hasOwn(part, key));
    if (!values.length || values.some((key) => typeof part[key] !== 'string')) throw new Error('Unknown code field');
    for (const key of values) {
      let code = part[key];
      // Existing Codex adapter supplies the complete raw patch as new_string. Exempt only a
      // single complete Add File, never guess Update hunks or drop other files from a patch.
      if (code.startsWith('*** Begin Patch')) {
        const lines = code.trimEnd().split(/\r?\n/);
        if (lines[0] !== '*** Begin Patch' || lines[1] !== `*** Add File: ${file}`
          || lines.at(-1) !== '*** End Patch' || !lines.slice(2, -1).every((line) => line.startsWith('+'))) {
          throw new Error('Ambiguous patch');
        }
        code = lines.slice(2, -1).map((line) => line.slice(1)).join('\n');
      }
      fragments.push(codeWithoutInertText(code, file.endsWith('.py')));
    }
  }
  if (!fragments.length) throw new Error('No code fragments');
  // Never exempt a product-owned path. Preserve managed-store paths even without a product name.
  const projection = `${file}\n${fragments.join('\n')}`;
  if (/\.swarm[\/\\](?:agentdb-)?memory\.db/i.test(projection)) throw new Error('Managed memory needs original scan');
  return projection;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(projectGroundingInput(fs.readFileSync(0, 'utf8'))); }
  catch { process.exitCode = 1; } // A failed exemption leaves the original guard in force.
}
