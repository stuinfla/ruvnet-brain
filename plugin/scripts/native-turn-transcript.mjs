/** Bounded, mechanical Codex JSONL normalization. No model inference or user-text persistence. */
const LIMIT = 2 * 1024 * 1024;
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => ['text', 'Text', 'input_text', 'output_text'].includes(part?.type)).map(part => part.text || '').join('\n') : '';
const message = (role, content) => ({ type: role, message: { role, content } });
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

const TOOL_ITEMS = new Set(['CommandExecution', 'FileChange', 'McpToolCall']);
const toolItem = record => record?.type === 'event_msg' && record.payload?.type === 'item_completed'
  && TOOL_ITEMS.has(record.payload.item?.type) && typeof record.payload.item.id === 'string';
const startOf = record => Number.isFinite(record.payload.started_at_ms) ? record.payload.started_at_ms : NaN;
const endOf = record => Number.isFinite(record.payload.completed_at_ms) ? record.payload.completed_at_ms : NaN;

/**
 * Native item records (#423) are written at completion, so concurrent items arrive in completion order.
 * Each contiguous run is put back in start order; an item without timings, or whose interval overlaps
 * another item, keeps its record but its result becomes `unknown` and can never count as a passing check.
 */
function orderToolItems(records) {
  const items = records.filter(toolItem);
  const uncertain = new Set(items.filter((r, i) => !(startOf(r) <= endOf(r))
    || items.some((o, j) => j !== i && startOf(o) < endOf(r) && startOf(r) < endOf(o))));
  const out = [];
  for (let i = 0; i < records.length;) {
    if (!toolItem(records[i])) { out.push(records[i++]); continue; }
    const run = [];
    while (i < records.length && toolItem(records[i])) run.push(records[i++]);
    out.push(...run.sort((a, b) => (startOf(a) || 0) - (startOf(b) || 0)));
  }
  return { ordered: out, uncertain, itemized: items.length > 0 };
}

function toolItemLines(record, uncertain) {
  const item = record.payload.item;
  const status = uncertain ? 'unknown' : item.status;
  if (item.type === 'FileChange') {
    return [message('assistant', [{ type: 'tool_use', id: item.id, name: 'apply_patch', input: { input: '' } }])];
  }
  if (item.type === 'McpToolCall') {
    // A completed transport is not a successful tool: CallToolResult.isError:true (a failed run_tests) is a failure,
    // and the field is kept on the result so no reader can mistake it for success (cross-vendor review D, 4.7.21).
    const toolFailed = item.result?.isError === true;
    return [message('assistant', [{ type: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: {} }]),
      message('user', [{ type: 'tool_result', tool_use_id: item.id, status, ...(toolFailed ? { isError: true } : {}),
        is_error: item.status !== 'completed' || Boolean(item.error) || toolFailed,
        content: item.result === undefined ? '' : JSON.stringify(item.result) }])];
  }
  const argv = Array.isArray(item.command) ? item.command : [item.command];
  // `[shell, -lc, script]` runs `script`; any other argv is the command line itself.
  const command = argv.length === 3 && /^-l?c$/.test(String(argv[1])) ? String(argv[2]) : argv.map(String).join(' ');
  return [message('assistant', [{ type: 'tool_use', id: item.id, name: 'Bash', input: { command } }]),
    message('user', [{ type: 'tool_result', tool_use_id: item.id, status, ...(Number.isSafeInteger(item.exit_code) ? { exit_code: item.exit_code } : {}),
      content: typeof item.aggregated_output === 'string' ? item.aggregated_output : '' }])];
}

/**
 * Code-mode `exec` calls whose call record and output record bracket at least one native tool item: Codex records
 * the items an exec script runs between that exec's call and its output (rollouts on the owner's Mac, codex-cli
 * 0.164). An item carries no call id, so the bracket is the only pairing there is; anything else is opaque.
 */
function pairedExecCalls(ordered) {
  const paired = new Set();
  ordered.forEach((record, i) => {
    const p = record?.payload;
    if (record?.type !== 'response_item' || p?.type !== 'custom_tool_call' || p.name !== 'exec' || typeof p.call_id !== 'string') return;
    const end = ordered.findIndex((r, j) => j > i && r?.type === 'response_item' && r.payload?.type === 'custom_tool_call_output'
      && r.payload.call_id === p.call_id);
    if (end > i && ordered.slice(i + 1, end).some(toolItem)) paired.add(p.call_id);
  });
  return paired;
}

/** Keep call IDs intact; torn/unknown records cannot manufacture successful tool evidence. */
export function nativeTurnLines(lines, host) {
  if (host !== 'codex') return lines;
  const records = []; let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(String(lines[i]));
    if (bytes > LIMIT) break;
    const record = parse(lines[i]); if (record) records.push(record);
  }
  records.reverse();
  const { ordered, uncertain, itemized } = orderToolItems(records);
  const paired = pairedExecCalls(ordered);
  const out = []; const sessions = new Map(); const calls = new Map();
  // Codex writes the same answer up to three times (response_item, item_completed AgentMessage,
  // task_complete.last_agent_message); any one of them may be the only copy that survived.
  let said = new Set();
  const say = (role, value) => {
    if (role === 'user') said = new Set();
    else if (said.has(value.trim())) return;
    else said.add(value.trim());
    out.push(message(role, value));
  };
  for (const record of ordered) {
    const p = record.payload;
    if (toolItem(record)) {
      if (!calls.has(p.item.id)) out.push(...toolItemLines(record, uncertain.has(record)));
      continue;
    }
    if (record.type === 'event_msg' && p?.type === 'user_message') {
      say('user', p.message || ''); continue;
    }
    if (record.type === 'event_msg' && p?.type === 'agent_message' && typeof p.message === 'string') {
      say('assistant', p.message); continue;
    }
    // Native turn end (rollout and `codex exec`): the closing answer, recorded once per turn.
    if (record.type === 'event_msg' && p?.type === 'task_complete' && typeof p.last_agent_message === 'string') {
      say('assistant', p.last_agent_message); continue;
    }
    if (record.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'AgentMessage') {
      say('assistant', text(p.item.content)); continue;
    }
    if (record.type !== 'response_item' || !p) continue;
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      say(p.role, text(p.content)); continue;
    }
    // A code-mode `exec` script's actions are the native items mapped above, but only an exec PROVABLY paired with
    // them (review r2, 4.7.21) is dropped; an opaque one (no item inside its call/output bracket, or no output yet)
    // stays a tool call named `exec`, which the audit counts as a possible change (fail toward asking).
    if (itemized && paired.has(p.call_id) && ['custom_tool_call', 'custom_tool_call_output'].includes(p.type)) continue;
    if (itemized && p.type === 'custom_tool_call_output' && !calls.has(p.call_id)) continue;
    if (['function_call', 'custom_tool_call'].includes(p.type) && typeof p.call_id === 'string') {
      const args = typeof p.arguments === 'string' ? parse(p.arguments) : p.arguments;
      let name = String(p.name || '').split('.').at(-1); let input = args || {};
      if (name === 'exec_command' && typeof args?.cmd === 'string') { name = 'Bash'; input = { command: args.cmd }; }
      if (name === 'apply_patch') input = { input: p.input || '' };
      if (name === 'write_stdin' && sessions.has(args?.session_id)) {
        name = 'Bash'; input = { command: sessions.get(args.session_id) };
      }
      calls.set(p.call_id, { name, input });
      out.push(message('assistant', [{ type: 'tool_use', id: p.call_id, name, input }]));
    } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && typeof p.call_id === 'string') {
      const result = typeof p.output === 'string' ? parse(p.output) : p.output;
      const call = calls.get(p.call_id);
      if (Number.isSafeInteger(result?.session_id) && call?.name === 'Bash') sessions.set(result.session_id, call.input.command);
      // Native structured exit fields are retained; opaque text is never guessed to be a pass.
      out.push(message('user', [{ ...(result && typeof result === 'object' ? result : {}),
        type: 'tool_result', tool_use_id: p.call_id, content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '') }]));
    }
  }
  return out.map(record => JSON.stringify(record));
}
