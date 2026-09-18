import { verifyInventory, sha256Hex, RULES_VERSION } from './source-units.mjs';
import { validateLabels, loadBgeEmbedder } from './validate-labels.mjs';
import { verifyProductionEvidence, MAX_UNIT_CHARS, sourceEvidenceDigest } from './production-evidence.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertSourceCensusPartitions } from './source-census.mjs';

/** Reconstruct source and semantic proof before a diagnostic oracle can become acceptance evidence. */
export async function qualifyOracleSource(oracle, validated, { evidence, trustedProductionKey, embed, sourceCensus = null } = {}) {
  if (oracle.schemaVersion !== 2 || !evidence || !trustedProductionKey) throw new Error('source qualification needs v2 accounting, evidence, and an external trusted production key');
  if (oracle.emptySources?.length) throw new Error('empty source acceptance requires separate authenticated emptiness review');
  if (Object.keys(evidence).length !== validated.partitions.size) throw new Error('source evidence partition set differs');
  if (sourceCensus) assertSourceCensusPartitions(sourceCensus, [...validated.partitions.values()].map(row=>({
    id:row.partition,kind:row.kind,store:row.store,sourceCommit:row.sourceCommit,
  })));
  const embedder = embed || await loadBgeEmbedder();
  const qualification = { schemaVersion: 1, kind: 'ruvnet-brain-oracle-source-qualification',
    sourceEvidenceSha256: sourceEvidenceDigest(evidence),
    trustedProductionKeyId: crypto.createHash('sha256').update((trustedProductionKey.type === 'public' ? trustedProductionKey : crypto.createPublicKey(trustedProductionKey)).export({ type: 'spki', format: 'der' })).digest('hex'), partitions: [] };
  for (const partition of validated.partitions.values()) {
    const proof = evidence[partition.partition];
    if (!proof || partition.rulesVersion !== RULES_VERSION) throw new Error('missing authoritative v2 source evidence');
    if (partition.store !== proof.inventory?.repo) throw new Error('source partition store does not match authenticated inventory repo');
    const inventory = await verifyInventory(proof.inventory, proof.snapshotDir);
    if (partition.store !== inventory.repo) throw new Error('source partition store does not match authenticated inventory repo');
    const labelsById = new Map((proof.labels.labels || []).map(label => [label.unitId, label]));
    const accounted = inventory.selected.filter(unit => labelsById.get(unit.unitId)?.accountedMiss);
    const declaredMisses = Array.isArray(partition.unproduced) ? partition.unproduced : [];
    const missKey = entry => `${entry.unitId}:${entry.reason}`;
    const actualMisses = accounted.map(unit => ({ unitId: unit.unitId, reason: labelsById.get(unit.unitId).missReason }));
    if (partition.sourceCommit !== inventory.commit || partition.inventorySha256 !== sha256Hex(Buffer.from(JSON.stringify(inventory)))
      || partition.U !== inventory.U || partition.selectedUnits !== inventory.selected.length
      || declaredMisses.length !== actualMisses.length
      || new Set(declaredMisses.map(missKey)).size !== new Set(actualMisses.map(missKey)).size
      || declaredMisses.some(entry => !actualMisses.some(actual => missKey(actual) === missKey(entry)))) {
      throw new Error('oracle partition differs from verified source accounting');
    }
    for (const unit of accounted) {
      const label = labelsById.get(unit.unitId);
      if (label.missReason === 'unit_exceeds_producer_context') {
        const bytes = fs.readFileSync(path.join(proof.snapshotDir, unit.path));
        const text = Number.isInteger(unit.startByte) && Number.isInteger(unit.endByte)
          ? bytes.subarray(unit.startByte, unit.endByte).toString('utf8') : bytes.toString('utf8');
        if (text.length <= MAX_UNIT_CHARS || JSON.stringify(label.unproducedSlots) !== JSON.stringify(['direct', 'paraphrase'])) throw new Error('oversized accounted miss is not source-bound');
      } else if (label.missReason !== 'judge_verdict_no') throw new Error('unrecognized accounted miss');
    }
    const production = verifyProductionEvidence(proof.labels, trustedProductionKey);
    if (!production.verified) throw new Error(`production evidence is not authenticated: ${production.reason}`);
    const validation = await validateLabels({ labels: proof.labels, inventory, snapshotDir: proof.snapshotDir,
      embed: embedder, trustedProductionKey });
    if (!validation.oracleComplete) throw new Error('oracle source labels lack complete authenticated validation');
    const attestation = proof.labels.attestation;
    if (!attestation?.labelsDigest || !attestation.keyId) throw new Error('authenticated labels lack production evidence identity');
    qualification.partitions.push({ id: partition.partition, store: partition.store, repo: inventory.repo,
      commit: inventory.commit, inventoryDigest: partition.inventorySha256, labelsDigest: attestation.labelsDigest,
      keyId: attestation.keyId, U: inventory.U, selectedUnits: inventory.selected.length });
    const byId = labelsById;
    for (const row of validated.labels.filter(label => label.partition === partition.partition)) {
      const label = byId.get(row.unit);
      if (!label || row.question !== label[row.form] || row.span !== label.span || row.sourcePath !== label.path
        || row.blobSha !== label.blobSha || row.unitSha256 !== label.bytesSha256) throw new Error('oracle question differs from authenticated source label');
    }
  }
  qualification.partitions.sort((a, b) => a.id.localeCompare(b.id));
  return { ...validated, c3Eligible: true, classification: 'c3-acceptance', qualification };
}
