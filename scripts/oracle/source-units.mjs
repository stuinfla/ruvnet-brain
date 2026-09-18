#!/usr/bin/env node
/** Canonical pinned-tree source inventory. Syntax candidates require blob-bound semantic disposition. */
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {snapshotManifest, resolveCommit as resolveTreeCommit} from './source-tree.mjs';
import {buildInventory as enumerateInventory, RULES_VERSION} from './unit-inventory.mjs';
import {createSourceAdapters} from './source-adapters.mjs';
export {RULES_VERSION};
export const sha256Hex=input=>createHash('sha256').update(input).digest('hex');
export const gitBlobSha=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export const unitText=(lines,startLine,endLine)=>lines.slice(startLine-1,endLine).join('\n');
export const resolveCommit=(dir,explicit='HEAD')=>resolveTreeCommit({repoDir:dir,commit:explicit}).commitSha;

export async function buildInventory({dir,repo,commit='HEAD',dispositions=null}) {
  const snapshot=snapshotManifest({repoDir:dir,repo,commit});
  const adapters=await createSourceAdapters(snapshot);
  const result=enumerateInventory({...snapshot,adapters,dispositions,requireSemanticReview:true});
  const byId=new Map(result.units.map(unit=>[unit.unitId,unit]));
  const selected=(result.selection?.selected || []).map(id=>byId.get(id));
  return {...result,schemaVersion:2,kind:'oracle-source-inventory',commit:result.commitSha,
    selected,selectedCount:selected.length,strata:result.selection?.allocations || [],
    coverage:{filesTotal:result.entries.length,entries:result.entries},
    // Persist exact accounting for semantic disposition and reproducible subsequent runs.
    snapshot:snapshot.manifest};
}
/** Reconstruct authoritative selection from pinned Git objects, never from caller completeness flags. */
export async function verifyInventory(inventory, dir) {
  if (inventory?.schemaVersion !== 2 || inventory.kind !== 'oracle-source-inventory') {
    throw new Error('unsupported inventory schema; historical inventories are diagnostic only');
  }
  if (!inventory.inventoryComplete || inventory.requireSemanticReview !== true || !inventory.selected?.length) {
    throw new Error('source inventory requires complete semantic disposition before label production');
  }
  const dispositions = { schemaVersion: 1, kind: 'oracle-source-dispositions', repo: inventory.repo,
    commitSha: inventory.commitSha, treeSha: inventory.treeSha, entries: inventory.dispositionRows };
  const actual = await buildInventory({ dir, repo: inventory.repo, commit: inventory.commitSha, dispositions });
  if (!isDeepStrictEqual(actual, inventory)) throw new Error('inventory differs from authoritative pinned source accounting');
  return actual;
}
const arg=(args,key)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
export async function main(args=process.argv.slice(2)) {
  const dir=arg(args,'--dir'), repo=arg(args,'--repo');
  if(!dir||!repo){process.stderr.write('Usage: source-units.mjs --dir <git repository> --repo <name> [--commit <sha>] [--dispositions <json>] [--out <json>]\n');return 64;}
  const dispositionFile=arg(args,'--dispositions');
  const inventory=await buildInventory({dir:path.resolve(dir),repo,commit:arg(args,'--commit')||'HEAD',
    dispositions:dispositionFile?JSON.parse(fs.readFileSync(dispositionFile,'utf8')):null});
  const json=JSON.stringify(inventory,null,2)+'\n'; const out=arg(args,'--out');
  if(out)fs.writeFileSync(out,json);else process.stdout.write(json);
  process.stderr.write(`[source-units] ${repo}@${inventory.commit}: complete=${inventory.inventoryComplete}, U=${inventory.U}, candidates=${inventory.enumeratedU}\n`);
  return inventory.inventoryComplete?0:2;
}
function direct(){try{return process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url));}catch{return false;}}
if(direct()) {try{process.exitCode=await main();}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}}
