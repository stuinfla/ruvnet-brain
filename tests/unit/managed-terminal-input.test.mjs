import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createManagedTerminal } from '../../scripts/managed-terminal-input.mjs';

const START = '\x1b[200~', END = '\x1b[201~';
const terminals = [];
afterEach(() => terminals.splice(0).forEach(t => t.close()));
function fixture(tty = true, bounds = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = tty; input.setRawMode = mode => { input.rawMode = mode; };
  let rendered = ''; output.on('data', b => { rendered += b.toString(); });
  const priorTerm = process.env.TERM; process.env.TERM = 'xterm-256color';
  let terminal;
  try { terminal = createManagedTerminal({ input, output, ...bounds }); }
  finally { if (priorTerm === undefined) delete process.env.TERM; else process.env.TERM = priorTerm; }
  terminals.push(terminal);
  return { input, output, terminal, rendered: () => rendered };
}
async function queued(f, content) { f.input.write(content); return f.terminal.question('Prompt> '); }

it.each([true, false])('preserves exact supplied multiline bracketed paste until explicit Enter (TTY=%s)', async tty => {
  const f = fixture(tty), answer = f.terminal.question('Prompt> ');
  let settled = false; answer.then(() => { settled = true; });
  f.input.write(START + 'first line\nsecond line' + END); await Promise.resolve(); expect(settled).toBe(false);
  f.input.write('\n'); expect(await answer).toBe('first line\nsecond line');
});
it('retains every marker and UTF-8 split boundary', async () => {
  const value = 'first\n日本語 🧠\r\n\nlast\n';
  const frame = Buffer.from(START + value + END + '\n');
  for (let split = 1; split < frame.length; split++) {
    const f = fixture(); f.input.write(frame.subarray(0, split)); f.input.write(frame.subarray(split));
    expect(await f.terminal.question('Prompt> ')).toBe(value); f.terminal.close();
  }
  const f = fixture(); for (const byte of frame) f.input.write(Buffer.from([byte]));
  expect(await f.terminal.question('Prompt> ')).toBe(value);
});
it.each(['', '\n', '\n\n', 'a\r\nb\r', '\x03\x7f\x1b[D\t\x00literal'])('paste preserves empty/trailing lines and literal controls: %j', async value => {
  const f = fixture(); expect(await queued(f, START + value + END + '\n')).toBe(value);
});
it('retains Node editing for ordinary lines and allows an atomic paste at the end of a prefix', async () => {
  const f = fixture(); expect(await queued(f, 'ab\x7fc\n')).toBe('ac');
  expect(await queued(f, 'prefix:' + START + 'a\nb' + END + ' suffix\n')).toBe('prefix:a\nb suffix');
  expect(await queued(f, START + 'a\n' + END + START + 'b\n' + END + '\n')).toBe('a\nb\n');
});
it('refuses unsupported midline paste rather than silently reordering content', async () => {
  const f = fixture(); f.input.write('abc\x1b[D' + START + 'paste' + END + '\n');
  await expect(f.terminal.question('Prompt> ')).rejects.toThrow(/midline/);
});
it('retains bounded FIFO for typed and pasted prompts while a turn is busy', async () => {
  const f = fixture();
  expect(await queued(f, 'first\n')).toBe('first');
  f.input.write('second\n' + START + 'third\ncontinued' + END + '\n' + 'fourth\n');
  expect(await f.terminal.question('Prompt> ')).toBe('second');
  expect(await f.terminal.question('Prompt> ')).toBe('third\ncontinued');
  expect(await f.terminal.question('Prompt> ')).toBe('fourth');
});
it('queued yes and a partial ordinary yes begun before approval never answer it', async () => {
  const f = fixture(); f.input.write('yes\nye');
  const answer = f.terminal.question('Allow? ', { approval: true }); let settled = false; answer.then(() => { settled = true; });
  f.input.write('s\n'); await Promise.resolve(); expect(settled).toBe(false);
  f.input.write('no\n'); expect(await answer).toBe('no');
  expect(await f.terminal.question('Prompt> ')).toBe('yes'); expect(await f.terminal.question('Prompt> ')).toBe('yes');
});
it('a frame begun before approval remains ordinary even when it ends afterward', async () => {
  const f = fixture(); f.input.write(START + 'yes\n');
  const answer = f.terminal.question('Allow? ', { approval: true });
  f.input.write('additional task' + END + '\nno\n'); expect(await answer).toBe('no');
  expect(await f.terminal.question('Prompt> ')).toBe('yes\nadditional task');
});
it('paste begun during approval cannot approve, including a literal single-line yes', async () => {
  const f = fixture(), answer = f.terminal.question('Allow? ', { approval: true });
  let settled = false; answer.then(() => { settled = true; });
  f.input.write(START + 'yes' + END + '\n'); await Promise.resolve(); expect(settled).toBe(false);
  f.input.write('no\n'); expect(await answer).toBe('no');
  expect(await f.terminal.question('Prompt> ')).toBe('yes');
});
it.each([
  [START + '123456789' + END + '\n', { maxPromptBytes: 8 }, /byte limit/],
  ['one\ntwo\n', { maxQueuedPrompts: 1 }, /FIFO/],
  ['12345\n67890\n', { maxQueueBytes: 9 }, /FIFO/],
  [END + '\n', {}, /unexpected/],
  [START + 'x' + START + 'y' + END + '\n', {}, /nested/],
  [Buffer.from([0xff]), {}, /UTF-8/],
])('overlimit or malformed input fails without partial dispatch %#', async (input, bounds, error) => {
  const f = fixture(true, bounds); f.input.write(input);
  await expect(f.terminal.question('Prompt> ')).rejects.toThrow(error);
});
it.each([START + 'unfinished', '\x1b[20', START + 'closed' + END, Buffer.from([0xe2, 0x82])])('incomplete input at EOF refuses partial data %#', async data => {
  const f = fixture(); f.input.write(data); f.input.end(); await new Promise(resolve => setImmediate(resolve));
  await expect(f.terminal.question('Prompt> ')).rejects.toThrow(/incomplete/);
});
it('clean EOF preserves already submitted FIFO until exhausted', async () => {
  const f = fixture(false); f.input.end('one\ntwo\n'); await new Promise(resolve => setImmediate(resolve));
  expect(await f.terminal.question('Prompt> ')).toBe('one'); expect(await f.terminal.question('Prompt> ')).toBe('two');
  await expect(f.terminal.question('Prompt> ')).rejects.toThrow(/ended/);
});
it('abort and close settle once, remove listeners, and disable bracketed paste', async () => {
  const f = fixture(), controller = new AbortController();
  const answer = f.terminal.question('Prompt> ', { signal: controller.signal }); controller.abort(new Error('cancelled'));
  await expect(answer).rejects.toThrow(/cancelled/); f.terminal.close(); f.terminal.close();
  expect(f.input.listenerCount('data')).toBe(0); expect(f.input.rawMode).toBe(false);
  expect(f.rendered().split('\x1b[?2004l')).toHaveLength(2);
});
it('SIGINT reaches the frontend and retires pending input without treating pasted Ctrl-C as a signal', async () => {
  const f = fixture(); let signals = 0; f.terminal.on('SIGINT', () => { signals++; });
  expect(await queued(f, START + '\x03' + END + '\n')).toBe('\x03'); expect(signals).toBe(0);
  const answer = f.terminal.question('Prompt> '); f.input.write('\x03');
  await expect(answer).rejects.toThrow(/interrupted/); expect(signals).toBe(1); expect(f.input.listenerCount('data')).toBe(0);
});

it('dumb editor refuses prefix paste instead of duplicating typed content', async () => {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true;
  const previous = process.env.TERM; process.env.TERM = 'dumb';
  let terminal; try { terminal = createManagedTerminal({ input, output }); }
  finally { if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous; }
  terminals.push(terminal); input.write('prefix' + START + 'body' + END + '\n');
  await expect(terminal.question('Prompt> ')).rejects.toThrow(/dumb editor/);
});

it.each([false, true])('TTY Ctrl-D settles pending ordinary/approval question (approval=%s)', async approval => {
  const f = fixture(), answer = f.terminal.question('Question> ', { approval });
  f.input.write('\x04'); await expect(answer).rejects.toThrow(/ended/);
  expect(f.input.listenerCount('data')).toBe(0); expect(f.input.rawMode).toBe(false);
});
it('TTY Ctrl-D refuses a completed paste that was never explicitly submitted', async () => {
  const f = fixture(); f.input.write(START + 'unsubmitted\nbody' + END);
  const answer = f.terminal.question('Question> '); f.input.write('\x04');
  await expect(answer).rejects.toThrow(/incomplete/); expect(f.input.listenerCount('data')).toBe(0);
});
it('UTF-8 BOM remains literal original input data', async () => {
  const f = fixture(); expect(await queued(f, '\ufeffliteral\n')).toBe('\ufeffliteral');
});

it('aborted approval cannot reassign its partial text to a successor approval', async () => {
  const f = fixture(), controller = new AbortController();
  const first = f.terminal.question('First approval> ', { approval: true, signal: controller.signal });
  f.input.write('ye'); controller.abort(new Error('first cancelled'));
  await expect(first).rejects.toThrow(/first cancelled/);
  const second = f.terminal.question('Second approval> ', { approval: true }); f.input.write('s\n');
  await expect(second).rejects.toThrow(/first cancelled/); expect(f.input.listenerCount('data')).toBe(0);
});
it('a paste frame breaks CRLF adjacency after a preceding submitted CR', async () => {
  const f = fixture(); expect(await queued(f, 'first\r')).toBe('first');
  expect(await queued(f, START + 'a\nb' + END + '\n')).toBe('a\nb');
});

it.each([null, false])('close pauses only the actual input flow activated by the helper (prior=%s)', prior => {
  const input = new PassThrough(), output = new PassThrough(); if (prior === false) input.pause();
  expect(input.readableFlowing).toBe(prior);
  const terminal = createManagedTerminal({ input, output }); terminals.push(terminal);
  expect(input.readableFlowing).toBe(true); terminal.close();
  expect(input.readableFlowing).toBe(false); expect(input.destroyed).toBe(false);
});
it('retirement preserves input that was already externally flowing and its original raw mode', () => {
  const input = new PassThrough(), output = new PassThrough(); const external = [];
  input.on('data', bytes => external.push(bytes.toString())); input.isTTY = output.isTTY = true; input.isRaw = true;
  input.setRawMode = mode => { input.isRaw = mode; }; expect(input.readableFlowing).toBe(true);
  const terminal = createManagedTerminal({ input, output }); terminals.push(terminal); terminal.close();
  expect(input.readableFlowing).toBe(true); expect(input.isRaw).toBe(true); expect(input.destroyed).toBe(false);
  input.write('external owner data'); expect(external).toEqual(['external owner data']);
});
it('a real owned child exits naturally after close while its parent keeps stdin open', async () => {
  const module = new URL('../../scripts/managed-terminal-input.mjs', import.meta.url).href;
  const source = `import {createManagedTerminal} from ${JSON.stringify(module)};
const terminal=createManagedTerminal({input:process.stdin,output:process.stdout});
await terminal.question('INPUT_READY> '); terminal.close(); console.log('INPUT_CLOSED');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', sent = false;
  child.stdout.on('data', bytes => { output += bytes.toString(); if (!sent && output.includes('INPUT_READY> ')) { sent = true; child.stdin.write('/exit\n'); } });
  child.stderr.on('data', bytes => { errors += bytes.toString(); });
  let timeout;
  try {
    const exit = await Promise.race([
      new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Owned input child did not exit with parent-held-open stdin')), 3000); }),
    ]);
    expect(exit).toEqual({ code: 0, signal: null }); expect(errors).toBe(''); expect(output).toContain('INPUT_CLOSED');
    expect(sent).toBe(true); expect(child.stdin.writableEnded).toBe(false);
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); child.stdin.destroy(); }
}, 5000);
