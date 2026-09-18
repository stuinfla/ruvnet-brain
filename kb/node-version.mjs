import fs from 'node:fs';

/** The shipped KB manifest owns the minimum Node runtime for all entry points. */
export function nodeVersionFailure(version = process.versions.node, requirement = null) {
  const engine = requirement ?? JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).engines?.node;
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engine || '');
  const actual = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version || '');
  if (!minimum || !actual) return `Cannot verify Node runtime ${version} against requirement ${engine}`;
  for (let i = 1; i <= 3; i++) {
    if (Number(actual[i]) > Number(minimum[i])) return null;
    if (Number(actual[i]) < Number(minimum[i])) return `RuvNet Brain needs Node ${engine.slice(2)} or newer — you're on ${version}.`;
  }
  return null;
}

export function assertSupportedNode(version = process.versions.node) {
  const failure = nodeVersionFailure(version);
  if (failure) throw new Error(failure);
}
