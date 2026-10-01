// scripts/customer-seams.mjs — the customer-side seams shared by scripts/corpus-canary.mjs (the nightly
// consumer gate) and scripts/customer-state-matrix.mjs (the same seams across many machine states). One copy.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/** `N-k`: the k-th published (non-draft) semver code release behind `candidateTag`, from a live release list. */
export function resolveRuntime(offset, { candidateTag, releases }) {
  const match = /^N-(\d+)$/.exec(offset);
  if (!match) throw new Error(`runtime offset must be N-<k>: ${offset}`);
  const key = (tag) => SEMVER_TAG.exec(tag).slice(1).map(Number);
  const cmp = (a, b) => { const [x, y] = [key(a), key(b)]; return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; };
  const tags = releases.filter((r) => !r.draft && SEMVER_TAG.test(r.tag_name || '')).map((r) => r.tag_name).sort(cmp);
  const at = tags.indexOf(candidateTag);
  if (at < 0) throw new Error(`candidate ${candidateTag} is not a published code release`);
  const tag = tags[at + Number(match[1])];
  if (!tag) throw new Error(`no published release ${offset} behind ${candidateTag}`);
  return tag.slice(1);
}

/**
 * A customer's PRIVATE store: the smallest real public store family, renamed, stamped by the product's
 * own writer (scripts/private-overlay.mjs) with an alias and a capability card — the same shape the
 * owner's 108 private stores have. Exercises capture -> candidate restore -> coverage convergence.
 */
export async function addPrivateStore({ kbDir, scratch, writerRoot, name = 'acme-private-notes' }) {
  const ledger = readJson(path.join(kbDir, 'RVF-GENERATIONS.json')).stores;
  const donor = Object.entries(ledger).filter(([, g]) => /\.big\.rvf$/.test(g.file || ''))
    .sort(([, a], [, b]) => a.bytes - b.bytes)[0][0];
  const from = path.join(scratch, 'private-sidecars');
  fs.mkdirSync(from, { recursive: true });
  for (const file of fs.readdirSync(kbDir).filter((f) => f.startsWith(`${donor}.`) || f === `${donor}-primer.md`)) {
    fs.copyFileSync(path.join(kbDir, file), path.join(from, file.replace(donor, name)));
  }
  const { applyPrivateOverlay } = await import(pathToFileURL(path.join(writerRoot, 'scripts', 'private-overlay.mjs')).href);
  const card = path.join(scratch, `${name}.card.md`);
  fs.writeFileSync(card, `Private notes (a renamed copy of ${donor}). Reach for it only for this customer's own material.\n`);
  // The fence comes first, exactly as the writer demands of a customer (PRIVATE-STORES.json).
  const fenceFile = path.join(kbDir, 'PRIVATE-STORES.json');
  const fence = fs.existsSync(fenceFile) ? readJson(fenceFile) : { privateStores: [] };
  fs.writeFileSync(fenceFile, `${JSON.stringify({ ...fence, privateStores: [...new Set([...(fence.privateStores || []), name])] }, null, 2)}\n`);
  applyPrivateOverlay({ root: kbDir, from, stores: [name], aliases: { [name]: [`${name}-alias`] }, cards: { [name]: card } });
  const digests = Object.fromEntries(fs.readdirSync(kbDir).filter((f) => f.startsWith(`${name}.`) || f.startsWith(`${name}-`))
    .sort().map((f) => [f, sha256File(path.join(kbDir, f))]));
  return { name, donor, digests };
}

/**
 * The `npx ruvnet-brain@latest --update` door: the APPROVED package's own installer, which self-upgrades
 * the installed updater, re-stamps the runtime, takes the refresh lock and runs the updater. Fallback is
 * disabled for the same reason the clean case never uses this door: a refused candidate must not turn
 * into a green fresh install. The updater's receipt is reconstructed from the refresh-run receipt the
 * installer settles (the installer deletes its private result file).
 */
export function runInstallerDoor({ installer, env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installer, '--update', '--no-nightly-prompt'],
      { cwd, env: { ...env, RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ exitCode: null, output: `${output}\n${error.message}` }));
    child.on('close', (exitCode) => resolve({ exitCode, output }));
  });
}

export function resultFromRefreshReceipt(brainHome) {
  const dir = path.join(brainHome, 'refresh-runs');
  if (!fs.existsSync(dir)) return null;
  const newest = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!newest) return null;
  const receipt = readJson(newest);
  const phase = (name) => receipt.phases?.find((p) => p.phase === name)?.evidence || {};
  return { terminalVerdict: receipt.status === 'SUCCEEDED' ? phase('update').terminalVerdict || null : receipt.terminalVerdict,
    bundleSha256: phase('bundle-assembly').bundleSha256 || null, coverageSha256: phase('coverage-generation').coverageSha256 || null,
    refreshStatus: receipt.status };
}
