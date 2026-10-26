// The REAL issue-watch CLI, as launchd runs it under job-heartbeat.sh: a person's issue that can never be read must fail
// the run ONCE (so the wrapper pages), not exit 0 forever (4.7.21 review, Opus pager #4). gh is a stub on GH_BIN;
// NTFY_TOPIC="" so nothing can be sent anywhere.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'issue-watch.mjs');
const temps = [];
afterEach(() => temps.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe.skipIf(process.platform === 'win32')('issue-watch exit code for a permanently unreadable issue', () => {
  it('exits 0, 0, 1, 0, 0 over five runs (before: 0 every run)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-watch-exit-'));
    temps.push(dir);
    // #903 reads fine, so the run is "degraded", not "all unreadable" (which already exits 1 every run).
    const issues = [{ number: 902, title: 'unreadable', createdAt: new Date(Date.now() - 3600_000).toISOString(), author: { login: 'alice' } },
      { number: 903, title: 'readable', createdAt: new Date(Date.now() - 3600_000).toISOString(), author: { login: 'stuinfla' } }];
    fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify(issues));
    const gh = path.join(dir, 'gh');
    fs.writeFileSync(gh, `#!/bin/sh
case "$1 $2" in
  "issue list") cat ${JSON.stringify(path.join(dir, 'issues.json'))} ;;
  "issue view") if [ "$3" = 903 ]; then echo '{"comments":[]}'; else echo "GraphQL: Something went wrong (HTTP 500)" >&2; exit 1; fi ;;
  *) echo '[]' ;;
esac
`, { mode: 0o755 });
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, GH_BIN: gh, NTFY_TOPIC: '', ISSUE_WATCH_STATE: path.join(dir, 'state.json') } });
      codes.push(r.status);
      if (i === 2) expect(r.stderr).toMatch(/unreadable 3 runs in a row.*#902/);
    }
    expect(codes).toEqual([0, 0, 1, 0, 0]);
  });
});
