/** Compare exact artifact references on concurrent maximal heads, never ancestor history. */
export function artifactConflicts(heads) {
  const paths = new Map();
  for (const head of heads) {
    for (const artifact of head.completeProjectState.proofArtifacts) {
      const digest = artifact?.digest ?? artifact?.sha256;
      if (typeof artifact?.path !== 'string' || !artifact.path || typeof digest !== 'string' || !digest) continue;
      if (!paths.has(artifact.path)) paths.set(artifact.path, new Map());
      const owners = paths.get(artifact.path);
      if (!owners.has(head.eventKey)) owners.set(head.eventKey, []);
      owners.get(head.eventKey).push(artifact);
    }
  }
  const conflicts = [];
  for (const [path, owners] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
    if (owners.size < 2) continue;
    const digestSets = [...owners.values()].map(artifacts => JSON.stringify(
      [...new Set(artifacts.map(artifact => artifact.digest ?? artifact.sha256))].sort()));
    if (new Set(digestSets).size < 2) continue;
    conflicts.push({ field: `proofArtifacts.${path}`, values: [...owners]
      .sort(([a], [b]) => a.localeCompare(b)).map(([head, value]) => ({ head, value })) });
  }
  return conflicts;
}
