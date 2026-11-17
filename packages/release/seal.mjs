// Seal and sign, gated (architecture 2.5 step 1). The only signing path the release workflow runs.
// Before anything is signed: the version agrees with the one version source; the signing key is the
// trusted key's pair; every pack file matches PACK.json; the pack answers its own probes through the
// engine; the app is exactly the reviewed file list. Then release.mjs seals once, and the result is
// checked byte for byte. Nothing is rebuilt after signing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../contract/validate.mjs';
import { listFiles, readJson, sha256File } from '../contract/home.mjs';
import { keyId, trustedPublicKey } from '../contract/signature.mjs';
import * as engine from '../engine/index.mjs';
import { APP_PACKAGES, makeRelease } from './release.mjs';
import { PACKAGES, Refused, checkVersion, verifyStaged } from './checks.mjs';

const SHIPPED = new URL('shipped-files.json', import.meta.url);

/** Every app file as it would ship: `<package>/<path>`, sorted. */
export function appFiles(packagesDir = PACKAGES) {
  return APP_PACKAGES.flatMap((p) => listFiles(path.join(packagesDir, p)).map((f) => `${p}/${f}`)).sort();
}

/** Refuses unless the app is exactly the reviewed list in shipped-files.json. */
export function checkShipped(packagesDir = PACKAGES) {
  const want = readJson(SHIPPED).app;
  const have = appFiles(packagesDir);
  const extra = have.filter((f) => !want.includes(f));
  const missing = want.filter((f) => !have.includes(f));
  if (extra.length) throw new Refused(`${extra[0]} would ship but is not on the reviewed list (packages/release/shipped-files.json)${extra.length > 1 ? ` (and ${extra.length - 1} more)` : ''}`);
  if (missing.length) throw new Refused(`${missing[0]} is on the reviewed list but missing from the app`);
  return have;
}

/** Runs the pack's own probes through the engine; refuses when the pack is damaged or one probe misses. */
export function probePack(packDir) {
  const pack = check('pack', readJson(path.join(packDir, 'PACK.json')), 'PACK.json');
  for (const f of pack.files) {
    const p = path.join(packDir, f.path);
    if (!fs.existsSync(p) || fs.statSync(p).size !== f.size || sha256File(p) !== f.sha256) throw new Refused(`pack file ${f.path} does not match PACK.json`);
  }
  let h;
  let t;
  try {
    h = engine.open(packDir);
    t = engine.selfTest(h);
  } catch (e) {
    throw new Refused(`the pack could not be opened by the engine (${e.message}); it is not signed`);
  } finally {
    if (h) engine.close(h);
  }
  if (!t.ok) {
    const miss = t.results.filter((r) => !r.pass);
    throw new Refused(`the pack failed its probes (${t.error ?? `${miss.length} of ${t.results.length} did not find their file, first: "${miss[0]?.question}"`}); it is not signed`);
  }
  return { pack, results: t.results };
}

export function seal({ packagesDir = PACKAGES, packDir, outDir, version, branch = null, releaseNumber, privateKeyPem }) {
  if (!Number.isInteger(releaseNumber) || releaseNumber < 1) throw new Refused('the release number must be a whole number of at least 1');
  if (fs.existsSync(outDir)) throw new Refused(`${outDir} already exists; a release is sealed once`);
  checkVersion({ packagesDir, expected: version, branch });
  if (!privateKeyPem) throw new Refused('no signing key was given');
  let trusted;
  try {
    trusted = trustedPublicKey();
  } catch (e) {
    throw new Refused(e.message);
  }
  const pub = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });
  if (keyId(pub) !== keyId(trusted)) throw new Refused(`the signing key (${keyId(pub)}) is not the trusted release key (${keyId(trusted)}); installers would refuse it`);
  checkShipped(packagesDir);
  const probed = probePack(packDir);
  const release = makeRelease({ packDir, outDir, privateKeyPem, releaseNumber });
  try {
    const { sha256 } = verifyStaged(outDir, trusted);
    return { release, sha256, probes: probed.results.length };
  } catch (e) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
}
