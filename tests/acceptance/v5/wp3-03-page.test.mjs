// WP3-03 owner page damping, through the page module against a local HTTP stub (no outside network):
// no page on the first failure; a page once the state has been DOWN at two checks five minutes
// apart; at most one page per six hours; one recovery note when it is OK again, and only once; a
// blip that recovers inside five minutes sends nothing; paging off sends nothing; a failing topic
// never throws into the caller. The clock is simulated; the status file is rewritten at each check.
// Break: page on the first failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { failedProbe, status, wp3 } from './wp3-helpers.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;

async function stub(t, code = 200) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push(body);
      res.writeHead(code).end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/topic`, got };
}

test('WP3-03 a page after two failures five minutes apart, once per six hours, one recovery note', { timeout: 60_000 }, async (t) => {
  const { mod, livePid, home } = wp3(t, 'wp3-03');
  const { pageCheck } = await mod('page.mjs');
  const topic = await stub(t);
  const pid = livePid();
  const run = async (h, at, down) => {
    fs.writeFileSync(path.join(h, 'state', 'status', `${pid}.json`), JSON.stringify(status(pid, at, down ? { probe: failedProbe(at) } : {})));
    return pageCheck({ home: h, now: at });
  };
  const sent = async (...a) => (await run(...a)).sent;
  const t0 = Date.parse('2026-11-17T08:00:00Z');
  const h = home({ servers: [status(pid, t0)], config: { pageTopic: topic.url } });
  const steps = [
    [0, true, null, 'no page on the first failure'],
    [4 * MIN, true, null, 'no page before five minutes'],
    [5 * MIN, true, 'down', 'a page once DOWN has lasted five minutes'],
    [10 * MIN, true, null, 'no second page while it stays down'],
    [5 * MIN + 6 * HOUR - MIN, true, null, 'no second page inside six hours'],
    [5 * MIN + 6 * HOUR, true, 'down', 'a second page after six hours'],
    [7 * HOUR, false, 'recovered', 'one recovery note'],
    [7 * HOUR + MIN, false, null, 'the recovery note only once'],
    [8 * HOUR, true, null, 'a new outage: no page on its first failure'],
    [8 * HOUR + 5 * MIN, true, null, 'no page inside six hours of the last one'],
  ];
  for (const [dt, down, want, what] of steps) assert.equal(await sent(h, t0 + dt, down), want, what);
  assert.equal(topic.got.length, 3, `exactly three requests reached the topic: ${JSON.stringify(topic.got)}`);
  assert.match(topic.got[0], /^\[RuvNet Brain DOWN since .* · fix: ruvnet-brain install --repair\]$/, 'the page is the health line');
  assert.match(topic.got[2], /^\[RuvNet Brain OK /, 'the recovery note is the OK line');

  const blip = home({ servers: [status(pid, t0)], config: { pageTopic: topic.url } });
  assert.equal(await sent(blip, t0, true), null);
  assert.equal(await sent(blip, t0 + 2 * MIN, false), null, 'a blip that recovers sends no recovery note');
  assert.equal(await sent(blip, t0 + 10 * MIN, true), null, 'a failure after a recovery starts the five minutes again');
  assert.equal(topic.got.length, 3, 'a blip sends nothing');

  const off = home({ servers: [status(pid, t0)] });
  for (const dt of [0, 5 * MIN, 10 * MIN]) assert.equal(await sent(off, t0 + dt, true), null, 'paging is off without a topic');
  assert.equal(topic.got.length, 3, 'paging off sends nothing');

  const broken = await stub(t, 500);
  const bad = home({ servers: [status(pid, t0)], config: { pageTopic: broken.url } });
  await run(bad, t0, true);
  const r = await run(bad, t0 + 5 * MIN, true);
  assert.equal(r.sent, 'down');
  assert.match(r.error, /HTTP 500/, 'a failing topic is recorded, not thrown');
});
