import crypto from 'node:crypto';
import {
  runReleaseTransaction,
  transactionIdFor,
} from '../../scripts/release-transaction.mjs';

export const keys = crypto.generateKeyPairSync('ed25519');
export const identity = {
  repository: 'stuinfla/ruvnet-brain',
  package: 'ruvnet-brain',
  version: '9.9.9',
  tag: 'v9.9.9',
  candidateSha: 'a'.repeat(40),
  payloadId: 'c'.repeat(64),
  evidenceDigest: 'd'.repeat(64),
  packageIntegrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  bundleSha256: 'b'.repeat(64),
};
export const assets = { packagePath: '/sealed/package.tgz', bundlePath: '/sealed/brain.zip' };

export class FakeReleaseProvider {
  constructor({ fault = null, prior = '9.9.8', visibilityDelay = {} } = {}) {
    this.fault = fault;
    this.receipts = [];
    this.calls = [];
    this.draft = null;
    this.npmLatest = prior;
    this.githubLatest = `v${prior}`;
    this.prior = prior;
    this.assetsExact = false;
    this.candidatePublished = false;
    this.candidateIntegrity = null;
    this.githubPublished = false;
    this.publicReceiptExact = false;
    this.publicHostsExact = false;
    this.visibilityDelay = { ...visibilityDelay };
    this.observations = 0;
    let clock = 0;
    this.observationPolicy = {
      maxElapsedMs: 1_000,
      maxAttempts: 8,
      initialDelayMs: 10,
      maxDelayMs: 50,
      multiplier: 2,
      jitter: () => 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    };
  }

  hit(name) {
    this.calls.push(name);
    if (this.fault === name) throw new Error(`injected ${name}`);
  }

  async discover() {
    this.hit('discover');
    return {
      pending: this.pending || [],
      matchingDrafts: this.draft ? [this.draft] : [],
      receipts: [...this.receipts],
      prior: { npmLatest: this.prior, githubLatest: `v${this.prior}` },
    };
  }

  async createDraft(candidate) {
    this.hit('createDraft');
    this.draft = { id: 77, tag: candidate.tag, sha: candidate.candidateSha, draft: true };
    return this.draft;
  }

  async appendReceipt(_draft, receipt) {
    this.hit(`append:${receipt.state}`);
    if (this.receipts.some(({ sequence }) => sequence === receipt.sequence)) throw new Error('duplicate receipt sequence');
    this.receipts.push(structuredClone(receipt));
  }

  async readReceipt(_draft, sequence) {
    this.hit('readReceipt');
    return structuredClone(this.receipts.find((receipt) => receipt.sequence === sequence));
  }

  visible(name) {
    const remaining = this.visibilityDelay[name] || 0;
    if (remaining <= 0) return true;
    this.visibilityDelay[name] = remaining - 1;
    return false;
  }

  async observeSnapshot() {
    this.hit('observeSnapshot');
    this.observations += 1;
    const candidateVisible = this.candidatePublished && this.visible('candidate');
    const npmLatest = this.visible('npmLatest') ? this.npmLatest : this.prior;
    const githubLatest = this.visible('githubLatest') && this.githubLatest === identity.tag;
    return {
      npm: {
        candidateVersion: candidateVisible ? identity.version : null,
        candidateIntegrity: candidateVisible ? this.candidateIntegrity : null,
        candidateTagVersion: candidateVisible ? identity.version : null,
        latestVersion: npmLatest,
      },
      github: {
        tag: this.draft?.tag || null,
        sha: this.draft?.sha || null,
        draft: this.draft?.draft === true,
        published: this.githubPublished,
        latest: githubLatest,
        latestTag: this.githubLatest,
        assetsExact: this.assetsExact,
      },
      publicReceiptExact: this.publicReceiptExact,
      publicHostsExact: this.publicHostsExact,
    };
  }

  async observeNpm() {
    const value = await this.observeSnapshot();
    return value.npm;
  }

  async uploadAssets() { this.hit('uploadAssets'); this.assetsExact = true; }
  async materializeStagedAssets() {
    this.hit('materializeStagedAssets');
    return { assets, cleanup: () => this.hit('cleanupStagedAssets') };
  }
  async verifyMaterializedPayload() { this.hit('verifyMaterializedPayload'); }
  async stageNpm() {
    this.hit('stageNpm');
    this.candidatePublished = true;
    this.candidateIntegrity = identity.packageIntegrity;
  }
  async publishDraftNonLatest() {
    this.hit('publishDraftNonLatest');
    this.draft.draft = false;
    this.githubPublished = true;
  }
  async promoteNpm(_candidate, expectedPrior = this.prior) {
    this.hit('promoteNpm');
    if (this.npmLatest !== expectedPrior && this.npmLatest !== identity.version) throw new Error('npm latest compare failed');
    this.npmLatest = identity.version;
  }
  async makeGithubLatest(_draft, _candidate, expectedPrior = `v${this.prior}`) {
    this.hit('makeGithubLatest');
    if (this.githubLatest !== expectedPrior && this.githubLatest !== identity.tag) throw new Error('GitHub latest compare failed');
    this.githubLatest = identity.tag;
  }
  async restoreNpmLatest(prior, expected) {
    this.hit('restoreNpmLatest');
    if (this.npmLatest !== expected) throw new Error('compensation compare failed');
    this.npmLatest = prior;
  }
  async finalize(identityValue, _receipt, hostVerifier) {
    this.hit('finalize');
    const hosts = await hostVerifier.verify({ source: 'final', identity: identityValue, assets });
    if (hosts.verdict === 'PASS') {
      this.publicReceiptExact = true;
      this.publicHostsExact = true;
    }
    return { verdict: hosts.verdict, hosts };
  }
}

export const passingHosts = {
  calls: [],
  async verify(input) {
    this.calls.push(input.source);
    return { verdict: 'PASS', claude: 'PASS', codex: 'PASS', dual: 'PASS' };
  },
};

export const execute = (adapter, hostVerifier = { ...passingHosts, calls: [] }) => runReleaseTransaction({
  identity,
  assets,
  adapter,
  hostVerifier,
  privateKey: keys.privateKey,
  publicKey: keys.publicKey,
});

export const transactionId = transactionIdFor(identity);
