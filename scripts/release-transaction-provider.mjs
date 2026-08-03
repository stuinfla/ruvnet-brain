import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pollObservation, RECEIPT_PREFIX, TERMINAL_STATES, transactionIdFor,
} from './release-transaction.mjs';

const REPO = 'stuinfla/ruvnet-brain';
const PACKAGE = 'ruvnet-brain';
export const ASSET_DOWNLOAD_TIMEOUT_MS = Number(process.env.RUVNET_RELEASE_ASSET_TIMEOUT_MS || 600_000);

const command = (name, args, options = {}) => execFileSync(name, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, ...options,
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
    encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], timeout: ASSET_DOWNLOAD_TIMEOUT_MS,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`cannot download transaction asset ${asset.name}: ${result.error?.message || result.signal || `exit ${result.status}`}`);
  }
  return Buffer.from(result.stdout);
};
const assetReceipt = (asset) => JSON.parse(assetBytes(asset).toString('utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const OBSERVATION_POLICY = {
  maxElapsedMs: Number(process.env.RUVNET_NPM_VISIBILITY_TIMEOUT_MS || 180_000),
  maxAttempts: Number(process.env.RUVNET_NPM_VISIBILITY_ATTEMPTS || 14),
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
  multiplier: 1.8,
  jitter: (delay) => Math.floor(Math.random() * Math.min(1_000, delay * 0.2)),
};

export function selectCurrentReleaseBytes({ remoteBytes, localBytes, generatedBytes, identity }) {
  const bytes = remoteBytes || localBytes || generatedBytes;
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('public receipt is invalid JSON'); }
  if (value.transactionId !== identity.transactionId || value.version !== identity.version
    || value.candidateSha !== identity.candidateSha || value.verdict !== 'PASS'
    || value.hosts?.verdict !== 'PASS') {
    throw new Error('public receipt identity conflict');
  }
  return Buffer.from(bytes);
}

export function liveReleaseProvider({
  root = process.cwd(), candidateReceipt = null, publicationReceipt = null,
} = {}) {
  let releases = [];
  let activeDraft = null;
  const assetDigestCache = new Map();
  const refresh = () => {
    const pages = json('gh', ['api', `repos/${REPO}/releases?per_page=100`, '--paginate', '--slurp']);
    releases = (Array.isArray(pages?.[0]) ? pages : [pages]).flat();
    return releases;
  };
  const releaseById = (id) => json('gh', ['api', `repos/${REPO}/releases/${id}`]);
  const assetsForRelease = (id) => {
    const pages = json('gh', ['api', `repos/${REPO}/releases/${id}/assets?per_page=100`, '--paginate', '--slurp']);
    return (Array.isArray(pages?.[0]) ? pages : [pages]).flat();
  };
  const hydratedRelease = (release) => ({ ...release, assets: assetsForRelease(release.id) });
  const receiptsFor = (release) => (release?.assets || [])
    .filter(({ name }) => name.startsWith(RECEIPT_PREFIX) && name.endsWith('.json'))
    .map(assetReceipt);
  const expectedAssets = (identity) => ({
    'ruvnet-brain.zip': identity.bundleSha256,
    'ruvnet-brain.zip.sig': identity.bundleSignatureSha256,
    'ruvnet-brain.zip.sha256': identity.bundleDigestSha256,
    [identity.packageAssetName || '']: identity.packageSha256 || null,
  });
  const digestAsset = (asset, force = false) => {
    const key = `${asset.id}:${asset.size}`;
    if (!force && assetDigestCache.has(key)) return assetDigestCache.get(key);
    const digest = sha256(assetBytes(asset));
    assetDigestCache.set(key, digest);
    return digest;
  };
  const assetsExactFor = (release, identity, force = false) => {
    const expected = expectedAssets(identity);
    return Object.entries(expected).filter(([name, digest]) => name && digest).every(([name, digest]) => {
      const asset = release?.assets?.find((item) => item.name === name);
      return asset && digestAsset(asset, force) === digest;
    });
  };
  const materializeRemoteAssets = async (draft, identity) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-release-staged-'));
    try {
      const release = hydratedRelease(releaseById(draft.id));
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
      if (identity.bundleSignatureSha256
        && sha256(fs.readFileSync(assets.bundleSignaturePath)) !== identity.bundleSignatureSha256) {
        throw new Error('staged GitHub bundle signature bytes do not match transaction identity');
      }
      if (identity.bundleDigestSha256
        && sha256(fs.readFileSync(assets.bundleDigestPath)) !== identity.bundleDigestSha256) {
        throw new Error('staged GitHub digest sidecar bytes do not match transaction identity');
      }
      const { value: metadata } = await pollObservation(
        async () => json('npm', ['view', `${PACKAGE}@candidate-v${identity.version}`, '--json']),
        (value) => value?.version === identity.version
          && value?.dist?.integrity === identity.packageIntegrity
          && typeof value?.dist?.tarball === 'string',
        OBSERVATION_POLICY,
      );
      const response = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`npm candidate tarball download failed: HTTP ${response.status}`);
      assets.packagePath = path.join(temp, identity.packageAssetName || `${PACKAGE}-${identity.version}.tgz`);
      fs.writeFileSync(assets.packagePath, Buffer.from(await response.arrayBuffer()), { flag: 'wx', mode: 0o600 });
      const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(assets.packagePath)).digest('base64')}`;
      if (integrity !== identity.packageIntegrity) throw new Error('staged npm package integrity mismatch');
      return { assets, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
    } catch (error) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  };

  return {
    observationPolicy: OBSERVATION_POLICY,

    async discover(identity) {
      const all = refresh();
      const matchingDrafts = all.filter((release) => release.tag_name === identity.tag)
        .map((release) => ({
          id: release.id,
          tag: release.tag_name,
          sha: release.draft ? release.target_commitish : tagSha(identity.tag, root),
          draft: release.draft,
        }))
        .filter((release) => release.sha === identity.candidateSha);
      activeDraft = matchingDrafts[0] || null;
      const receipts = matchingDrafts.length === 1
        ? receiptsFor(hydratedRelease(releaseById(matchingDrafts[0].id))) : [];
      const latestByTransaction = new Map();
      for (const release of all) {
        for (const receipt of receiptsFor(hydratedRelease(release))) {
          const prior = latestByTransaction.get(receipt.transactionId);
          if (!prior || receipt.sequence > prior.receipt.sequence) {
            latestByTransaction.set(receipt.transactionId, { receipt, release });
          }
        }
      }
      const npmLatest = command('npm', ['view', `${PACKAGE}@latest`, 'version']);
      const githubLatest = json('gh', ['api', `repos/${REPO}/releases/latest`]).tag_name;
      const legacySettled = [];
      const pending = [];
      for (const { receipt, release } of latestByTransaction.values()) {
        if (TERMINAL_STATES.has(receipt.state)) continue;
        const settled = receipt.schemaVersion === 1 && release.draft === false
          && receipt.identity?.version === npmLatest && receipt.identity?.tag === githubLatest;
        if (settled) legacySettled.push(receipt.transactionId);
        else pending.push(receipt);
      }
      return { matchingDrafts, receipts, pending, legacySettled, prior: { npmLatest, githubLatest } };
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

    async observeSnapshot(identity, draft = activeDraft, { forceAssets = false } = {}) {
      try {
        const release = draft?.id ? hydratedRelease(releaseById(draft.id)) : null;
        const latestTag = json('gh', ['api', `repos/${REPO}/releases/latest`]).tag_name;
        const candidate = maybe(() => json('npm', ['view', `${PACKAGE}@candidate-v${identity.version}`, '--json']), null);
        const exactVersion = maybe(() => json('npm', ['view', `${PACKAGE}@${identity.version}`, '--json']), null);
        const latestVersion = command('npm', ['view', `${PACKAGE}@latest`, 'version']);
        const resolvedSha = release && !release.draft ? tagSha(identity.tag, root) : release?.target_commitish || draft?.sha || null;
        const publicReceipt = release?.assets?.find((asset) => asset.name === 'current-release.json');
        let publicReceiptExact = false;
        let publicHostsExact = false;
          if (publicReceipt) {
            const value = assetReceipt(publicReceipt);
            publicReceiptExact = value?.transactionId === transactionIdFor(identity)
              && value?.version === identity.version
              && value?.candidateSha === identity.candidateSha
              && /^[a-f0-9]{64}$/.test(value?.publicationReceiptSha256 || '');
            publicHostsExact = value?.verdict === 'PASS' && value?.hosts?.verdict === 'PASS'
              && ['claudeOnly', 'codexOnly', 'dual'].every((mode) => value.hosts?.[mode]?.status === 'PASS'
                && value.hosts?.[mode]?.doctorExit === 0
                && value.hosts?.[mode]?.artifactSha256 === identity.packageSha256);
        }
        return {
          npm: {
            candidateVersion: candidate?.version || exactVersion?.version || null,
            candidateIntegrity: candidate?.dist?.integrity || exactVersion?.dist?.integrity || null,
            candidateTagVersion: candidate?.version || null,
            latestVersion,
          },
          github: release ? {
            tag: release.tag_name,
            sha: resolvedSha,
            draft: release.draft === true,
            published: release.draft === false,
            latest: latestTag === identity.tag,
            latestTag,
            assetsExact: assetsExactFor(release, identity, forceAssets),
          } : { tag: null, sha: null, draft: false, published: false, latest: false, assetsExact: false },
          publicReceiptExact,
          publicHostsExact,
        };
      } catch (error) {
        return { readError: error.message };
      }
    },

    async observeNpm(identity) {
      const candidate = maybe(() => json('npm', ['view', `${PACKAGE}@candidate-v${identity.version}`, '--json']), null);
      const exactVersion = maybe(() => json('npm', ['view', `${PACKAGE}@${identity.version}`, '--json']), null);
      return {
        candidateVersion: candidate?.version || exactVersion?.version || null,
        candidateIntegrity: candidate?.dist?.integrity || exactVersion?.dist?.integrity || null,
        candidateTagVersion: candidate?.version || null,
        latestVersion: command('npm', ['view', `${PACKAGE}@latest`, 'version']),
      };
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
      const release = hydratedRelease(releaseById((draft || activeDraft).id));
      const asset = release.assets?.find((item) => item.name === name);
      if (!asset) throw new Error(`remote receipt ${name} is missing after upload`);
      return assetReceipt(asset);
    },

    async uploadAssets(draft, assets) {
      const paths = [assets.bundlePath, assets.bundleSignaturePath, assets.bundleDigestPath, assets.packagePath];
      for (const file of paths) {
        const release = hydratedRelease(releaseById(draft.id));
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
      if (existing) {
        if (existing !== identity.packageIntegrity) throw new Error('existing npm version has different immutable bytes');
        command('npm', ['dist-tag', 'add', `${PACKAGE}@${identity.version}`, `candidate-v${identity.version}`]);
        return;
      }
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

    async promoteNpm(identity, expectedPrior) {
      const current = command('npm', ['view', `${PACKAGE}@latest`, 'version']);
      if (current !== expectedPrior && current !== identity.version) {
        throw new Error(`refusing npm promotion: latest is ${current}, expected ${expectedPrior}`);
      }
      command('npm', ['dist-tag', 'add', `${PACKAGE}@${identity.version}`, 'latest']);
    },
    async observeNpmLatest() {
      return { version: command('npm', ['view', `${PACKAGE}@latest`, 'version']) };
    },
    async makeGithubLatest(draft, identity, expectedPrior) {
      const current = json('gh', ['api', `repos/${REPO}/releases/latest`]).tag_name;
      if (current !== expectedPrior && current !== identity.tag) {
        throw new Error(`refusing GitHub promotion: latest is ${current}, expected ${expectedPrior}`);
      }
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
    async finalize(identity, receipt, _hostVerifier) {
      if (!candidateReceipt || !publicationReceipt) {
        throw new Error('final convergence requires candidate and publication receipt paths');
      }
      if (!fs.existsSync(path.resolve(root, publicationReceipt))) {
        const publication = spawnSync(process.execPath, [
          'scripts/publication-receipt.mjs', '--candidate', candidateReceipt, '--out', publicationReceipt,
        ], { cwd: root, encoding: 'utf8', timeout: 1_200_000 });
        if (publication.error || publication.status !== 0) {
          return { verdict: 'FAIL', publicationError: String(publication.stderr || publication.error?.message) };
        }
      }
      const seal = spawnSync(process.execPath, [
        'scripts/release-proof.mjs', '--candidate', candidateReceipt, '--publication', publicationReceipt,
      ], { cwd: root, encoding: 'utf8', timeout: 300_000 });
      if (seal.error || seal.status !== 0) {
        return { verdict: 'FAIL', sealError: String(seal.stderr || seal.error?.message) };
      }
      const publication = JSON.parse(fs.readFileSync(path.resolve(root, publicationReceipt), 'utf8'));
      const hosts = {
        verdict: 'PASS',
        claudeOnly: publication.installed?.claudeOnly,
        codexOnly: publication.installed?.codexOnly,
        dual: publication.installed?.dual,
      };
      const observed = publication.postPublicationChecks?.find(({ name }) => name === 'published-surface-probe');
      const result = {
        verdict: observed?.status === 'completed' && observed?.conclusion === 'success' ? 'PASS' : 'FAIL',
        hosts, surface: observed, publicationReceipt, previousReceiptDigest: receipt.receiptDigest,
      };
      if (result.verdict === 'PASS') {
        const currentRelease = path.join(path.dirname(path.resolve(root, publicationReceipt)), 'current-release.json');
        const generatedCurrentRelease = Buffer.from(`${JSON.stringify({
          schemaVersion: 1,
          transactionId: receipt.transactionId,
          version: identity.version,
          tag: identity.tag,
          candidateSha: identity.candidateSha,
          verdict: 'PASS',
          publicationReceiptSha256: sha256(fs.readFileSync(path.resolve(root, publicationReceipt))),
          hosts,
          surface: observed,
        }, null, 2)}\n`);
        let remote = hydratedRelease(releaseById(activeDraft.id)).assets
          ?.find((asset) => asset.name === 'current-release.json');
        let currentReleaseBytes;
        try {
          currentReleaseBytes = selectCurrentReleaseBytes({
            remoteBytes: remote ? assetBytes(remote) : null,
            localBytes: !remote && fs.existsSync(currentRelease) ? fs.readFileSync(currentRelease) : null,
            generatedBytes: generatedCurrentRelease,
            identity: { transactionId: receipt.transactionId, version: identity.version, candidateSha: identity.candidateSha },
          });
        } catch (error) {
          return { ...result, verdict: 'FAIL', currentReleaseError: error.message };
        }
        if (!fs.existsSync(currentRelease)) fs.writeFileSync(currentRelease, currentReleaseBytes, { flag: 'wx', mode: 0o600 });
        if (!remote) {
          command('gh', ['release', 'upload', activeDraft.tag, currentRelease, '--repo', REPO]);
          remote = hydratedRelease(releaseById(activeDraft.id)).assets
            ?.find((asset) => asset.name === 'current-release.json');
        }
        if (!remote || sha256(assetBytes(remote)) !== sha256(currentReleaseBytes)) {
          return { ...result, verdict: 'FAIL', currentReleaseError: 'public receipt verification failed' };
        }
      }
      return result;
    },
  };
}
