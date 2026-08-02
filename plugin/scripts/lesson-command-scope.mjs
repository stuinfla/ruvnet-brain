// lesson-command-scope.mjs — pure advisory scope classification for lesson-gate.
//
// This is deliberately an allowlist of outside-repository mutations. Unknown commands stay quiet:
// over-firing an advisory trains users and agents to ignore it. Segments are classified only from
// executable position, so quoted examples and grep/echo text cannot manufacture a trigger.
import fs from 'node:fs';
import path from 'node:path';

function repositoryRoot(start = process.cwd()) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function splitTopLevelSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if ((char === '&' && command[i + 1] === '&') || (char === '|' && command[i + 1] === '|')) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

const SYSTEM_PATH_PREFIXES = ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/private', '/var', '/opt'];
const INSTALL_VERBS = new Set(['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'un']);
const GLOBAL_FLAGS = new Set(['-g', '--global']);
const SECURITY_MUTATING = new Set([
  'create-keychain', 'delete-keychain', 'set-keychain-password', 'set-keychain-settings',
  'unlock-keychain', 'lock-keychain', 'import', 'add-generic-password', 'add-internet-password',
  'delete-generic-password', 'delete-internet-password', 'default-keychain',
]);
const BREW_MUTATING = new Set(['install', 'uninstall', 'remove', 'rm', 'upgrade', 'reinstall', 'tap', 'untap', 'link', 'unlink', 'pin', 'unpin', 'services']);
const PKG_MUTATING = new Set(['install', 'remove', 'purge', 'upgrade']);
const FS_MUTATING_VERBS = new Set(['rm', 'mv', 'cp', 'ln', 'shred', 'truncate', 'unlink']);

function curlMutates(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if ((token === '-X' || token === '--request') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((tokens[i + 1] || '').toUpperCase())) return true;
    if (/^--request=/.test(token) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(token.split('=')[1].toUpperCase())) return true;
    if (token === '-d' || token === '--data' || /^--data(-raw|-binary|-urlencode)?$/.test(token) || token === '--upload-file' || token === '-T') return true;
  }
  return false;
}

function classifySegment(segment, repoRoot) {
  let tokens = tokenize(segment);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  if (!tokens.length) return false;
  const lead = tokens[0];
  const outsideRepo = (token) => token && !token.startsWith('-') && (
    token.startsWith('~') || (token.startsWith('/') && token !== repoRoot && !token.startsWith(repoRoot + path.sep))
  );
  const systemPath = (token) => token && !token.startsWith('-')
    && SYSTEM_PATH_PREFIXES.some((prefix) => token === prefix || token.startsWith(prefix + '/'));
  if (lead === 'sudo') return true;
  switch (lead) {
    case 'launchctl': return true;
    case 'security': return SECURITY_MUTATING.has(tokens[1]);
    case 'defaults': return tokens[1] === 'write' || tokens[1] === 'delete';
    case 'npm': case 'pnpm': case 'yarn': return INSTALL_VERBS.has(tokens[1]) && tokens.some((token) => GLOBAL_FLAGS.has(token));
    case 'pip': case 'pip3': case 'pipx': return tokens[1] === 'install' || tokens[1] === 'uninstall';
    case 'brew': return BREW_MUTATING.has(tokens[1]);
    case 'gem': return tokens[1] === 'install' || tokens[1] === 'uninstall';
    case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'pacman': case 'port': return PKG_MUTATING.has(tokens[1]);
    case 'git': return tokens[1] === 'push';
    case 'curl': return curlMutates(tokens);
    case 'wget': return tokens.some((token) => token.startsWith('--post-data') || token.startsWith('--post-file'));
    case 'chmod': case 'chown': case 'chgrp': return tokens.slice(1).some(systemPath);
    case 'dd': case 'mkfs': case 'diskutil': return true;
    case 'crontab': return tokens[1] === '-e' || tokens[1] === '-r';
    default: return FS_MUTATING_VERBS.has(lead) && tokens.slice(1).some(outsideRepo);
  }
}

export function looksLikeOutsideRepoMutation(command, repoRoot = repositoryRoot()) {
  if (!command || typeof command !== 'string') return false;
  return splitTopLevelSegments(command).some((segment) => classifySegment(segment, repoRoot));
}
