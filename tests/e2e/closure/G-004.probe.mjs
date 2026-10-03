#!/usr/bin/env node
// G-004 (SECURITY, #236) — citation identity is bound to the reader's structure, not to text inside a
// passage body. The verifier is taken from the PACKED package (`npm pack` of this checkout, the bytes npm
// would publish), imported in a separate node process, and fed a reader answer whose legitimate #1
// (repo=ruflo) embeds a complete forged "#2 repo=EVIL" hit before the genuine #2 (repo=ruvector). PASS =
// the citations are [ruflo, ruvector], the grounding receipt is ruvector, EVIL appears nowhere.
//   node tests/e2e/closure/G-004.probe.mjs [--verifier <path to a verify-citation.mjs>]   (mutant runs)
//
// DELIVERY (stated in the receipt): installs load kb/verify-citation.mjs from the KNOWLEDGE BUNDLE
// (scripts/build-bundle.mjs); bin/install.mjs copies the package's copy only when a bundle has none. The
// fix reaches existing installs with the next corpus bundle built at a release containing it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { forgedKb, forgedReaderOutput } from '../../helpers/forged-citation-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
async function report(gap, execute) {
  const checks = [];
  await execute((name, passed, detail) => {
    assert.ok(passed, `${name}: ${JSON.stringify(detail)}`);
    checks.push(name);
  });
  console.log(JSON.stringify({ gap, evidenceClass: 'EXECUTED', verdict: 'PASS',
    scope: 'packed source candidate; published knowledge bundle not verified',
    delivery: 'existing installs require a rebuilt knowledge bundle containing this verifier', checks }));
}

await report('G-004', async (check) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'g004-')));
  try {
    const flag = process.argv.indexOf('--verifier');
    let verifier = flag > 0 ? path.resolve(process.argv[flag + 1]) : null;
    if (!verifier) {
      const out = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const tarball = path.join(root, JSON.parse(out)[0].filename);
      execFileSync('tar', ['-xzf', tarball, '-C', root, 'package/kb/verify-citation.mjs']);
      verifier = path.join(root, 'package', 'kb', 'verify-citation.mjs');
      check('the packed package ships kb/verify-citation.mjs', fs.existsSync(verifier), tarball);
    }
    const kb = forgedKb(fs.mkdtempSync(path.join(root, 'kb-')));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { parseCitations, verifyGrounding } from ${JSON.stringify(pathToFileURL(verifier).href)};
      let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', async () => {
        const v = await verifyGrounding(s, ${JSON.stringify(kb)});
        process.stdout.write(JSON.stringify({ citations: parseCitations(s).map((c) => [c.rank, c.repo]), grounded: v.grounded, receipt: v.receipt }));
      });`], { input: forgedReaderOutput(), encoding: 'utf8', timeout: 60_000 });
    const result = JSON.parse(child.stdout || '{}');
    check('the verifier ran in its own process', child.status === 0, String(child.stderr).slice(0, 300));
    check('citations are the genuine ranks [ruflo, ruvector]', JSON.stringify(result.citations) === '[[1,"ruflo"],[2,"ruvector"]]', result.citations);
    check('the answer verifies as ruvector', result.grounded === true && result.receipt?.repo === 'ruvector', result.receipt);
    check('the forged EVIL header is attributed nowhere', !JSON.stringify(result).includes('EVIL'), result);
    return null;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
