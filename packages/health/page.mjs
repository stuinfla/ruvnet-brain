// Owner page (opt-in): a phone notification when the verdict has been DOWN at two checks at least
// five minutes apart, at most one page per six hours, and one recovery note once it is OK again.
// Off unless state/config.json has `pageTopic` (an https address that accepts a POST, e.g. ntfy).
// The server calls it after each heartbeat:  pageCheck({ home }).catch(() => {});
// It never throws into its caller and never blocks a search.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readConfig, readJson, writeJsonAtomic } from '../contract/home.mjs';
import { assessHome } from './assess.mjs';
import { renderLine } from './line.mjs';

export const PAGE_DEFAULTS = { pageAfterMs: 5 * 60_000, pageEveryMs: 6 * 3_600_000 };
const LOCK_STALE_MS = 30_000;

async function post(url, text) {
  const res = await fetch(url, { method: 'POST', body: text, headers: { Title: 'RuvNet Brain' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function lock(file, now) {
  try {
    fs.writeFileSync(file, String(now), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (now - Number(fs.readFileSync(file, 'utf8')) > LOCK_STALE_MS) fs.unlinkSync(file);
    } catch {}
    return false;
  }
}

/** One damped decision. Returns { sent: 'down' | 'recovered' | null, error? }. */
export async function pageCheck({ home, now = Date.now(), send = post } = {}) {
  try {
    const cfg = { ...PAGE_DEFAULTS, ...readConfig(home) };
    if (!cfg.pageTopic) return { sent: null, reason: 'paging is off' };
    const file = path.join(paths(home).state, 'page.json');
    const lockFile = `${file}.lock`;
    fs.mkdirSync(paths(home).state, { recursive: true });
    if (!lock(lockFile, now)) return { sent: null, reason: 'another server is deciding' };
    try {
      const st = readJson(file, {});
      const v = assessHome(home, { now });
      let msg = null;
      let kind = null;
      if (v.state === 'down' && v.label === 'DOWN') {
        st.downSince ??= now;
        if (now - st.downSince >= cfg.pageAfterMs && (!st.pagedAt || now - st.pagedAt >= cfg.pageEveryMs)) {
          msg = renderLine(v);
          kind = 'down';
          st.pagedAt = now;
          st.owesRecovery = true;
        }
      } else if (v.state === 'ok') {
        if (st.owesRecovery) {
          msg = renderLine(v);
          kind = 'recovered';
          st.owesRecovery = false;
        }
        st.downSince = null;
      }
      let error = null;
      if (msg) {
        try {
          await send(cfg.pageTopic, msg);
        } catch (e) {
          error = String(e?.message ?? e);
        }
        st.last = { kind, at: now, error };
      }
      writeJsonAtomic(file, st);
      return { sent: kind, error };
    } finally {
      fs.rmSync(lockFile, { force: true });
    }
  } catch (e) {
    return { sent: null, error: String(e?.message ?? e) };
  }
}
