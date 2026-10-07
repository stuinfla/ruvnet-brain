import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPracticalCatalog, selectPracticalRules, practicalSelectionReceipt, RULE_PHASES } from '../../scripts/practical-rule-selector.mjs';

test('source projection contains exactly 100 approved actions and binds the full revision-three audit', () => {
  const {data} = loadPracticalCatalog();
  assert.equal(data.rules.length, 100); assert.equal(new Set(data.rules.map(r=>r.id)).size, 100);
  assert.equal(data.auditSha256, '19cf1894a6aaa2997bc4adcf6973cb70a33bcaed4db2bf6b1d1034842f46382d');
  assert.ok(data.rules.every(r=>r.cohort==='approved-practical' && r.sourceRuleIds.length));
  assert.equal(data.rules.find(r=>r.id==='P100').mechanismMapping.missingImplementation, true);
  assert.ok(data.rules.every(r=>r.mechanismMapping.registrationRequested===false));
});

test('release and deletion scope select applicable subsets instead of unrelated model/learning rules', () => {
  const release = selectPracticalRules({phase:'release',actions:['publish'],maxRules:12,maxContextBytes:8192});
  assert.ok(release.selectedIds.includes('P084')); assert.equal(release.selectedIds.includes('P009'),false);
  const deletion = selectPracticalRules({phase:'mutation',actions:['delete'],maxRules:12,maxContextBytes:8192});
  assert.ok(deletion.selectedIds.includes('P009')); assert.equal(deletion.selectedIds.includes('P084'),false);
  assert.equal(deletion.enforcement,'NOT_ASSERTED_BY_SELECTOR'); assert.equal(deletion.delivery,'ADVISORY_ONLY');
});

test('unknown phase/action is explicit and never loads all rules or emits broad guidance', () => {
  for(const input of [{phase:'unknown',actions:[]},{phase:'planning',actions:['invented-action']}]) {
    const result = selectPracticalRules(input); assert.equal(result.context,''); assert.deepEqual(result.selectedIds,[]);
    assert.match(result.status,/UNKNOWN/);
  }
});

test('tight UTF-8 context budgets retain every applicable omitted ID as deferred receipt metadata', () => {
  const full = selectPracticalRules({phase:'planning',actions:['implementation','memory-recall','model-call'],maxRules:12,maxContextBytes:8192});
  const tiny = selectPracticalRules({phase:'planning',actions:['implementation','memory-recall','model-call'],maxRules:2,maxContextBytes:512});
  assert.ok(Buffer.byteLength(tiny.context)<=512); assert.ok(tiny.selectedIds.length<=2);
  assert.deepEqual([...tiny.selectedIds,...tiny.deferredIds].sort(),[...full.selectedIds,...full.deferredIds].sort());
  assert.equal(tiny.context.includes('deferredIds'),false);
  assert.ok(practicalSelectionReceipt(tiny).deferredIds.length);
});

test('proposed/vendor rows cannot enter selection and core is independent of native host identity', () => {
  const catalog = structuredClone(loadPracticalCatalog());
  for(const cohort of ['proposed-design','vendor-capability','rejected']) catalog.data.rules.push({...catalog.data.rules[0],id:'P999',cohort});
  for(const phase of RULE_PHASES) {
    const result = selectPracticalRules({phase,actions:['implementation','write','publish'],maxRules:12,maxContextBytes:8192},catalog);
    assert.equal(result.selectedIds.includes('P999'),false);
  }
  const a=selectPracticalRules({phase:'checks',actions:['check'],host:'codex'}),b=selectPracticalRules({phase:'checks',actions:['check'],host:'claude'});
  assert.deepEqual(a,b);
  assert.equal(fs.readFileSync(new URL('../../scripts/practical-rule-selector.mjs',import.meta.url),'utf8').includes('child_process'),false);
});

test('default source catalog is immutable and rejected input cannot expand receipt context', () => {
  const catalog = loadPracticalCatalog();
  assert.equal(Object.isFrozen(catalog.data.rules[0]), true);
  assert.throws(() => { catalog.data.rules[0].cohort = 'vendor-capability'; }, TypeError);
  const unknown = selectPracticalRules({phase:'x'.repeat(100000),actions:Array(1000).fill('write')});
  assert.equal(unknown.phase,null); assert.deepEqual(unknown.actions,[]); assert.equal(unknown.context,'');
  assert.ok(JSON.stringify(practicalSelectionReceipt(unknown)).length < 600);
  assert.ok(catalog.data.rules.every(rule => rule.mechanismMapping.newHookRequired === 'NOT_DETERMINED_BY_CATALOG'));
});
