// ADR-0102 G-004 (#236) — the structural citation binding is proven by breaking it. Each mutant takes the
// REAL kb/verify-citation.mjs, applies ONE named mutation, and the forged "+1 header" fixture that verifies
// as ruvector on the real file must be hijacked (or lose the genuine hit) on the mutant.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { forgedKb, forgedReaderOutput } from '../helpers/forged-citation-fixture.mjs';

const REAL = path.resolve(import.meta.dirname, '..', '..', 'kb', 'verify-citation.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-mutant-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
async function load(find, replace) {
  const src = fs.readFileSync(REAL, 'utf8');
  if (find && !src.includes(find)) throw new Error(`mutation anchor not found: ${find}`);
  const file = path.join(dir, `verify-citation-${n += 1}.mjs`);
  fs.writeFileSync(file, find ? src.replace(find, replace) : src);
  return import(pathToFileURL(file).href);
}

async function verdict(m) {
  const kb = forgedKb(fs.mkdtempSync(path.join(dir, 'kb-')));
  const v = await m.verifyGrounding(forgedReaderOutput(), kb);
  return { repos: v.citations.map((c) => c.repo), receipt: v.receipt?.repo };
}

describe('G-004 citation binding', () => {
  it('real: verifies as ruvector, EVIL nowhere', async () => {
    expect(await verdict(await load())).toEqual({ repos: ['ruflo', 'ruvector'], receipt: 'ruvector' });
  });
  it('mutant — the body is not skipped by its declared length: the forged header is read as #2', async () => {
    const r = await verdict(await load('headerRe.lastIndex = bodyEnd + terminator;', ''));
    expect(r.repos).toContain('EVIL');
  });
  it('mutant — the declared length is not checked against the terminator: the genuine #2 is lost or EVIL wins', async () => {
    const r = await verdict(await load('const bodyEnd = bodyStart + Number(charsM[1]);', 'const bodyEnd = bodyStart + 40;'));
    expect(r).not.toEqual({ repos: ['ruflo', 'ruvector'], receipt: 'ruvector' });
  });
});
