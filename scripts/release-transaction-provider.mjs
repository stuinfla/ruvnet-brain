import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECEIPT_PREFIX, TERMINAL_STATES } from './release-transaction.mjs';

const REPO = 'stuinfla/ruvnet-brain';
const PACKAGE = 'ruvnet-brain';

const command = (name, args, options = {}) => execFileSync(name, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
}).trim();
const json = (name, args, options) => JSON.parse(command(name, args, options));
const maybe = (callback, fallback = null) => {
  try { return callback(); } catch { return fallback; }
};

const tagSha = (tag, root) => {
  const rows = command('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root })
    .split('\n').filter(Boolean).map((line) => line.split(/\s+/));
  return rows.find(([, ref]) => ref?.endsWith('^{}'))?.[0] || rows[0]?.[0] || '';
};

const assetBytes = (asset) => {
  const result = spawnSync('gh', ['api', asset.url, '-H', 'Accept: application/octet-stream'], {
    encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error(`cannot download transaction asset ${asset.name}`);
  return Buffer.from(result.stdout);
};
const assetReceipt = (asset) => JSON.parse(assetBytes(asset).toString('utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function liveReleaseProvider({
  root = process.cwd(), candidateReceipt = null, publicationReceipt = null,
} = {}) {
  let releases = [];
  let activeDraft = null;
  const refresh = () => {
    releases = json('gh', ['api', `repos/${REPO}/releases?per_page=100`]);
    return releases;
  };
  const releaseById = (id) => json('gh', ['api', `repos/${REPO}/releases/${id}`]);
  const receiptsFor = (release) => (release?.assets || [])
    .filter(({ name }) => name.startsWith(RECEIPT_PREFIX) && name.endsWith('.json'))
    .map(assetReceipt);
  const materializeRemoteAssets = (draft, identity) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-release-staged-'));
    try {
      const release = releaseById(draft.id);
      const required = [
        ['bundlePath', 'ruvnet-brain.zip'],
        ['bundleSignaturePath', 'ruvnet-brain.zip.sig'],
        ['bundleDigestPath', 'ruvnet-brain.zip.sha256'],
      ];
      const assets = {};
      for (const [key, name] of required) {
        const remote = release.assets?.find((asset) => asset.name === name);
        if (!remote) throw new Error(`staged GitHub asset missing: ${name}`);
        const file = path.join(temp, name);
        fs.writeFileSync(file, assetBytes(remote), { flag: 'wx', mode: 0o600 });
        assets[key] = file;
      }
      if (sha256(fs.readFileSync(assets.bundlePath)) !== identity.bundleSha256) {
        throw new Error('staged GitHub bundle digest does not match transaction identity');
      }
      const packed = json('npm', [
        'pack', `${PACKAGE}@candidate-v${identity.version}`, '--json', '--pack-destination', temp,
      ]);
      if (!Array.isArray(packed) || packed.length !== 1 || !packed[0].filename) {
        throw new Error('npm candidate pack did not return exactly one artifact');
      }
      assets.packagePath = path.join(temp, packed[0].filename);
      const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(assets.packagePath)).digest('base64')}`;
      if (integrity !== identity.packageIntegrity) throw new Error('staged npm package integrity mismatch');
      return { assets, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
    } catch (error) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  };

  return {
    async discover(identity) {
      const all = refresh();
      const matchingDrafts = all.filter((release) => release.tag_name === identity.tag
        && release.target_commitish === identity.candidateSha).map((release) => ({
        id: release.id, tag: release.tag_name, sha: release.target_commitish, draft: release.draft,
      }));
      activeDraft = matchingDrafts[0] || null;
      const receipts = matchingDrafts.length === 1 ? receiptsFor(releaseById(matchingDrafts[0].id)) : [];
      const latestByTransaction = new Map();
      for (const receipt of all.flatMap((release) => receiptsFor(release))) {
        const prior = latestByTransaction.get(receipt.transactionId);
        if (!prior || receipt.sequence > prior.sequence) latestByTransaction.set(receipt.transactionId, receipt);
      }
      const pending = [...latestByTransaction.values()]
        .filter((receipt) => !TERMINAL_STATES.has(receipt.state));
      const npmLatest = maybe(() => command('npm', ['view', `${PACKAGE}@latest`, 'version']), null);
      const githubLatest = maybe(() => json('gh', ['api', `repos/${REPO}/releases/latest`]).tag_name, null);
      return { matchingDrafts, receipts, pending, prior: { npmLatest, githubLatest } };
    },

    async createDraft(identity) {
      const release = json('gh', [
        'api', '-X', 'POST', `repos/${REPO}/releases`,
        '-f', `tag_name=${identity.tag}`, '-f', `target_commitish=${identity.candidateSha}`,
        '-f', `name=${identity.tag} staged candidate`, '-F', 'draft=true', '-F', 'prerelease=false',
      ]);
      activeDraft = { id: release.id, tag: release.tag_name, sha: release.target_commitish };
      return activeDraft;
    },

    async appendReceipt(draft, receipt, name) {
      const anchor = draft || activeDraft;
      if (!anchor) throw new Error('no draft anchor for transaction receipt');
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-release-receipt-'));
      const file = path.join(temp, name);
      try {
        fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        command('gh', ['release', 'upload', anchor.tag, file, '--repo', REPO]);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },

    async readReceipt(draft, sequence) {
      const name = `${RECEIPT_PREFIX}${String(sequence).padStart(4, '0')}.json`;
      const release = releaseById((draft || activeDraft).id);
      const asset = release.assets?.find((item) => item.name === name);
      if (!asset) throw new Error(`remote receipt ${name} is missing after upload`);
      return assetReceipt(asset);
    },

    async uploadAssets(draft, assets) {
      const paths = [assets.bundlePath, assets.bundleSignaturePath, assets.bundleDigestPath, assets.packagePath];
      for (const file of paths) {
        const release = releaseById(draft.id);
        const existing = release.assets?.find(({ name }) => name === path.basename(file));
        if (existing) {
          if (sha256(assetBytes(existing)) !== sha256(fs.readFileSync(file))) {
            throw new Error(`refusing to replace staged asset with different bytes: ${existing.name}`);
          }
          continue;
        }
        command('gh', ['release', 'upload', draft.tag, file, '--repo', REPO]);
      }
    },

    async materializeStagedAssets(draft, identity) {
      return materializeRemoteAssets(draft, identity);
    },

    async stageNpm(identity, packagePath) {
      const existing = maybe(() => command('npm', ['view', `${PACKAGE}@${identity.version}`, 'dist.integrity']), null);
      if (existing) return;
      command('npm', ['publish', packagePath, '--tag', `candidate-v${identity.version}`]);
    },

    async observeNpmCandidate(identity) {
      const metadata = json('npm', ['view', `${PACKAGE}@candidate-v${identity.version}`, '--json']);
      return { version: metadata.version, integrity: metadata.dist?.integrity, tag: `candidate-v${identity.version}` };
    },

    async publishDraftNonLatest(draft) {
      command('gh', ['api', '-X', 'PATCH', `repos/${REPO}/releases/${draft.id}`, '-F', 'draft=false', '-f', 'make_latest=false']);
    },

    async observeGithub(identity) {
      const release = json('gh', ['api', `repos/${REPO}/releases/tags/${identity.tag}`]);
      const latest = maybe(() => json('gh', ['api', `repos/${REPO}/releases/latest`]).tag_name, null);
      return { tag: release.tag_name, sha: tagSha(identity.tag, root), latest: latest === identity.tag };
    },

    async promoteNpm(identity) {
      command('npm', ['dist-tag', 'add', `${PACKAGE}@${identity.version}`, 'latest']);
    },
    async observeNpmLatest() {
      return { version: command('npm', ['view', `${PACKAGE}@latest`, 'version']) };
    },
    async makeGithubLatest(draft) {
      command('gh', ['api', '-X', 'PATCH', `repos/${REPO}/releases/${draft.id}`, '-f', 'make_latest=true']);
    },
    async observeGithubLatest() {
      return { tag: json('gh', ['api', `repos/${REPO}/releases/latest`]).tag_name };
    },
    async restoreNpmLatest(prior, expected) {
      const current = command('npm', ['view', `${PACKAGE}@latest`, 'version']);
      if (current !== expected) throw new Error(`refusing compensation: npm latest is ${current}, expected ${expected}`);
      command('npm', ['dist-tag', 'add', `${PACKAGE}@${prior}`, 'latest']);
    },
    async finalize(identity, receipt, hostVerifier) {
      const staged = materializeRemoteAssets(activeDraft, identity);
      let hosts;
      try {
        hosts = await hostVerifier.verify({ source: 'final', identity, assets: staged.assets });
      } finally {
        staged.cleanup();
      }
      if (hosts.verdict !== 'PASS') return { verdict: 'FAIL', hosts };
      if (!candidateReceipt || !publicationReceipt) {
        throw new Error('final convergence requires candidate and publication receipt paths');
      }
      if (!fs.existsSync(path.resolve(root, publicationReceipt))) {
        const publication = spawnSync(process.execPath, [
          'scripts/publication-receipt.mjs', '--candidate', candidateReceipt, '--out', publicationReceipt,
        ], { cwd: root, encoding: 'utf8', timeout: 1_200_000 });
        if (publication.error || publication.status !== 0) {
          return { verdict: 'FAIL', hosts, publicationError: String(publication.stderr || publication.error?.message) };
        }
      }
      const seal = spawnSync(process.execPath, [
        'scripts/release-proof.mjs', '--candidate', candidateReceipt, '--publication', publicationReceipt,
      ], { cwd: root, encoding: 'utf8', timeout: 300_000 });
      if (seal.error || seal.status !== 0) {
        return { verdict: 'FAIL', hosts, sealError: String(seal.stderr || seal.error?.message) };
      }
      const channels = spawnSync(process.execPath, ['scripts/verify-channels.mjs'], {
        cwd: root, encoding: 'utf8', timeout: 600_000,
      });
      if (channels.error || channels.status !== 0) {
        return { verdict: 'FAIL', hosts, channelError: String(channels.stderr || channels.error?.message) };
      }
      const probe = spawnSync(process.execPath, ['scripts/published-surface-probe.mjs', '--json'], {
        cwd: root, encoding: 'utf8', timeout: 600_000,
      });
      let observed = null;
      try { observed = JSON.parse(probe.stdout || ''); } catch {}
      return {
        verdict: probe.status === 0 && observed?.verdict === 'PASS' ? 'PASS' : 'FAIL',
        hosts, surface: observed, publicationReceipt, previousReceiptDigest: receipt.receiptDigest,
      };
    },
  };
}
