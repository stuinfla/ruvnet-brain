import fs from 'node:fs';
import path from 'node:path';
import { coverageGenerationFor, validateCoverageDirectory, validatePublicInventory, digest } from '../../plugin/scripts/coverage-integrity.mjs';
import { createReleaseProjection } from '../../scripts/release-projection.mjs';

export function sourceCensusFixture() {
  const partitions=[{id:'alpha',kind:'repository',store:'alpha',sourceCommit:'a'.repeat(40)},
    {id:`gist:${'b'.repeat(32)}`,kind:'gist',store:'ruv-gists',sourceCommit:'c'.repeat(40)}].sort((a,b)=>a.id.localeCompare(b.id));
  const value={schemaVersion:2,archiveStores:['alpha','concepts','ruv-gists'],excludedDerived:[{store:'concepts',reason:'derived-view',ledgerDigest:'f'.repeat(64)}],kind:'ruvnet-brain-oracle-archive-source-census',coverageSha256:'d'.repeat(64),corpusCoverageSha256:'e'.repeat(64),partitions};
  return {...value,censusSha256:digest(value)};
}

/** Add modern provenance to existing real fixture stores without replacing any RVF or sidecar. */
export function augmentSourceCoverage(root, {rows=null}={}) {
  const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
  const write=(name,value)=>fs.writeFileSync(path.join(root,name),`${JSON.stringify(value,null,2)}\n`);
  const prior=read('RVF-GENERATIONS.json');
  const version=prior.brainVersion,sourceSnapshot='d'.repeat(40);
  const ledger={...prior,schemaVersion:2,kind:'ruvnet-brain-public-generation-ledger',sourceSnapshot};
  rows ??= Object.entries(ledger.stores).map(([store,entry])=>({key:`repo:${store}`,kind:'repository',name:store,
    url:`https://github.com/ruvnet/${store}`,status:'CURRENT',disposition:'eligible',
    upstream:{sha:entry.sourceCommit},artifact:{store,sourceCommit:entry.sourceCommit},reasons:[]}));
  rows = rows.map(row => ({...row, artifact: {...row.artifact, rvfSha256: row.artifact?.rvfSha256 ?? ledger.stores[row.artifact?.store]?.sha256}}));
  const counts={repositories:rows.filter(row=>row.kind==='repository').length,gists:rows.filter(row=>row.kind==='gist').length};
  const enumerationReceipt={schemaVersion:1,terminal:true,duplicateKeys:0,
    repositories:{expected:counts.repositories,pages:[]},gists:{expected:counts.gists,pages:[]}};
  const corpus={schemaVersion:1,kind:'ruvnet-brain-corpus-coverage',generatorSourceSha:'a'.repeat(64),
    snapshotRoot:'b'.repeat(64),sourceObservationSha256:'c'.repeat(64),rows,enumerationReceipt,
    policy:{policyDispositionDigests:[],exemptionDigests:[]},totals:{...counts,rows:rows.length,byStatus:{CURRENT:rows.length}}};
  corpus.coverageGeneration=coverageGenerationFor({...corpus,policyDispositionDigests:[],exemptionDigests:[]});
  const inventory=validatePublicInventory({assetsDir:root,coverage:corpus,ledger});
  const projection=createReleaseProjection({corpusCoverage:corpus,selectedLedger:ledger,identity:{version,sourceSnapshot},
    seedIdentity:{tag:`corpus-sha256-${'e'.repeat(64)}`,archiveSha256:'e'.repeat(64),archiveBytes:1,baselineReceiptSha256:'f'.repeat(64)},inventory});
  write('RVF-GENERATIONS.json',{...ledger,kind:'ruvnet-brain-runtime-generation-ledger'});
  fs.writeFileSync(path.join(root,'PUBLIC-RVF-GENERATIONS.json'),projection.publicGenerationLedgerBytes);
  fs.writeFileSync(path.join(root,'CORPUS-COVERAGE.json'),projection.corpusCoverageBytes);
  write('COVERAGE.json',projection.releaseCoverage);
  const checked=validateCoverageDirectory(root,{requireCompleteProfile:true});
  if(!checked.valid) throw new Error(checked.failures.join('; '));
  return root;
}
