import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTarball } from '../helpers/extract-tarball.mjs';

describe('portable tar extraction', () => {
  it('passes a relative archive and extraction directory to tar', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-tar-test-'));
    const archive = path.join(root, 'candidate.tgz');
    const destination = path.join(root, 'out');
    fs.writeFileSync(archive, 'fixture');
    let invocation;
    try {
      extractTarball(archive, destination, (_command, args, options) => { invocation = { args, options }; });
      expect(invocation.options.cwd).toBe(path.resolve(destination));
      expect(invocation.args).toEqual(['-xzf', expect.stringMatching(/^\.ruvnet-tar-.*candidate\.tgz$/), '-C', '.']);
      expect(invocation.args.some((arg) => /^[A-Za-z]:[\\/]/.test(arg))).toBe(false);
      expect(fs.existsSync(path.join(destination, invocation.args[1]))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
