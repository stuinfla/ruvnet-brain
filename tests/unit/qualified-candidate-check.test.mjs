import { describe, it, expect } from 'vitest';
import { REQUIRED_CHECKS } from '../../scripts/release-proof.mjs';
import { getVersion } from '../../scripts/version.mjs';
import { aggregateEvidence, REQUIRED_RELEASE_LEAVES } from '../../scripts/release-evidence-aggregate.mjs';
import { payloadIdFor } from '../../scripts/release-payload.mjs';
import { checkQualifiedCandidate, downloadQualificationReceipt } from '../../scripts/qualified-candidate-check.mjs';
const SHA = 'a'.repeat(40), VERSION = getVersion(), digest = 'b'.repeat(64);
function fixture() {
  const receipt = {
    schemaVersion: 1,
    phase: 'candidate',
    sha: SHA,
    tree: 'b'.repeat(40),
    dirty: false,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceVersions: { package: VERSION, claudePlugin: VERSION, codexPlugin: VERSION },
    artifact: {
      path: `release-evidence/ruvnet-brain-${VERSION}.tgz`,
      sha256: digest,
      sourceSha: SHA,
      version: VERSION,
      bundle: { brainVersion: VERSION, releaseTag: `v${VERSION}` },
    },
    releaseVector: { verdict: 'PASS', sha: SHA, unknown: 0, skipped: 0 },
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
    coverage: { status: 'PASS', lines: 95, requiredLines: 80 },
    security: { status: 'PASS', critical: 0, high: 0 },
    issues: { open: [] },
    github: {
      sha: SHA,
      checks: REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    },
    hosts: {
      claude: { status: 'PASS', version: VERSION, artifactSha256: digest },
      codex: { status: 'PASS', version: VERSION, artifactSha256: digest },
    },
    brain: {
      status: 'PASS', selfStore: true, citedSelfSource: true,
      narrowMs: 100, broadMs: 200, concurrentMs: 150, deadlineMs: 1000,
    },
    qe: { status: 'PASS', total: 1, passed: 1, failed: 0, skipped: 0 },
    graders: [
      { id: 'grader-a', independent: true, score: 95, sha: SHA, artifactSha256: digest },
      { id: 'grader-b', independent: true, score: 96, sha: SHA, artifactSha256: digest },
    ],
  };

 const run = {id:42,workflow_id:7,path:'.github/workflows/release-candidate-preflight.yml',event:'push',head_sha:SHA,head_branch:'release/test',status:'completed',conclusion:'success',repository:{id:1,full_name:'stuinfla/ruvnet-brain'},head_repository:{id:1,full_name:'stuinfla/ruvnet-brain'}};
 const artifact=(id,name)=>({id,name,digest:'sha256:'+digest,size_in_bytes:100,expired:false,workflow_run:{id:42,head_sha:SHA,head_branch:'release/test',repository_id:1,head_repository_id:1}});
 const big=artifact(10,'release-candidate-'+SHA),small=artifact(11,'qualification-receipt-'+SHA);
 const manifest={schemaVersion:1,candidateSha:SHA,version:VERSION,tag:'v'+VERSION,members:[{name:'ruvnet-brain-'+VERSION+'.tgz',sha256:digest,size:100}]};
 const envelope=aggregateEvidence({sha:SHA,payloadId:payloadIdFor(manifest),leaves:REQUIRED_RELEASE_LEAVES.map(name=>({name,sha:SHA,payloadId:payloadIdFor(manifest),runId:42,status:'completed',conclusion:'success',verdict:'PASS'}))});
 const proof={schemaVersion:1,kind:'ruvnet-brain-qualified-candidate',sha:SHA,runId:42,artifact:{id:10,name:big.name,digest:big.digest,size:100},candidateReceipt:receipt,payloadManifest:manifest,aggregateEnvelope:envelope};
 const readApi=async(endpoint)=> endpoint.includes('/runs?')?{workflow_runs:[run]}:endpoint==='actions/workflows/release-candidate-preflight.yml'?{id:7,path:run.path}:endpoint==='actions/runs/42'?run:endpoint.includes('/artifacts?')?{artifacts:[big,small]}:endpoint==='actions/artifacts/10'?big:small;
 return {run,big,small,proof,options:{sha:SHA,requiredCheck:'canonical-qa',readApi,readReceipt:async()=>proof}};
}
describe('qualified candidate read-only consumer',()=>{
 it('rejects downloaded artifact bytes whose GitHub digest differs',async()=>{const f=fixture();await expect(downloadQualificationReceipt(f.small,async()=>Buffer.from('tampered zip'))).rejects.toThrow(/artifact digest differs/);});
 it('accepts authenticated exact-SHA qualification',async()=>{const f=fixture();expect(await checkQualifiedCandidate(f.options)).toMatchObject({verdict:'PASS',runId:42,artifactId:10});});
 it.each(['failure','cancelled','timed_out'])('rejects terminal %s',async(conclusion)=>{const f=fixture();f.run.conclusion=conclusion;await expect(checkQualifiedCandidate(f.options)).rejects.toThrow(/qualification failed/);});
 it.each([
 ['receipt source',f=>f.proof.sha='c'.repeat(40)],
 ['artifact digest',f=>f.proof.artifact.digest='sha256:'+'c'.repeat(64)],
 ['envelope tamper',f=>f.proof.aggregateEnvelope.evidenceDigest='c'.repeat(64)],
 ['payload tamper',f=>f.proof.payloadManifest.members[0].sha256='c'.repeat(64)],
 ['failed leaf',f=>f.proof.aggregateEnvelope.leaves[0].verdict='FAIL'],
 ['wrong run',f=>f.proof.aggregateEnvelope.leaves[0].runId=43],
 ['expired artifact',f=>f.big.expired=true],
 ['artifact wrong source',f=>f.big.workflow_run.head_sha='c'.repeat(40)],
 ])('rejects %s',async(_label,mutate)=>{const f=fixture();mutate(f);await expect(checkQualifiedCandidate(f.options)).rejects.toThrow();});
 it.each(['pull_request','workflow_dispatch'])('does not trust %s',async(event)=>{const f=fixture();f.run.event=event;let time=0;await expect(checkQualifiedCandidate({...f.options,timeoutMs:1,now:()=>time,pause:async(ms)=>{time+=ms;}})).rejects.toThrow(/timed out/);});
 it('waits for in-progress producer without starting qualification',async()=>{const f=fixture();f.run.status='in_progress';let time=0,calls=0;const result=await checkQualifiedCandidate({...f.options,now:()=>time,pause:async(ms)=>{time+=ms;calls++;f.run.status='completed';}});expect(calls).toBe(1);expect(result.verdict).toBe('PASS');});
 it('rejects stale source and fork runs after bounded waiting',async()=>{const f=fixture();f.run.head_repository.id=2;let time=0;await expect(checkQualifiedCandidate({...f.options,timeoutMs:1,now:()=>time,pause:async(ms)=>{time+=ms;}})).rejects.toThrow(/timed out/);});
});
