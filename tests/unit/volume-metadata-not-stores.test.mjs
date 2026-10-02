// volume-metadata-not-stores.test.mjs — a Brain that lived on exFAT/FAT/NTFS carries macOS volume metadata:
// an AppleDouble `._<name>` beside every file (so `._ruvector.rvf`, `._ruvector.passages.jsonl`,
// `._ruvector.meta.json` …) and `.DS_Store`. Every enumerator that finds stores by file suffix read those
// as a second store called `._ruvector` (final Opus re-review of a0074096, 2026-10-01). None of them may.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverRepos } from '../../kb/forge-ask-all.mjs';
import { discoverStoreFamilies } from '../../kb/brain-profile.mjs';
import { storesAt } from '../../kb/store-root.mjs';
import { identifierScan } from '../../kb/identifier-lane.mjs';
import { requiredEmbedderModels } from '../../kb/model-requirements.mjs';
import { reclaimBackups } from '../../kb/forge-update.mjs';
import { health } from '../../plugin/scripts/session-start-health.mjs';
import { loadVocabulary } from '../../plugin/scripts/grounding-turn-evidence.mjs';

const temps = [];
const temp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volmeta-'))); temps.push(d); return d; };
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

const APPLEDOUBLE = Buffer.concat([Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]), Buffer.alloc(4088, 0)]); // a real ._ file's magic

/** A KB directory as it looks after a round trip through exFAT: each file has its ._ twin, plus .DS_Store. */
function exfatTouchedKb(files) {
  const dir = temp();
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
    fs.writeFileSync(path.join(dir, `._${name}`), APPLEDOUBLE);
  }
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'ds');
  return dir;
}

describe('volume metadata is never a store', () => {
  const kb = () => exfatTouchedKb({
    'ruvector.rvf': 'x', 'ruvector.big.rvf': 'x', 'ruvector.big.rvf.embed.json': JSON.stringify({ model: 'Xenova/bge-base-en-v1.5' }),
    'ruvector.passages.jsonl': `${JSON.stringify({ path: 'src/a.ts', text: 'export function getFooBarBaz() {}' })}\n`,
    'ruvector-core.meta.json': '{}', 'ruvector-core.rvf': 'x',
  });

  it('reader discovery (discoverRepos), brain profiles (discoverStoreFamilies) and the store root (storesAt)', () => {
    const dir = kb();
    expect(discoverRepos(dir)).toEqual(['ruvector', 'ruvector-core']);
    expect(discoverStoreFamilies(dir)).toEqual(['ruvector', 'ruvector-core']);
    expect(storesAt(dir)).toEqual(['ruvector', 'ruvector-core']);
  });

  it('the identifier lane scans only real passage sidecars', () => {
    const dir = kb();
    fs.writeFileSync(path.join(dir, '._ruvector.passages.jsonl'), `${JSON.stringify({ path: 'x', text: 'getFooBarBaz' })}\n`);
    expect(identifierScan(dir, ['getfoobarbaz']).repos).toEqual(['ruvector']);
  });

  it('the embedder requirement reads only real .rvf.embed.json sidecars', () => {
    const dir = kb();
    fs.writeFileSync(path.join(dir, '._ruvector.big.rvf.embed.json'), JSON.stringify({ model: 'Evil/fake-model' }));
    expect(requiredEmbedderModels(dir)).toEqual(['Xenova/bge-base-en-v1.5']);
  });

  it('a rollback copy whose only "extra store" is a ._ file is not kept as holding a unique store', () => {
    const root = temp();
    const live = path.join(root, 'kb'); fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, 'a.rvf'), Buffer.alloc(2048, 1));
    const bak = path.join(root, 'kb.bak-2026-07-01'); fs.mkdirSync(bak);
    fs.writeFileSync(path.join(bak, 'a.rvf'), Buffer.alloc(2048, 1));
    fs.writeFileSync(path.join(bak, '._a.rvf'), APPLEDOUBLE);
    const { removed, kept } = reclaimBackups({ kbDir: live, backupsMade: [bak], env: {} });
    expect(kept).toEqual([]);
    expect(removed).toEqual([bak]);
  });

  it('SessionStart health: a KB holding only ._*.rvf files has NO vector stores', () => {
    const home = temp();
    const dir = path.join(home, '.cache', 'ruvnet-brain', 'kb');
    fs.mkdirSync(path.join(dir, 'node_modules', '@xenova', 'transformers'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, '._ruvector.rvf'), APPLEDOUBLE);
    expect(health(home, false).problem).toMatch(/^NO vector stores \(\.rvf\) found in /);
  });

  it('the grounding vocabulary never learns "._ruvector-core" as a product name', () => {
    const dir = kb();
    const vocabulary = loadVocabulary({ env: { RUVNET_KB_DIR: dir, RUVNET_BRAIN_HOME: temp() } });
    expect(vocabulary).toContain('ruvector-core');
    expect(vocabulary.filter((v) => v.startsWith('._'))).toEqual([]);
  });
});
