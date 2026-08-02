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
  packageIntegrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  bundleSha256: 'b'.repeat(64),
};
export const assets = { packagePath: '/sealed/package.tgz', bundlePath: '/sealed/brain.zip' };

export class FakeReleaseProvider {
  constructor({ fault = null, prior = '9.9.8' } = {}) {
    this.fault = fault;
    this.receipts = [];
    this.calls = [];
    this.draft = null;
    this.npmLatest = prior;
    this.githubLatest = `v${prior}`;
    this.prior = prior;
  }

  hit(name) {
    this.calls.push(name);
    if (this.fault === name) throw new Error(`injected ${name}`);
  }

  async discover(candidate) {
    this.hit('discover');
    return {
      pending: this.pending || [],
      matchingDrafts: this.draft ? [this.draft] : [],
      receipts: [...this.receipts],
      prior: { npmLatest: this.prior, githubLatest: `v${this.prior}` },
    };
  }

  async createDraft(candidate, fence) {
    this.hit('createDraft');
    this.draft = { id: 77, tag: candidate.tag, sha: candidate.candidateSha, fence };
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

  async uploadAssets() { this.hit('uploadAssets'); }
  async materializeStagedAssets() {
    this.hit('materializeStagedAssets');
    return { assets, cleanup: () => this.hit('cleanupStagedAssets') };
  }
  async stageNpm() { this.hit('stageNpm'); }
  async observeNpmCandidate() {
    this.hit('observeNpmCandidate');
    return { version: identity.version, integrity: identity.packageIntegrity, tag: `candidate-v${identity.version}` };
  }
  async publishDraftNonLatest() { this.hit('publishDraftNonLatest'); }
  async observeGithub() {
    this.hit('observeGithub');
    return { sha: identity.candidateSha, latest: false, tag: identity.tag };
  }
  async promoteNpm() { this.hit('promoteNpm'); this.npmLatest = identity.version; }
  async observeNpmLatest() { this.hit('observeNpmLatest'); return { version: this.npmLatest }; }
  async makeGithubLatest() { this.hit('makeGithubLatest'); this.githubLatest = identity.tag; }
  async observeGithubLatest() { this.hit('observeGithubLatest'); return { tag: this.githubLatest }; }
  async restoreNpmLatest(prior, expected) {
    this.hit('restoreNpmLatest');
    if (this.npmLatest !== expected) throw new Error('compensation compare failed');
    this.npmLatest = prior;
  }
  async finalize(identityValue, _receipt, hostVerifier) {
    this.hit('finalize');
    const hosts = await hostVerifier.verify({ source: 'final', identity: identityValue, assets });
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
