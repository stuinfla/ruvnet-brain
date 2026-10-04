import { test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readCodexAllowance, sanitizeAllowance } from '../../scripts/native-subscription-usage.mjs';

function fakeHost(result) {
  const requests=[];
  const child=new EventEmitter(); child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.kill=vi.fn(); child.stdin={end:vi.fn(),write:line=>{
    const request=JSON.parse(line);requests.push(request);
    if(request.id) queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({id:request.id,result:request.id===1?{}:result})+'\n'));
  }};
  return {child,requests,spawnHost:vi.fn(()=>child)};
}

test('fresh ordinary allowance probe uses native metadata only, Standard explicitly, no thread/inference call',async()=>{
  const host=fakeHost({ordinaryUsageAllowed:true,credits:{hasCredits:true,balance:'secret'},accountId:'private-account'});
  const result=await readCodexAllowance({spawnHost:host.spawnHost});
  expect(result).toMatchObject({ordinaryUsageAllowed:true,reservation:false,raceSafe:false});
  expect(JSON.stringify(result)).not.toContain('private-account');
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(host.requests.map(r=>r.method)).toEqual(['initialize','initialized','account/rateLimits/read']);
  expect(host.requests[2].params).toEqual({excludeResetCreditDetails:true,supportsLunaReserve:false});
  expect(host.spawnHost.mock.calls[0][1]).toContain('service_tier="default"');
  expect(host.spawnHost.mock.calls[0][1]).toContain('features.fast_mode=false');
  expect(host.child.kill).toHaveBeenCalled();
});
test('credits or missing allowance never authorize ordinary usage',async()=>{
  expect(()=>sanitizeAllowance({ordinaryUsageAllowed:false,credits:{hasCredits:true}})).toThrow('no credit fallback');
  expect(()=>sanitizeAllowance({credits:{hasCredits:true}})).toThrow('unavailable');
  const host=fakeHost({ordinaryUsageAllowed:false,rateLimits:{credits:{hasCredits:true}}});
  await expect(readCodexAllowance({spawnHost:host.spawnHost})).rejects.toThrow('no credit fallback');
});
test('failed or hanging native probe blocks dispatch and cleans up',async()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin={write:vi.fn(),end:vi.fn()};child.kill=vi.fn();
  await expect(readCodexAllowance({spawnHost:()=>child,timeoutMs:10})).rejects.toThrow('timed out');
  expect(child.kill).toHaveBeenCalled();
});
