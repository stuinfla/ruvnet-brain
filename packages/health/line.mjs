// Renders a verdict as the one line the AI sees on every prompt (at most 160 characters).
import { LINE_MAX } from '../contract/constants.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(ymd);
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export function renderLine(v) {
  let line;
  if (v.state === 'ok') line = `[RuvNet Brain OK · knowledge of ${shortDate(v.knowledgeDate)} · search_ruvnet ready]`;
  else {
    const since = v.since ? ` since ${clock(v.since)}` : '';
    line = `[RuvNet Brain ${v.label}${since} · ${v.reason} · fix: ${v.fix}]`;
  }
  return line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 2)}…]`;
}
