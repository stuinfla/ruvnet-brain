#!/usr/bin/env node
// One-publisher source gate for issue #77. Rebuild and maintenance jobs may prepare bytes, but
// only scripts/release.mjs may contain operations that create a GitHub Release, publish npm, or
// move an npm dist-tag. CI and the canonical release path both execute this check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_PUBLISHERS = new Set([
  'scripts/release.mjs',
  'scripts/release-transaction-provider.mjs',
]);
const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.sh']);

function executableSource(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const ACTIONS = [
  {
    action: 'github-release-create',
    jsPatterns: [
      /\[\s*['"]release['"]\s*,\s*['"]create['"]/,
    ],
    shellPatterns: [/^\s*gh\s+release\s+create\b/m],
  },
  {
    action: 'github-release-update',
    jsPatterns: [
      /['"]PATCH['"][\s\S]{0,120}releases\//,
      /\[\s*['"]release['"]\s*,\s*['"]edit['"]/,
    ],
    shellPatterns: [/^\s*gh\s+(?:release\s+edit|api\s+.*releases\/.*PATCH)\b/m],
  },
  {
    action: 'npm-publish',
    jsPatterns: [
      /(?:execFileSync|spawnSync)\(\s*['"]npm['"]\s*,\s*\[\s*['"]publish['"]/,
      /runOrDie\(\s*['"]npm publish['"]/,
    ],
    shellPatterns: [/^\s*npm\s+publish\b/m],
  },
  {
    action: 'npm-dist-tag',
    jsPatterns: [
      /(?:execFileSync|spawnSync)\(\s*['"]npm['"]\s*,\s*\[\s*['"]dist-tag['"]\s*,\s*['"]add['"]/,
      /runOrDie\(\s*['"]npm dist-tag[^'"]*['"]/,
    ],
    shellPatterns: [/^\s*npm\s+dist-tag\s+add\b/m],
  },
];

export function detectPublisherActions(file, source) {
  const relative = file.split(path.sep).join('/');
  if (CANONICAL_PUBLISHERS.has(relative)) return [];
  const executable = executableSource(source);
  const kind = path.extname(relative) === '.sh' ? 'shellPatterns' : 'jsPatterns';
  return ACTIONS
    .filter((action) => action[kind].some((pattern) => pattern.test(executable)))
    .map(({ action }) => ({ file: relative, action }));
}

function sourceFiles(root) {
  const files = [];
  const visit = (absolute) => {
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(child);
    }
  };
  visit(path.join(root, 'scripts'));
  visit(path.join(root, 'deploy'));
  visit(path.join(root, 'bin'));
  return files;
}

export function findUnauthorizedPublishers(root = ROOT) {
  return sourceFiles(root).flatMap((absolute) => {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    return detectPublisherActions(relative, fs.readFileSync(absolute, 'utf8'));
  });
}

export function main(root = ROOT) {
  const findings = findUnauthorizedPublishers(root);
  if (findings.length === 0) {
    console.log('[release-authority] PASS: scripts/release.mjs is the only publisher');
    return 0;
  }
  console.error('[release-authority] FAIL: publication action found outside scripts/release.mjs');
  for (const finding of findings) console.error(`  ${finding.file}: ${finding.action}`);
  return 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
