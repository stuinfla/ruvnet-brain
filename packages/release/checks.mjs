// The release rail's shared checks: the one version source, the staged-bytes check and the tag rule.
// Each refusal is one plain sentence (a Refused error); nothing here can be switched off.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../contract/validate.mjs';
import { listFiles, readJson, sha256File } from '../contract/home.mjs';
import { verify } from '../contract/signature.mjs';

export class Refused extends Error {}
export const PACKAGES = fileURLToPath(new URL('..', import.meta.url));
export const RAIL = readJson(new URL('rail.json', import.meta.url));

/**
 * The one version number (packages/version.json `app`). Since wave 2 the shipped shim carries no
 * number of its own (the installer stamps the installed copy with the app version, WP 7); a shim file
 * that does carry one must carry the same, so a disagreement is refused rather than shipped as two.
 */
export function versionSource(packagesDir = PACKAGES) {
  const app = readJson(path.join(packagesDir, 'version.json')).app;
  const shim = readJson(path.join(packagesDir, 'plugin', 'claude', '.claude-plugin', 'plugin.json')).version;
  if (shim !== undefined && app !== shim) throw new Refused(`packages/version.json says ${app} but the shim's plugin.json says ${shim}; set one version`);
  return app;
}

/** Refuses unless the requested version, the release branch (when one) and the version source agree. */
export function checkVersion({ packagesDir = PACKAGES, expected, branch = null }) {
  if (!expected) throw new Refused('no version was given; the rail releases only the version it is asked for');
  const source = versionSource(packagesDir);
  if (expected !== source) throw new Refused(`the requested version ${expected} does not match the version source ${source} (packages/version.json)`);
  if (branch && branch.startsWith('release/') && branch !== `release/${source}`) {
    throw new Refused(`branch ${branch} does not name version ${source}; a release branch must be release/${source}`);
  }
  return source;
}

/**
 * Checks a sealed or staged release folder byte for byte against its signed release.json: the
 * signature (trusted key), every listed file's size and hash, and no file that is not listed.
 * Returns { release, sha256 } where sha256 is that of release.json's bytes (what receipts bind to).
 */
export function verifyStaged(dir, publicKeyPem) {
  const file = path.join(dir, 'release.json');
  if (!fs.existsSync(file)) throw new Refused(`${dir} holds no release.json`);
  const release = check('release', JSON.parse(fs.readFileSync(file, 'utf8')), 'release.json');
  if (!verify(release, publicKeyPem)) throw new Refused('release.json is not signed by the trusted release key');
  const listed = new Set();
  for (const [part, files] of [['app', release.app.files], ['pack', release.pack.files]]) {
    for (const f of files) {
      const p = path.join(dir, part, f.path);
      listed.add(`${part}/${f.path}`);
      if (!fs.existsSync(p)) throw new Refused(`${part} file ${f.path} is missing from the release`);
      if (fs.statSync(p).size !== f.size || sha256File(p) !== f.sha256) throw new Refused(`${part} file ${f.path} does not match the signed release`);
    }
  }
  const extra = listFiles(dir).find((p) => p !== 'release.json' && !listed.has(p));
  if (extra) throw new Refused(`${extra} is in the release folder but not in the signed release`);
  return { release, sha256: sha256File(file) };
}

/** The name a v5 release is staged and promoted under. Never `vX.Y.Z` nor `corpus-sha256-*`: those are 4.7's. */
export function tagFor(release) {
  const tag = `${RAIL.tagPrefix}${release.app.version}-r${release.releaseNumber}`;
  const clash = RAIL.forbiddenTags.find((re) => new RegExp(re).test(tag));
  if (clash) throw new Refused(`tag ${tag} would be read by the 4.7 rail (${clash})`);
  return tag;
}

export const osName = (platform = process.platform) => ({ darwin: 'macos', win32: 'windows', linux: 'linux' })[platform] ?? platform;
