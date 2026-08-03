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
