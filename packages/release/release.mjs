// Release rail, skeleton slice: seal an app folder and a pack into one release folder and sign one
// release.json over both (contract 4.4). Nothing is rebuilt after signing.
//   node release.mjs --pack <packDir> --out <releaseDir> --key <private.pem> --release-number N [--app-version X]
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../contract/validate.mjs';
import { isMain, listFiles, readJson, sha256File, writeJsonAtomic } from '../contract/home.mjs';
import { sign } from '../contract/signature.mjs';
import { SHIM_VERSION } from '../contract/constants.mjs';

const PACKAGES = new URL('..', import.meta.url);
// What an installed app holds: the engine and the server, plus what they import, and the two command
// packages the installed CLI loads (`migrate`/`rollback-to-4` and `guard`, wave 3).
export const APP_PACKAGES = ['contract', 'engine', 'server', 'health', 'cli', 'plugin', 'guard', 'migrate'];

const inventory = (dir) => listFiles(dir).map((p) => ({ path: p, size: fs.statSync(path.join(dir, p)).size, sha256: sha256File(path.join(dir, p)) }));

export function makeRelease({ packDir, outDir, privateKeyPem, releaseNumber, appVersion }) {
  if (fs.existsSync(outDir)) throw new Error(`${outDir} already exists`);
  const appVer = appVersion ?? readJson(new URL('version.json', PACKAGES)).app;
  const pack = check('pack', readJson(path.join(packDir, 'PACK.json')), 'PACK.json');
  for (const p of APP_PACKAGES) {
    fs.cpSync(new URL(`${p}/`, PACKAGES), path.join(outDir, 'app', p), { recursive: true });
  }
  fs.cpSync(packDir, path.join(outDir, 'pack'), { recursive: true });
  const body = {
    schema: 'ruvnet-brain/release',
    version: 1,
    releaseNumber,
    minShim: SHIM_VERSION,
    app: { version: appVer, files: inventory(path.join(outDir, 'app')) },
    pack: { generation: pack.generation, files: inventory(path.join(outDir, 'pack')) },
  };
  const release = check('release', sign(body, privateKeyPem), 'release.json');
  writeJsonAtomic(path.join(outDir, 'release.json'), release);
  return release;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? null : args[i + 1];
  };
  const packDir = take('--pack');
  const outDir = take('--out');
  const key = take('--key');
  const n = Number(take('--release-number'));
  if (!packDir || !outDir || !key || !Number.isInteger(n)) {
    console.error('usage: node release.mjs --pack <packDir> --out <releaseDir> --key <private.pem> --release-number N [--app-version X]');
    process.exit(2);
  }
  try {
    const r = makeRelease({ packDir: path.resolve(packDir), outDir: path.resolve(outDir), privateKeyPem: fs.readFileSync(key, 'utf8'), releaseNumber: n, appVersion: take('--app-version') ?? undefined });
    console.log(`release ${r.releaseNumber}: app ${r.app.version}, pack ${r.pack.generation}, key ${r.signature.keyId}`);
  } catch (e) {
    console.error(`release failed: ${e.message}`);
    process.exit(1);
  }
}
