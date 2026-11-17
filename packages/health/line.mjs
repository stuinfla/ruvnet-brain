// Renders a verdict as the one line the AI sees on every prompt: one line, at most 160 characters,
// state, since-time, one reason and one command. A long reason is shortened, never the fix.
import { LINE_MAX } from '../contract/constants.mjs';
import { brainHome } from '../contract/home.mjs';
import { assessHome } from './assess.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(ymd);
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function renderLine(v) {
  if (v.state === 'ok') return `[RuvNet Brain OK · knowledge of ${shortDate(v.knowledgeDate)} · search_ruvnet ready]`.slice(0, LINE_MAX);
  const head = `[RuvNet Brain ${v.label}${v.since ? ` since ${clock(v.since)}` : ''} · `;
  const tail = ` · fix: ${flat(v.fix)}]`;
  let reason = flat(v.reason);
  const room = LINE_MAX - head.length - tail.length;
  if (reason.length > room) reason = `${reason.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return head + reason + tail;
}

/** The verdict and its line for a brain home; the hook and doctor both start here. */
export function currentLine(home = brainHome(), { now } = {}) {
  try {
    const v = assessHome(home, { now });
    return { verdict: v, line: renderLine(v) };
  } catch (e) {
    const v = { state: 'unknown', label: 'UNKNOWN', since: null, reason: `the health evidence could not be read (${flat(e?.message ?? e)})`, fix: 'ruvnet-brain doctor', cause: 'unreadable' };
    return { verdict: v, line: renderLine(v) };
  }
}
