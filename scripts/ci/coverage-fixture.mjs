// Shared synthetic coverage input for tests, never release qualification evidence.
export function fixtureArtifact(store, ledger) {
  const generation = ledger.stores[store];
  if (!generation) throw new Error(`fixture has no generation for ${store}`);
  return { store, rvfSha256: generation.sha256, sourceCommit: generation.sourceCommit };
}
