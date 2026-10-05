// Optional conservative #373 projection. Uncertainty keeps the original raw bash gate.
// Keep executable strings and paths: mentioning a product in code still requires grounding.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function codeWithoutInertText(source, python = false) {
  if (/\r(?!\n)|[\u2028\u2029]/.test(source)) throw new Error('Unsupported line boundary');
  // Template interpolation and Python f-string expressions need a parser, not a guessed lexer.
  if ((!python && source.includes('`')) || (python && /(?:^|[^\w])(?:fr|rf|f)["']/i.test(source))) throw new Error('Interpolation requires original scan');
  if (python) {
    // A different source decoder can turn apparent comments into executable statements.
    for (const line of source.split(/\r?\n/).slice(0, 2)) {
      const cookie = line.match(/^[ \t\f]*#.*?coding[=:][ \t]*([^ \t\r\n]+)/i);
      if (cookie && !/^utf[-_]?8$/i.test(cookie[1])) throw new Error('Unsupported source encoding');
    }
    if (/\\\r?\n/.test(source)) throw new Error('Continuation requires original scan');
  }
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
      // Exempt only a leading module docstring before any executable text. Standalone-looking
      // literals inside functions, open expressions or control flow retain the original scan.
      const before = source.slice(source.lastIndexOf('\n', start - 1) + 1, start);
      const endOfLine = source.indexOf('\n', i); const after = source.slice(i, endOfLine < 0 ? source.length : endOfLine);
      const inert = triple && out.trim() === '' && !/\b(?:exec|eval|compile|__doc__)\b/.test(source) && /^[ \t]*$/.test(before) && /^[ \t\r]*(?:#.*)?$/.test(after);
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
  // Partial edits have no enclosing lexical context. Only complete Write or a verified
  // single Add File patch may receive an exemption; never reconstruct user files here.
  const tool = event.tool_name ?? event.toolName;
  let code;
  if (tool === 'Write' && typeof input.content === 'string' && !Object.hasOwn(input, 'edits')) {
    code = input.content;
  } else if (tool === 'Edit' && typeof input.new_string === 'string' && input.new_string.startsWith('*** Begin Patch')) {
    const lines = input.new_string.trimEnd().split(/\r?\n/);
    if (lines[0] !== '*** Begin Patch' || lines[1] !== `*** Add File: ${file}`
      || lines.at(-1) !== '*** End Patch' || !lines.slice(2, -1).every((line) => line.startsWith('+'))) {
      throw new Error('Ambiguous patch');
    }
    code = lines.slice(2, -1).map((line) => line.slice(1)).join('\n');
  } else throw new Error('Partial or unknown write context');
  const projectedCode = codeWithoutInertText(code, file.endsWith('.py'));
  // Never exempt a product-owned path. Preserve managed-store paths even without a product name.
  const projection = `${file}\n${projectedCode}`;
  if (/\.swarm[\/\\](?:agentdb-)?memory\.db/i.test(projection)) throw new Error('Managed memory needs original scan');
  return projection;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(projectGroundingInput(fs.readFileSync(0, 'utf8'))); }
  catch { process.exitCode = 1; } // A failed exemption leaves the original guard in force.
}
