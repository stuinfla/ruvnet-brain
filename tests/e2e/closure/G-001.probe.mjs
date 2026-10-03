import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, fileBytes, outcome } from '../../helpers/turn-capture-process.mjs';
const f = fixture();
try {
  f.initialize();
  const token = `ghp_${'SYNTHETIC'.repeat(5)}`;
  const result = f.stop({ message: `${outcome} Synthetic credential ${token}`, extra: { session_id: token } });
  const receipt = await f.wait(result.key);
  assert.equal(receipt.verified, true);
  const content = f.retrieve(result.key);
  assert.ok(content.includes('Verified the synthetic repair'));
  assert.ok(content.includes('[REDACTED:token]'));
  for (const bytes of [...fileBytes(f.home), ...fileBytes(path.join(f.project, '.swarm'))]) assert.equal(bytes.includes(Buffer.from(token)), false, 'raw token reached disk or argv log');
  const breadcrumb = JSON.parse(fs.readFileSync(path.join(f.project, '.swarm', 'agentdb-turns.jsonl'), 'utf8').trim());
  assert.deepEqual(Object.keys(breadcrumb).sort(), ['hash', 'key', 'len', 'ts']);
  f.policy({ [f.project]: 'off' });
  assert.match(f.stop({ message: `${outcome} Changed after policy write.` }).skipped, /persisted.*opt-out/);
  f.policy({}, { [f.project]: 'off' });
  assert.match(f.stop({ message: `${outcome} Changed after path policy write.` }).skipped, /persisted.*opt-out/);
  f.policy([], {});
  assert.match(f.stop().skipped, /policy unreadable or invalid/);
  f.policy({}, 'off');
  assert.match(f.stop().skipped, /policy unreadable or invalid/);
  console.log(JSON.stringify({ malformedConsentFailsClosed: true, gap: 'G-001', evidenceClass: 'EXECUTED', verified: true, rawTokenBytes: 0, breadcrumbFields: Object.keys(breadcrumb), liveProjectAndPathOptOut: true }));
} finally { f.cleanup(); }
