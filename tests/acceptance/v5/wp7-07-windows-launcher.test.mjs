// WP7-07 the Windows launcher (bin/rb5.cmd), checked by reading it. cmd.exe cannot run on the Mac this
// was built on, so this is the one acceptance test that reads product source as text (ROADMAP A0.4
// otherwise forbids that); a Windows run of wp7-01 to wp7-04 is still owed. It parses every command
// position of the script (start of a line, after & && || | ( and after the condition of an `if` or the
// `do` of a `for`) and requires each to be a cmd built-in, a call to one of the script's own labels,
// or a program named by a quoted variable that holds a full path. It forbids changing folder, and it
// requires the script to switch off cmd.exe's search of the current folder and to locate itself by %~dp0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const BUILTIN = new Set(['echo', 'echo.', 'set', 'setlocal', 'endlocal', 'call', 'exit', 'goto', 'rem', 'shift', 'else']);
const IF_COND = /^if\s+(?:(?:not|\/i)\s+){0,2}(?:exist\s+(?:"[^"]*"|\S+)|defined\s+\S+|errorlevel\s+\d+|(?:"[^"]*"|[^\s=]+)\s*(?:==|\s(?:equ|neq|lss|leq|gtr|geq)\s)\s*(?:"[^"]*"|\S+))\s*/i;

/** Splits a line at unquoted & && || | ( ) into command segments. */
function segments(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    const redirect = c === '&' && '<>'.includes(line[i - 1]);
    if (!quoted && !redirect && '&|()'.includes(c)) {
      out.push(cur);
      cur = '';
      if ((c === '&' || c === '|') && line[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Every command word in the script, with its line number. */
function commandWords(text) {
  const words = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    let line = raw.trim().replace(/^@/, '');
    if (!line || /^(rem\b|::|:[A-Za-z])/i.test(line)) return;
    // A for loop's set (inside its parentheses) is data; its command is what follows ` do `.
    if (/^for\b/i.test(line)) line = /\sdo\s+(.*)$/i.exec(line)?.[1] ?? '';
    for (let seg of segments(line)) {
      seg = seg.replace(/^@/, '');
      while (IF_COND.test(seg)) seg = seg.replace(IF_COND, '');
      const w = /^("[^"]*"|[^\s>]+)/.exec(seg)?.[1];
      if (w) words.push({ word: w, line: n + 1, text: raw.trim() });
    }
  });
  return words;
}

test('WP7-07 the Windows launcher starts programs only by full path and never searches the current folder', async (t) => {
  const ctx = setup(t, 'wp7-07');
  const tree = ctx.tree();
  const text = fs.readFileSync(path.join(tree.plugin, 'bin', 'rb5.cmd'), 'utf8');
  const words = commandWords(text);
  assert.ok(words.length > 20, `the parser found the script's commands (${words.length})`);
  const bad = words.filter(({ word }) => {
    if (word.startsWith('"')) return !/^"(%~\d|%RB5_[A-Z0-9_]+%)/.test(word);
    return !BUILTIN.has(word.toLowerCase());
  });
  assert.deepEqual(bad.map((b) => `line ${b.line}: ${b.text}`), [], 'every command word must be a cmd built-in or a quoted full-path variable');
  const calls = words.filter((w) => w.word.toLowerCase() === 'call').map((w) => /call\s+(\S+)/i.exec(w.text.replace(/^.*?\bcall\b/i, 'call'))?.[1]);
  assert.ok(calls.every((c) => c?.startsWith(':') || c?.toLowerCase() === 'set'), `call is used only for the script's own labels (or call set): ${calls}`);
  assert.doesNotMatch(text, /^\s*@?(cd|chdir|pushd|popd)\b|[&|(]\s*(cd|chdir|pushd|popd)\b/im, 'the script never changes folder');
  assert.match(text, /set\s+"NoDefaultCurrentDirectoryInExePath=1"/i, 'the current-folder search is switched off');
  assert.match(text, /%~dp0/, 'the script finds its own folder by %~dp0');
  assert.doesNotMatch(text, /%CD%\\[^%\s"]*node/i, 'no program path is built from the current folder');
  // The launcher must carry the same DOWN line the hook command's fallback prints.
  const hook = JSON.parse(fs.readFileSync(path.join(tree.plugin, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  const down = /echo "(\[RuvNet Brain\] DOWN:[^"]*)"/.exec(hook)[1];
  assert.ok(text.includes(down), 'the Windows launcher prints the same DOWN line as the hook fallback');
});
