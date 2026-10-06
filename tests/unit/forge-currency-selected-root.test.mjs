// Explicit foreign store roots never import aliases from the source checkout.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainKnownSet } from '../../kb/forge-currency.mjs';

let dir;
afterEach(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); dir = null; } });
const sandbox = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-currency-')));

describe('selected KB root SOURCE isolation', () => {
  it('uses array SOURCE aliases from the explicit root without leaking checkout aliases', () => {
    const root = sandbox();
    fs.writeFileSync(path.join(root, 'foreign-store.rvf'), '');
    fs.writeFileSync(path.join(root, 'SOURCE.json'), JSON.stringify({ stores: [
      { kbName: 'Foreign-Alias', sourceRepo: 'ruvnet/Foreign-Repository.git' },
    ] }));
    expect([...brainKnownSet(root)].sort()).toEqual(['foreign-alias', 'foreign-repository', 'foreign-store']);
  });

  it('uses object SOURCE aliases and preserves RVF names when SOURCE is malformed or missing', () => {
    const root = sandbox();
    fs.writeFileSync(path.join(root, 'root-only.big.rvf'), '');
    const source = path.join(root, 'SOURCE.json');
    fs.writeFileSync(source, JSON.stringify({ stores: { one: { kbName: 'Object-Alias' } } }));
    expect([...brainKnownSet(root)].sort()).toEqual(['object-alias', 'root-only']);
    fs.writeFileSync(source, '{broken');
    expect([...brainKnownSet(root)]).toEqual(['root-only']);
    fs.unlinkSync(source);
    expect([...brainKnownSet(root)]).toEqual(['root-only']);
  });

});
