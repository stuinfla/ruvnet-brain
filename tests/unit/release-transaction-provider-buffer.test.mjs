import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const nativeCommand = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({ ...(await original()), execFileSync: nativeCommand }));
const provider = await import('../../scripts/release-transaction-provider.mjs');

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'release-transaction-provider.mjs'), 'utf8');

// Regression for 2026-09-27: finalize-public-verification failed with
// `public-verification-finalizer: spawnSync gh ENOBUFS` while finalizing v4.3.30. Root cause: the
// shared `command()` helper (which `refresh()` uses to slurp EVERY release's paginated metadata)
// never overrode execFileSync's 1MB default maxBuffer, and the repo's accumulated release history
// (several releases now carrying 14-15 chained transaction receipts as assets each) finally crossed
// it — the same failure shape as the documented #77 bundle-download ENOBUFS, at a different call
// site the original fix never covered.
describe('release-transaction-provider: gh metadata calls have real buffer margin over the 1MB default', () => {
  it('the shared command() helper passes an explicit maxBuffer well above the 1MB default', () => {
    const m = SOURCE.match(/const command = \(name, args, options = \{\}\) => execFileSync\(name, args, \{[^}]*maxBuffer:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
    expect(m, "command() must pass an explicit maxBuffer, not inherit execFileSync's 1MB default").not.toBeNull();
    const maxBufferMb = Number(m[1]);
    expect(maxBufferMb).toBeGreaterThan(1);
  });

  it("refresh()'s paginated releases listing is routed through the buffered command() helper, not a bare execFileSync", () => {
    expect(SOURCE).toMatch(/const refresh = \(\) => \{\s*const pages = json\('gh', \['api', `repos\/\$\{REPO\}\/releases\?per_page=100`, '--paginate', '--slurp'\]\)/);
  });
});

describe('release payload upload budgets', () => {
  let directory;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-upload-budget-'));
    nativeCommand.mockImplementation((name, args, options) => {
      if (name === 'gh' && args[0] === 'api') {
        return args[1].includes('/assets?') ? '[]' : '{"id":1,"tag_name":"v-test"}';
      }
      if (name === 'gh' && args[0] === 'release' && args[1] === 'upload') {
        // Emulate the observed transfer outlasting metadata's 30s deadline, without network/sleep.
        if (path.basename(args[3]) === 'ruvnet-brain.zip' && options.timeout < 120_000) {
          throw Object.assign(new Error('upload exceeded metadata timeout'), { code: 'ETIMEDOUT' });
        }
        return '';
      }
      throw new Error('Unexpected external command in upload acceptance');
    });
  });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); nativeCommand.mockReset(); });

  it('executes the actual payload path with a bounded large-file budget while metadata and sidecars stay at 30s', async () => {
    const names = ['ruvnet-brain.zip', 'ruvnet-brain.zip.sig', 'ruvnet-brain.zip.sha256', 'ruvnet-brain-test.tgz'];
    const files = names.map(name => path.join(directory, name));
    files.forEach(file => fs.writeFileSync(file, 'sealed-bytes'));
    fs.truncateSync(files[0], 682_688_538); // Sparse file: the actual failed 4.5.12 asset size.
    await provider.liveReleaseProvider().uploadAssets({ id: 1, tag: 'v-test' }, {
      bundlePath: files[0], bundleSignaturePath: files[1], bundleDigestPath: files[2], packagePath: files[3],
    });
    const uploads = nativeCommand.mock.calls.filter(([, args]) => args[0] === 'release');
    expect(uploads).toHaveLength(4);
    expect(uploads[0][2].timeout).toBe(600_000);
    expect(uploads.slice(1).map(([, , options]) => options.timeout)).toEqual([30_000, 30_000, 30_000]);
    expect(nativeCommand.mock.calls.filter(([, args]) => args[0] === 'api').every(([, , options]) => options.timeout === 30_000)).toBe(true);
    expect(uploads[0][1]).toEqual(['release', 'upload', 'v-test', files[0], '--repo', 'stuinfla/ruvnet-brain']);
  });

  it('sizes each deadline within fixed bounds and refuses unsafe byte counts', () => {
    expect(provider.assetUploadTimeoutMs(0)).toBe(30_000);
    expect(provider.assetUploadTimeoutMs(64 * 1024 * 1024)).toBe(64_000);
    expect(provider.assetUploadTimeoutMs(682_688_538)).toBe(600_000);
    expect(provider.assetUploadTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(600_000);
    for (const bytes of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => provider.assetUploadTimeoutMs(bytes)).toThrow();
    }
    expect(provider.ASSET_DOWNLOAD_TIMEOUT_MS).toBe(600_000);
  });
});
