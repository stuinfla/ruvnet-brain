import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { livePublicationAdapter, validateCandidateSource } from '../../scripts/publication-receipt.mjs';
import { generatePublicVerificationLane } from '../../scripts/public-verification-lane.mjs';

const verifierRoot = fileURLToPath(new URL('../..', import.meta.url));
const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-candidate-'));
  roots.push(root);
  const candidateRoot = path.join(root, 'candidate');
  fs.mkdirSync(path.join(candidateRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(candidateRoot, 'scripts', 'published-surface-probe.mjs'),
    'throw new Error("the old candidate probe must never execute");\n');
  const git = (...args) => execFileSync('git', args, { cwd: candidateRoot, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Recovery Test', '-c', 'user.email=recovery@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'immutable candidate');
  return { root, candidateRoot, sha: git('rev-parse', 'HEAD'), version: '9.9.9', git };
}

// Execute the actual verifier subprocess with local network/npm substitutes installed before
// its imports. Unknown requests fail locally; this fixture cannot download or publish anything.
function nodePreloadOption(preload) {
  return `--require=${JSON.stringify(preload)}`;
}

function offlineProbe(f, { mutate = false } = {}) {
  const preload = path.join(f.root, 'offline-probe.cjs');
  const observed = path.join(f.root, 'observed.json');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const child = require('node:child_process');
    child.spawnSync = (name, args) => {
      if (!['npx', 'cmd.exe'].includes(require('node:path').win32.basename(name).toLowerCase())
        || !args.includes('ruvnet-brain@latest') || !args.includes('--help')) {
        throw new Error('unexpected external subprocess: ' + name);
      }
      return { status: 0, stdout: 'RuvNet Brain installer: npx ruvnet-brain', stderr: '' };
    };
    require('node:module').syncBuiltinESMExports();
    global.fetch = async (url, options = {}) => {
      if (url === 'https://registry.npmjs.org/ruvnet-brain') {
        return Response.json({ 'dist-tags': { latest: '9.9.9' }, versions: {
          '9.9.9': { dist: { tarball: 'https://fixture.invalid/package.tgz' } }
        } });
      }
      if (url === 'https://fixture.invalid/package.tgz') return new Response(new Uint8Array([31,139,0,0]));
      if (url === 'https://api.github.com/repos/stuinfla/ruvnet-brain/releases/latest') {
        fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
          script: process.argv[1], cwd: process.cwd(), authorization: options.headers.authorization
        }));
        if (${mutate}) fs.appendFileSync('scripts/published-surface-probe.mjs', '// changed during probe');
        return Response.json({ tag_name: 'v9.9.9', assets: [
          { name: 'ruvnet-brain.zip', size: 104857600, browser_download_url: 'https://fixture.invalid/bundle' },
          { name: 'ruvnet-brain.zip.sha256', browser_download_url: 'https://fixture.invalid/digest' }
        ] });
      }
      if (url === 'https://fixture.invalid/bundle') return new Response(null);
      if (url === 'https://fixture.invalid/digest') return new Response('a'.repeat(64));
      throw new Error('unexpected external request: ' + url);
    };
  `);
  vi.stubEnv('NODE_OPTIONS', nodePreloadOption(preload));
  vi.stubEnv('GITHUB_TOKEN', 'offline-fixture-token');
  return observed;
}

describe('recovery candidate source is independent of verifier source', () => {
  it('preserves Windows path separators through the real NODE_OPTIONS parser', () => {
    const preload = 'C:\\recovery verifier\\offline-probe.cjs';
    const result = spawnSync(process.execPath, ['-e', ''], {
      encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: nodePreloadOption(preload) },
    });
    // This nonexistent preload must fail with its exact path, before executing any code.
    // Unescaped backslashes inside NODE_OPTIONS quotes are consumed by Node's parser.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Cannot find module '${preload}'`);
  });

  it('requires the exact candidate SHA, checkout root, version, and unchanged tracked files', () => {
    const f = fixture();
    expect(validateCandidateSource(f.candidateRoot, f)).toBe(fs.realpathSync(f.candidateRoot));
    expect(() => validateCandidateSource(f.candidateRoot, { ...f, sha: '0'.repeat(40) })).toThrow(/candidate checkout/);
    expect(() => validateCandidateSource(path.join(f.candidateRoot, 'scripts'), f)).toThrow(/candidate checkout/);
    expect(() => validateCandidateSource(f.candidateRoot, { ...f, version: '9.9.8' })).toThrow(/package version/);
    fs.appendFileSync(path.join(f.candidateRoot, 'package.json'), '\n');
    expect(() => validateCandidateSource(f.candidateRoot, f)).toThrow(/tracked changes/);
    f.git('add', 'package.json');
    expect(() => validateCandidateSource(f.candidateRoot, f)).toThrow(/tracked changes/);
  });

  it('accepts filesystem aliases of the same root without accepting a different directory', () => {
    const f = fixture();
    const alias = path.join(path.dirname(f.candidateRoot), 'candidate-alias');
    fs.symlinkSync(f.candidateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(validateCandidateSource(alias, f)).toBe(fs.realpathSync(f.candidateRoot));
    const upperCaseRoot = f.candidateRoot.toUpperCase();
    if (fs.existsSync(upperCaseRoot)) {
      expect(validateCandidateSource(upperCaseRoot, f)).toBe(fs.realpathSync(upperCaseRoot));
    }
    expect(() => validateCandidateSource(path.join(f.candidateRoot, 'scripts'), f)).toThrow(/candidate checkout/);
  });

  it('rejects unavailable directory identity rather than guessing paths match', () => {
    const f = fixture();
    const original = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((file, options) => {
      const value = original(file, options);
      if (options?.bigint) return { ...value, ino: 0n, isDirectory: () => true };
      return value;
    });
    try { expect(() => validateCandidateSource(f.candidateRoot, f)).toThrow(/candidate checkout/); }
    finally { spy.mockRestore(); }
  });

  it('runs the new authenticated probe as a real child in the original candidate checkout', async () => {
    const f = fixture();
    const observed = offlineProbe(f);
    const adapter = livePublicationAdapter({ root: verifierRoot, candidateRoot: f.candidateRoot });
    await expect(adapter.probePublishedSurface(f)).resolves.toMatchObject({ conclusion: 'success', sha: f.sha });
    const result = JSON.parse(fs.readFileSync(observed, 'utf8'));
    expect(fs.realpathSync(result.script)).toBe(fs.realpathSync(path.join(verifierRoot, 'scripts/published-surface-probe.mjs')));
    expect(fs.realpathSync(result.cwd)).toBe(fs.realpathSync(f.candidateRoot));
    expect(result.authorization).toBe('Bearer offline-fixture-token');
    expect(validateCandidateSource(f.candidateRoot, f)).toBe(fs.realpathSync(f.candidateRoot));
  });

  it('rejects the wrong candidate before starting a probe', async () => {
    const f = fixture();
    const observed = offlineProbe(f);
    const adapter = livePublicationAdapter({ root: verifierRoot, candidateRoot: f.candidateRoot });
    await expect(adapter.probePublishedSurface({ ...f, sha: '0'.repeat(40) })).rejects.toThrow(/candidate checkout/);
    expect(fs.existsSync(observed)).toBe(false);
  });

  it('rejects tracked source changes made during the otherwise successful child probe', async () => {
    const f = fixture();
    const observed = offlineProbe(f, { mutate: true });
    const adapter = livePublicationAdapter({ root: verifierRoot, candidateRoot: f.candidateRoot });
    await expect(adapter.probePublishedSurface(f)).rejects.toThrow(/tracked changes/);
    expect(fs.existsSync(observed)).toBe(true);
  });

  it('rejects a wrong verifier before reading candidate artifacts or using an adapter', async () => {
    const osName = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
    await expect(generatePublicVerificationLane({ os: osName, root: verifierRoot,
      verifierSha: '0'.repeat(40), adapter: {} })).rejects.toThrow(/verifier SHA differs/);
  });

  it('recognizes direct Windows entrypoints with spaces and rejects importing callers', () => {
    for (const script of ['published-surface-probe.mjs', 'public-verification-finalizer.mjs']) {
      const source = fs.readFileSync(path.join(verifierRoot, 'scripts', script), 'utf8');
      const expression = source.match(/^const invokedDirectly = (.+);$/m)?.[1];
      expect(expression).toBeTruthy();
      const moduleUrl = `file:///C:/recovery%20verifier/scripts/${script}`;
      const entry = fileURLToPath(moduleUrl, { windows: true });
      const evaluate = (argv) => vm.runInNewContext(expression.replaceAll('import.meta.url', 'moduleUrl'), {
        moduleUrl, path: path.win32, process: { argv },
        fileURLToPath: (url) => fileURLToPath(url, { windows: true }),
      });
      expect(evaluate(['node', entry])).toBe(true);
      expect(evaluate(['node', 'C:\\recovery verifier\\caller.mjs'])).toBe(false);
      expect(evaluate(['node'])).toBeFalsy();
    }
  });

  it('executes the finalizer entrypoint and refuses unspecified artifacts without remote writes', () => {
    const result = spawnSync(process.execPath, [path.join(verifierRoot, 'scripts/public-verification-finalizer.mjs')],
      { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--identity, --aggregate, and --out are required');
  });
});
