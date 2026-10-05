import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { COMPATIBILITY, applyCompatibilityPatch, repairSecurityGuidance } from '../../scripts/security-guidance-codex-compat.mjs';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = 'plugins/cache/claude-plugins-official/security-guidance/2.0.9/hooks/security_reminder_hook.py';
const installed = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), relative);
// Source-bound acceptance uses the actual public plugin source, never executes its main.
// CI without this external plugin still exercises refusal paths; it cannot claim installed acceptance.
let original;
for (const file of [process.env.SECURITY_GUIDANCE_COMPAT_TEST_SOURCE, installed, `${installed}.${COMPATIBILITY.originalSha256}.original`].filter(Boolean)) {
  if (fs.existsSync(file)) {
    const bytes = fs.readFileSync(file);
    if (digest(bytes) === COMPATIBILITY.originalSha256) { original = bytes; break; }
  }
}
const roots = [];
function fixture(bytes = Buffer.from('# unfamiliar source\n')) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'security-guidance-compat-'));
  roots.push(root);
  const codexHome = path.join(root, '.codex');
  const target = path.join(codexHome, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { mode: 0o640 });
  return { root, codexHome, target };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('source-gated Codex security-guidance compatibility repair', () => {
  it('refuses unfamiliar source, symlink files/ancestors, and the separate Claude cache', () => {
    const fx = fixture();
    expect(() => repairSecurityGuidance({ codexHome: fx.codexHome, apply: true })).toThrow(/Unknown.*source/);
    expect(fs.readFileSync(fx.target, 'utf8')).toBe('# unfamiliar source\n');
    const outside = path.join(fx.root, 'outside.py'); fs.renameSync(fx.target, outside);
    fs.symlinkSync(outside, fx.target);
    expect(() => repairSecurityGuidance({ codexHome: fx.codexHome, apply: true })).toThrow(/symlink/);
    fs.unlinkSync(fx.target); fs.renameSync(outside, fx.target);
    const renamed = `${fx.codexHome}-real`; fs.renameSync(fx.codexHome, renamed); fs.symlinkSync(renamed, fx.codexHome);
    expect(() => repairSecurityGuidance({ codexHome: fx.codexHome })).toThrow(/symlink/);
    expect(() => repairSecurityGuidance({ codexHome: path.join(fx.root, '.claude'), apply: true })).toThrow(/Claude/);
    expect(fs.readdirSync(path.dirname(path.join(renamed, relative)))).toEqual(['security_reminder_hook.py']);
  });

  it.skipIf(!original)('defaults to dry run, applies atomically with a read-only backup, preserves mode and is idempotent', () => {
    const fx = fixture(original);
    const claude = path.join(fx.root, '.claude', relative);
    fs.mkdirSync(path.dirname(claude), { recursive: true }); fs.writeFileSync(claude, 'separate host');
    const beforeStat = fs.statSync(fx.target);
    expect(repairSecurityGuidance({ codexHome: fx.codexHome }).status).toBe('dry-run');
    expect(fs.statSync(fx.target).ino).toBe(beforeStat.ino);
    expect(fs.readdirSync(path.dirname(fx.target))).toEqual(['security_reminder_hook.py']);
    const receipt = repairSecurityGuidance({ codexHome: fx.codexHome, apply: true });
    expect(receipt.status).toBe('patched');
    expect(digest(fs.readFileSync(fx.target))).toBe(COMPATIBILITY.patchedSha256);
    expect(fs.statSync(fx.target).mode & 0o777).toBe(beforeStat.mode & 0o777);
    expect(fs.statSync(fx.target).ino).not.toBe(beforeStat.ino);
    expect(fs.readFileSync(receipt.backup)).toEqual(original);
    expect(fs.statSync(receipt.backup).mode & 0o222).toBe(0);
    const backupStat = fs.statSync(receipt.backup); const patchedStat = fs.statSync(fx.target);
    expect(repairSecurityGuidance({ codexHome: fx.codexHome, apply: true }).status).toBe('already-patched');
    expect(fs.statSync(receipt.backup).ino).toBe(backupStat.ino);
    expect(fs.statSync(fx.target).ino).toBe(patchedStat.ino);
    expect(fs.readFileSync(claude, 'utf8')).toBe('separate host');
    expect(fs.readdirSync(path.dirname(fx.target)).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it.skipIf(!original)('refuses to overwrite a corrupt existing backup', () => {
    const fx = fixture(original);
    const backup = `${fx.target}.${COMPATIBILITY.originalSha256}.original`;
    fs.writeFileSync(backup, 'bad backup');
    expect(() => repairSecurityGuidance({ codexHome: fx.codexHome, apply: true })).toThrow(/backup digest mismatch/);
    expect(fs.readFileSync(fx.target)).toEqual(original);
    expect(fs.readFileSync(backup, 'utf8')).toBe('bad backup');
  });

  it.skipIf(!original)('runs only actual AST-selected emitters: rejects original telemetry and preserves controls, context and other events after patch', () => {
    const patched = applyCompatibilityPatch(original);
    const program = String.raw`
import ast,contextlib,io,json,sys
sources=json.load(sys.stdin)
def load(source,patched):
    tree=ast.parse(source)
    functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ('emit_metrics','_emit_codex_json')]
    logs=[]
    env={'json':json,'sys':sys,'_PV':0,'_usage_metrics':lambda:{},'debug_log':logs.append,'_CODEX_POST_TOOL_USE':patched}
    exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-plugin-emitters','exec'),env)
    return env,logs,tree
def capture(fn,*args,**kw):
    out=io.StringIO()
    with contextlib.redirect_stdout(out):fn(*args,**kw)
    return out.getvalue()
old,_,oldtree=load(sources['original'],False)
new,logs,newtree=load(sources['patched'],True)
baseline=capture(old['emit_metrics'],{'skipped':True},rewake_summary='review',additional_context='Unsafe operation')
fixed=capture(new['emit_metrics'],{'skipped':True},rewake_summary='review',additional_context='Unsafe operation')
telemetry=capture(new['_emit_codex_json'],{'metrics':{'bash_hook_dedup':True}})
controls={'decision':'block','reason':'unsafe','continue':False,'stopReason':'security','suppressOutput':False,'systemMessage':'Review required','hookSpecificOutput':{'hookEventName':'PostToolUse','additionalContext':'findings'}}
blocked=capture(new['_emit_codex_json'],dict(controls,metrics={'review':1},rewakeSummary='review'))
new['_CODEX_POST_TOOL_USE']=False
otherOld=capture(old['emit_metrics'],{'skipped':True},rewake_summary='review',hook_event_name='Stop')
otherNew=capture(new['emit_metrics'],{'skipped':True},rewake_summary='review',hook_event_name='Stop')
prints=lambda tree:[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='print']
redirects=[n for n in ast.walk(newtree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='_emit_codex_json']
# Compare the entire actual source AST after reversing only the output-boundary changes.
# This checks review conditions, dedup, state handling, and all other logic without running them.
class ReverseBoundary(ast.NodeTransformer):
    def visit_FunctionDef(self,node):
        if node.name=='_emit_codex_json':return None
        return self.generic_visit(node)
    def visit_Global(self,node):
        if node.names==['_CODEX_POST_TOOL_USE']:return None
        return node
    def visit_Assign(self,node):
        if len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id=='_CODEX_POST_TOOL_USE':return None
        return self.generic_visit(node)
    def visit_Call(self,node):
        node=self.generic_visit(node)
        if isinstance(node.func,ast.Name) and node.func.id=='_emit_codex_json':
            node.func=ast.Name(id='print',ctx=ast.Load())
            node.args=[ast.Call(func=ast.Attribute(value=ast.Name(id='json',ctx=ast.Load()),attr='dumps',ctx=ast.Load()),args=node.args,keywords=[])]
        return node
reversedTree=ReverseBoundary().visit(ast.parse(sources['patched']))
logicUnchanged=ast.dump(reversedTree)==ast.dump(oldtree)
print(json.dumps({'baseline':json.loads(baseline),'fixed':json.loads(fixed),'telemetry':telemetry,'blocked':json.loads(blocked),'controls':controls,'otherOld':otherOld,'otherNew':otherNew,'originalPrintSites':len(prints(oldtree)),'patchedPrintSites':len(prints(newtree)),'redirects':len(redirects),'telemetryEntries':len(logs),'logicUnchanged':logicUnchanged}))
`;
    const result = spawnSync('python3', ['-c', program], { input: JSON.stringify({ original: original.toString(), patched: patched.toString() }), encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout);
    // Installed Codex 0.160.0 denies unknown top-level fields. This is an emitter
    // contract check, not a claim of native hook execution.
    const accepted = new Set(['continue', 'decision', 'hookSpecificOutput', 'reason', 'stopReason', 'suppressOutput', 'systemMessage']);
    expect(Object.keys(evidence.baseline).filter((key) => !accepted.has(key))).toEqual(['metrics', 'rewakeSummary']);
    expect(Object.keys(evidence.fixed).every((key) => accepted.has(key))).toBe(true);
    expect(evidence.fixed.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: 'Unsafe operation' });
    expect(evidence.telemetry).toBe('');
    expect(evidence.blocked).toEqual(evidence.controls);
    expect(evidence.otherNew).toBe(evidence.otherOld);
    expect(evidence.originalPrintSites).toBe(4);
    expect(evidence.patchedPrintSites).toBe(1);
    expect(evidence.redirects).toBe(4);
    expect(evidence.telemetryEntries).toBe(3);
    expect(evidence.logicUnchanged).toBe(true);
  });
});
