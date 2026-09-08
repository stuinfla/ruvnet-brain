import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

// npm dependencies are separately installed outside the immutable package payload.
export function packageTreeObservation(root) {
  const files = [];
  const visit = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!prefix && name === 'node_modules') continue;
      const file = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, relative);
      else if (stat.isFile()) files.push({ path: relative, sha256: hash(fs.readFileSync(file)) });
      else throw new Error(`npm package contains an unsupported entry: ${relative}`);
    }
  };
  visit(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return { name: manifest.name, version: manifest.version, fileCount: files.length,
    treeSha256: hash(JSON.stringify(files)) };
}

export function observeNpxPackage(npmCache, expected) {
  const base = path.join(npmCache, '_npx');
  const roots = fs.existsSync(base) ? fs.readdirSync(base).map((name) =>
    path.join(base, name, 'node_modules', 'ruvnet-brain')).filter((root) => fs.existsSync(root)) : [];
  if (roots.length !== 1) throw new Error(`expected exactly one isolated npx Brain package, found ${roots.length}`);
  const observed = packageTreeObservation(roots[0]);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error('npx package bytes differ from verified public package');
  return { ...observed, path: roots[0], observedAt: new Date().toISOString() };
}

export function validateNpxObservations(proof) {
  const expected = proof.packageExecution?.expected;
  const observations = proof.packageExecution?.observations;
  const policy = proof.packageExecution?.policy;
  const target = proof.registration?.packageTarget;
  const productionLatest = policy === 'production-latest-exact-cache-v1'
    && target?.spec === 'ruvnet-brain@latest' && target.sha256 === null;
  const sealedCandidate = policy === 'sealed-candidate-exact-cache-v1'
    && typeof target?.spec === 'string' && target.spec.endsWith('.tgz')
    && /^[a-f0-9]{64}$/.test(String(target.sha256 || ''))
    && target.sha256 === proof.candidate?.sha256;
  if ((!productionLatest && !sealedCandidate)
    || expected?.packageSha256 !== proof.candidate?.sha256
    || expected?.name !== 'ruvnet-brain' || expected.version !== proof.candidate?.version
    || !/^[a-f0-9]{64}$/.test(expected.treeSha256 || '') || !Number.isSafeInteger(expected.fileCount)
    || expected.fileCount <= 0 || !Array.isArray(observations) || observations.length !== 3) {
    return ['native production package execution evidence is incomplete'];
  }
  const failures = [];
  for (const observed of observations) {
    if (observed.name !== expected.name || observed.version !== expected.version
      || observed.treeSha256 !== expected.treeSha256 || observed.fileCount !== expected.fileCount
      || typeof observed.path !== 'string' || !observed.path
      || !Number.isFinite(Date.parse(observed.observedAt))) failures.push('native npx package identity differs');
  }
  if (!Array.isArray(proof.runs) || proof.runs.length !== 2) return [...failures, 'native package run evidence is missing'];
  for (let i = 0; i < 2; i++) {
    const run = proof.runs[i].receipt;
    if (run?.desiredVersion !== expected.version
      || Date.parse(observations[i].observedAt) > Date.parse(run?.startedAt)
      || Date.parse(observations[i + 1].observedAt) < Date.parse(run?.finishedAt)
      || Date.parse(observations[i + 1].observedAt) > Date.parse(proof.observedAt)) {
      failures.push('native package observation does not bound the exact-version run');
    }
  }
  return failures;
}
