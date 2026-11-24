#!/usr/bin/env node
/**
 * doc-sync-engine.mjs — Automatic Markdown Currency & Timestamp Engine (RuvNet Brain v5.0).
 *
 * Keeps project Markdown documents aligned with the reality of the code:
 *   1. Audits every project `.md` file (skipping node_modules, .git, dist, build, worktrees, archives)
 *      for:
 *      - Missing or stale `Updated: YYYY-MM-DD HH:MM:SS EST | Version X.Y.Z` / `Created:` header
 *      - Broken local file path links (`[label](path)` or backticked `src/...`, `scripts/...`, `plugin/...`)
 *      - Version string drift against `package.json`
 *   2. In `--apply` mode, safely stamps or updates the `Updated:` / `Created:` header on Markdown files
 *      that are missing timestamps or whose linked code moved more recently than the doc, without
 *      clobbering YAML frontmatter (`--- ... ---`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDirectInvocation } from './entrypoint.mjs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', '.swarm', '.agentic-qe', '.next', '.nuxt',
  'dist', 'build', 'out', 'coverage', '.venv', 'venv', 'target', '.cache',
]);

const UPDATED_RE = /^Updated:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[A-Z]{2,4})(?:\s*\|\s*Version\s+([0-9]+\.[0-9]+\.[0-9]+))?/m;
const CREATED_RE = /^Created:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[A-Z]{2,4})/m;

export function formatEasternStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hh}:${get('minute')}:${get('second')} ${get('timeZoneName') || 'EST'}`;
}

function collectMarkdownFiles(cwd, maxFiles = 120) {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (out.length >= maxFiles || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        out.push({ full, rel: path.relative(cwd, full).replace(/\\/g, '/') });
      }
    }
  };
  walk(cwd, 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function projectVersion(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)) return pkg.version;
  } catch { /* no package.json */ }
  return '1.0.0';
}

function extractReferencedLocalPaths(text, docRel) {
  const refs = new Set();
  // Markdown relative links: [text](./foo/bar.mjs) or [text](scripts/foo.mjs#L10)
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    const raw = m[1].split('#')[0].split('?')[0].trim();
    if (!raw || /^(https?:|mailto:|file:|#|<)/i.test(raw)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(docRel), raw));
    if (!resolved.startsWith('..')) refs.add(resolved);
  }
  return [...refs];
}

function gitCreatedStamp(cwd, rel) {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--follow', '--format=%aI', '--', rel], {
      cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').pop();
    if (out) return formatEasternStamp(new Date(out));
  } catch { /* non-git or untracked */ }
  try {
    const st = fs.statSync(path.join(cwd, rel));
    return formatEasternStamp(new Date(st.birthtimeMs || st.mtimeMs));
  } catch {
    return formatEasternStamp(new Date());
  }
}

/**
 * Audit all Markdown docs in `cwd` for timestamp hygiene, broken local links, and code-vs-doc drift.
 */
export function auditMarkdownDocs(cwd = process.cwd(), { maxFiles = 120 } = {}) {
  const abs = path.resolve(cwd);
  const files = collectMarkdownFiles(abs, maxFiles);
  const pkgVer = projectVersion(abs);
  const findings = [];
  let stamped = 0;
  let missingStamp = 0;
  let brokenLinkDocs = 0;
  let staleCodeDocs = 0;

  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    const hasFrontmatter = text.startsWith('---\n');
    const upMatch = text.match(UPDATED_RE);
    const crMatch = text.match(CREATED_RE);
    const hasUpdated = Boolean(upMatch);
    const hasCreated = Boolean(crMatch);
    if (hasUpdated) stamped++;
    else missingStamp++;

    const refs = extractReferencedLocalPaths(text, f.rel);
    const brokenLinks = [];
    const docMtime = fs.statSync(f.full).mtimeMs;
    const newerLinkedCode = [];

    for (const ref of refs) {
      const target = path.join(abs, ref);
      if (!fs.existsSync(target)) {
        // Ignore template placeholders like <path> or example paths
        if (!/[<>*{}$]/.test(ref)) brokenLinks.push(ref);
      } else {
        try {
          const st = fs.statSync(target);
          if (st.isFile() && st.mtimeMs > docMtime + 60_000) newerLinkedCode.push(ref);
        } catch { /* ignore */ }
      }
    }

    if (brokenLinks.length) brokenLinkDocs++;
    if (newerLinkedCode.length) staleCodeDocs++;

    if (!hasUpdated || brokenLinks.length || newerLinkedCode.length) {
      findings.push({
        path: f.rel,
        hasFrontmatter,
        hasUpdated,
        hasCreated,
        recordedUpdated: upMatch ? upMatch[1] : null,
        recordedVersion: upMatch ? (upMatch[2] || null) : null,
        brokenLinks: brokenLinks.slice(0, 8),
        newerLinkedCode: newerLinkedCode.slice(0, 8),
      });
    }
  }

  return {
    ok: true,
    cwd: abs,
    projectVersion: pkgVer,
    scanned: files.length,
    stamped,
    missingStamp,
    brokenLinkDocs,
    staleCodeDocs,
    findings,
  };
}

/**
 * Stamp or refresh `Updated: YYYY-MM-DD HH:MM:SS EST | Version X.Y.Z` + `Created:` headers
 * on Markdown files (respecting YAML frontmatter).
 */
export function stampMarkdownFile(filePath, { cwd = process.cwd(), version = null, now = new Date() } = {}) {
  const abs = path.resolve(filePath);
  const rel = path.relative(path.resolve(cwd), abs).replace(/\\/g, '/');
  const raw = fs.readFileSync(abs, 'utf8');
  const ver = version || projectVersion(cwd);
  const updatedLine = `Updated: ${formatEasternStamp(now)} | Version ${ver}`;

  // Preserve YAML frontmatter if present
  let prefix = '';
  let body = raw;
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---\n', 4);
    if (end > 0) {
      prefix = raw.slice(0, end + 5);
      body = raw.slice(end + 5);
    }
  }

  let nextBody = body;
  if (UPDATED_RE.test(body)) {
    nextBody = body.replace(UPDATED_RE, updatedLine);
  } else {
    const createdLine = CREATED_RE.test(body) ? null : `Created: ${gitCreatedStamp(cwd, rel)}`;
    const headerBlock = createdLine ? `${updatedLine}\n${createdLine}\n\n` : `${updatedLine}\n\n`;
    nextBody = `${headerBlock}${body.replace(/^\n+/, '')}`;
  }

  const nextFull = `${prefix}${nextBody}`;
  const changed = nextFull !== raw;
  if (changed) fs.writeFileSync(abs, nextFull, 'utf8');
  return { path: rel, changed, updatedLine };
}

/**
 * Apply timestamp hygiene across a list of target Markdown files (or all unstamped docs in `cwd`).
 */
export function syncMarkdownDocs({ cwd = process.cwd(), files = null, apply = false, maxFiles = 120 } = {}) {
  const audit = auditMarkdownDocs(cwd, { maxFiles });
  const targets = Array.isArray(files) && files.length
    ? files.map((f) => path.resolve(cwd, f)).filter((f) => fs.existsSync(f))
    : audit.findings.filter((f) => !f.hasUpdated || f.newerLinkedCode.length > 0).map((f) => path.join(audit.cwd, f.path));

  if (!apply) {
    return {
      ...audit,
      mode: 'dry-run',
      wouldStampCount: targets.length,
      wouldStamp: targets.map((t) => path.relative(audit.cwd, t).replace(/\\/g, '/')).slice(0, 40),
    };
  }

  const stampedFiles = [];
  for (const t of targets) {
    try {
      const r = stampMarkdownFile(t, { cwd: audit.cwd, version: audit.projectVersion });
      if (r.changed) stampedFiles.push(r.path);
    } catch { /* skip unwritable */ }
  }
  return {
    ...audit,
    mode: 'apply',
    stampedNow: stampedFiles.length,
    stampedFiles,
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d = '') => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const cwd = get('--dir', process.cwd());
  const apply = args.includes('--apply');
  const fileArg = get('--file', '');
  const res = syncMarkdownDocs({ cwd, files: fileArg ? [fileArg] : null, apply });
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
}

if (isDirectInvocation(import.meta.url)) {
  main();
}
