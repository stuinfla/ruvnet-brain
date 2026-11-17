// Stage, then promote with restore (architecture 2.5 steps 2, 4, 5). A channel is where releases are
// published; `fsChannel` is a folder (the dry run, and the tests' fork-like repository). The public
// channel is a cutover item (see the workflow headers): no publisher for it exists in this package.
//
// Promotion is refused unless: the staged bytes still match the signature (re-hashed now); the
// version is the version source's; every required operating system has a complete, passing
// install-and-probe receipt for exactly these bytes; and the answer gate's result for exactly these
// bytes passed by the pinned set's rule, recomputed here (evidence.mjs; review F01).
// Promotion moves two pointers, packages then release; if anything fails part-way, both are put back.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../contract/home.mjs';
import { Refused, checkVersion, tagFor, verifyStaged } from './checks.mjs';
import { checkGate, checkReceipts, stagedProbes } from './evidence.mjs';

const POINTERS = { packages: 'packages.json', release: 'latest.json' };

export function fsChannel(dir) {
  const file = (step) => path.join(dir, POINTERS[step]);
  return {
    stagedDir: (tag) => path.join(dir, 'staged', tag),
    current() {
      try {
        return JSON.parse(fs.readFileSync(file('release'), 'utf8'));
      } catch {
        return null;
      }
    },
    stage(tag, fromDir) {
      const to = path.join(dir, 'staged', tag);
      if (fs.existsSync(to)) throw new Refused(`${tag} is already staged; a tag is never published twice`);
      fs.cpSync(fromDir, to, { recursive: true });
    },
    snapshot: () => Object.fromEntries(Object.keys(POINTERS).map((s) => [s, fs.existsSync(file(s)) ? fs.readFileSync(file(s)) : null])),
    restore(snap) {
      for (const [s, bytes] of Object.entries(snap)) {
        if (bytes === null) fs.rmSync(file(s), { force: true });
        else fs.writeFileSync(file(s), bytes);
      }
    },
    promote(step, tag, record) {
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(file(step), { ...record, step });
    },
  };
}

/** Publishes the sealed bytes as a pre-release: staged, never what an installed machine reads. */
export function stage({ releaseDir, channel, publicKeyPem }) {
  const { release } = verifyStaged(releaseDir, publicKeyPem);
  const tag = tagFor(release);
  channel.stage(tag, releaseDir);
  verifyStaged(channel.stagedDir(tag), publicKeyPem);
  return tag;
}

export { checkGate, checkReceipts };

export function promote({ tag, channel, receipts, gate, version, publicKeyPem }) {
  const { release, sha256 } = verifyStaged(channel.stagedDir(tag), publicKeyPem);
  checkVersion({ expected: version });
  if (release.app.version !== version) throw new Refused(`the staged release is version ${release.app.version}, not ${version}`);
  if (tagFor(release) !== tag) throw new Refused(`the staged release is ${tagFor(release)}, not ${tag}`);
  checkReceipts(receipts, sha256, release, stagedProbes(channel.stagedDir(tag)));
  checkGate(gate, sha256, release);
  const cur = channel.current();
  if (cur && cur.app === release.app.version && cur.pack === release.pack.generation) return { outcome: 'no-change', tag: cur.tag };
  if (cur && release.releaseNumber <= cur.releaseNumber) throw new Refused(`release number ${release.releaseNumber} is not above the promoted ${cur.releaseNumber}`);
  const record = { tag, releaseNumber: release.releaseNumber, app: release.app.version, pack: release.pack.generation, release: sha256, gate: gate?.score ?? null, promotedAt: new Date().toISOString() };
  const before = channel.snapshot();
  let at = null;
  try {
    for (const step of ['packages', 'release']) {
      at = step;
      channel.promote(step, tag, record);
    }
  } catch (e) {
    channel.restore(before);
    const back = channel.snapshot();
    const same = Object.keys(before).every((k) => (before[k] === null ? back[k] === null : back[k] !== null && Buffer.compare(before[k], back[k]) === 0));
    throw new Refused(`promotion failed at the ${at} step (${e.message}); ${same ? 'the previous release was restored' : 'RESTORE FAILED: the channel no longer matches the previous release'}`);
  }
  return { outcome: 'published', tag };
}
