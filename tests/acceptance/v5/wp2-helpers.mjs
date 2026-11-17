// Shared pieces of the work package 2 (server) acceptance tests. Everything goes through the real
// builder, release, installer and the real server over its stdio protocol (helpers.mjs).
import fs from 'node:fs';
import path from 'node:path';

/** A fixture repository written at test time: { 'path/in/repo': 'text' }. */
export function writeRepo(dir, name, files, { commit = 'c0ffee000001', date = '2026-11-14' } = {}) {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.source.json'), JSON.stringify({ repo: name, commit, date }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** A made-up word per index that no other fixture contains and the analyser keeps whole. */
export const word = (i) => `vexil${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}ond`;

/** Turns a built pack into a private pack for `projects` and puts it in the home's private/ folder. */
export function installPrivate(home, packDir, name, projects) {
  const dest = path.join(home, 'private', name);
  fs.cpSync(packDir, dest, { recursive: true });
  const file = path.join(dest, 'PACK.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...pack, access: 'private', projects }, null, 2));
  return dest;
}

/** The fence markers of one delivered text. */
export const markers = (text) => [...text.matchAll(/^<<<passage-(\S+)$/gm)].map((m) => m[1]);

/** The text of a result with its fence marker replaced, for comparing two answers. */
export const unfenced = (text) => {
  let out = text;
  for (const m of new Set(markers(text))) out = out.replaceAll(m, 'MARKER');
  return out;
};

/** The cited files of one section (FILES, HISTORY, CUES ...), in order, and the section's raw block. */
export function section(text, name) {
  const out = { files: [], block: '', header: null };
  let cur = null;
  for (const line of text.split('\n')) {
    const h = /^(CAPABILITIES|CUES|FILES|HISTORY|PLAYBOOKS) \(\d+\)/.exec(line);
    if (h) cur = h[1];
    else if (/^NOTE · ranked/.test(line)) cur = null;
    if (cur !== name) continue;
    if (h) out.header = line;
    out.block += `${line}\n`;
    const m = /^\d+\. (\S+) · lines/.exec(line);
    if (m) out.files.push(m[1]);
  }
  return out;
}
