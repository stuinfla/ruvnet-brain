import fs from 'node:fs';
import path from 'node:path';

// Managed facts are additive for existing users. Their existing row is the user overlay: it wins
// byte-for-byte, including disablement, tier/priority changes, and local candidates. Newly shipped
// metered rows are not auto-added; that would silently expand spend authority.
export function mergeManagedCatalog(existing, managed) {
  const current = Array.isArray(existing?.candidates) ? existing.candidates : [];
  const seen = new Set(current.map((candidate) => candidate?.id).filter(Boolean));
  const additions = (managed?.candidates || []).filter((candidate) => candidate?.id
    && !seen.has(candidate.id)
    && ((candidate.subscription || []).length > 0 || candidate.provider === 'local'));
  const next = {
    ...existing,
    managedVersion: managed?.managedVersion || managed?.updated || null,
    candidates: [...current, ...additions],
  };
  return JSON.stringify(next) === JSON.stringify(existing) ? existing : next;
}

// Issue #87: the merge above was correct but reachable only from offerRouterProfile(), which runs on
// the FRESH-INSTALL path alone. `--update` (and therefore Evergreen nightly) never called it, so the
// one population that needs managed additions — users who already have ~/.claude/model-router/
// catalog.json — could never acquire a newly shipped managed model. This is that same merge as a
// non-interactive, idempotent step the update path can call: no prompts, no TEST_MODE gate, backs the
// user's file up before it writes, and replaces it by atomic rename so a crash can never half-apply.
export function applyManagedCatalogUpdate({ routerDir, packageRoot }) {
  const template = path.join(packageRoot, 'config', 'model-router', 'catalog.template.json');
  const target = path.join(routerDir, 'catalog.json');
  if (!fs.existsSync(template)) return { action: 'skipped', added: [], detail: 'no managed template in this package' };
  const managed = JSON.parse(fs.readFileSync(template, 'utf8'));
  fs.mkdirSync(routerDir, { recursive: true });
  if (!fs.existsSync(target)) {
    fs.copyFileSync(template, target);
    return { action: 'created', added: (managed.candidates || []).map((candidate) => candidate.id), detail: target };
  }
  const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  const merged = mergeManagedCatalog(existing, managed);
  if (merged === existing) return { action: 'unchanged', added: [], detail: target };
  const before = new Set((existing.candidates || []).map((candidate) => candidate.id));
  fs.copyFileSync(target, `${target}.pre-managed-merge`);
  const staged = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(staged, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(staged, target);
  return {
    action: 'merged',
    added: merged.candidates.filter((candidate) => !before.has(candidate.id)).map((candidate) => candidate.id),
    detail: target,
  };
}
