// Editable single-line input plus exact, atomically framed bracketed paste.
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { TextDecoder } from 'node:util';
import { EventEmitter } from 'node:events';

const START = '\x1b[200~', END = '\x1b[201~';
const bytes = value => Buffer.byteLength(value, 'utf8');

export function createManagedTerminal({ input, output, maxPromptBytes = 64 * 1024,
  maxQueuedPrompts = 32, maxQueueBytes = 512 * 1024 } = {}) {
  if (!input?.on || !output?.write || ![maxPromptBytes, maxQueuedPrompts, maxQueueBytes].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Managed terminal requires streams and positive input bounds');
  }
  const priorFlowing = input.readableFlowing, priorRaw = input.isRaw;
  const terminal = Boolean(input.isTTY && output.isTTY), dumbEditor = process.env.TERM === 'dumb', editorInput = new PassThrough();
  editorInput.isTTY = terminal;
  editorInput.setRawMode = mode => input.setRawMode?.(mode);
  const editor = readline.createInterface({ input: editorInput, output, terminal });
  const events = new EventEmitter(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const queue = [];
  let queuedBytes = 0, ordinary, approval, owner, pendingPaste = '', hasPaste = false;
  let frame = false, frameBytes = '', parsing = '', closed = false, failure;
  let nonterminalLine = '', cleanEOF = false;
  if (terminal) output.write('\x1b[?2004h');

  function settle(waiter, error, value) {
    if (!waiter) return;
    waiter.signal?.removeEventListener('abort', waiter.abort);
    error ? waiter.reject(error) : waiter.resolve(value);
  }
  function retire(error) {
    if (closed) return;
    closed = true; failure = error;
    input.removeListener('data', receive); input.removeListener('end', ended); input.removeListener('error', inputError);
    editor.removeListener('line', line); editor.removeListener('SIGINT', interrupted); editor.removeListener('close', ended);
    editor.close(); editorInput.destroy();
    if (priorFlowing !== true) input.pause?.();
    if (terminal && typeof priorRaw === 'boolean') input.setRawMode?.(priorRaw);
    if (terminal) output.write('\x1b[?2004l');
    settle(ordinary, error || new Error('Terminal input closed')); settle(approval, error || new Error('Terminal input closed'));
    ordinary = approval = undefined;
  }
  function fail(reason) { retire(new Error(`Managed terminal input refused: ${reason}`)); }
  function line(value) {
    if (closed) return;
    const text = pendingPaste + value, kind = owner === 'approval' && approval ? 'approval' : 'ordinary', pasted = hasPaste;
    owner = undefined; pendingPaste = ''; hasPaste = false; nonterminalLine = '';
    if (bytes(text) > maxPromptBytes) return fail('prompt byte limit exceeded');
    if (kind === 'approval' && !pasted) {
      const waiter = approval; approval = undefined; settle(waiter, undefined, text); return;
    }
    if (ordinary) { const waiter = ordinary; ordinary = undefined; settle(waiter, undefined, text); return; }
    if (queue.length >= maxQueuedPrompts || queuedBytes + bytes(text) > maxQueueBytes) return fail('prompt FIFO limit exceeded');
    queue.push(text); queuedBytes += bytes(text);
  }
  editor.on('line', line);
  function interrupted() {
    events.emit('SIGINT');
    retire(new Error('Terminal input interrupted'));
  }
  editor.on('SIGINT', interrupted);
  function currentLine() { return terminal ? editor.line : nonterminalLine; }
  function bounded() {
    if (bytes(pendingPaste) + bytes(frameBytes) + bytes(currentLine()) > maxPromptBytes) fail('prompt byte limit exceeded');
  }
  function plain(value) {
    if (!value || closed) return;
    // Feed ordinary bytes individually so ownership starts before each editor line.
    for (const character of value) {
      if (closed) break;
      if (character === '\n' && plain.lastReturn) { plain.lastReturn = false; continue; }
      plain.lastReturn = character === '\r';
      owner ||= approval ? 'approval' : 'ordinary';
      if (!terminal) {
        if (character === '\n' || character === '\r') {
          const text = nonterminalLine; line(text);
        } else nonterminalLine += character;
      } else editorInput.write(character === '\n' ? '\r' : character);
      bounded();
    }
  }
  function beginPaste() {
    plain.lastReturn = false;
    const prior = currentLine();
    if (terminal && dumbEditor && prior) return fail('paste after a prefix is unsupported with the dumb editor');
    if (terminal && editor.cursor !== prior.length) return fail('paste at a midline cursor is unsupported');
    // Paste never supplies approval, including a frame starting after the question.
    owner = 'ordinary'; hasPaste = true; pendingPaste += prior;
    if (terminal && prior) editor.write(null, { ctrl: true, name: 'u' });
    nonterminalLine = ''; frame = true; frameBytes = ''; bounded();
  }
  function paste(value) {
    frameBytes += value;
    if (frameBytes.includes(START)) return fail('nested bracketed paste frame');
    bounded();
  }
  function finishPaste() {
    pendingPaste += frameBytes; frameBytes = ''; frame = false; bounded();
    if (terminal && !closed) output.write(`[paste captured: ${bytes(pendingPaste)} bytes; Enter submits]\n`);
  }
  function holdSuffix(text, markers) {
    let n = 0;
    for (const marker of markers) for (let i = 1; i < marker.length; i++) if (text.endsWith(marker.slice(0, i))) n = Math.max(n, i);
    return n;
  }
  function parse() {
    while (parsing && !closed) {
      if (frame) {
        const end = parsing.indexOf(END);
        if (end >= 0) { paste(parsing.slice(0, end)); parsing = parsing.slice(end + END.length); if (!closed) finishPaste(); }
        else { const held = holdSuffix(parsing, [END]); paste(parsing.slice(0, parsing.length - held)); parsing = parsing.slice(parsing.length - held); break; }
      } else {
        const start = parsing.indexOf(START), end = parsing.indexOf(END);
        if (end >= 0 && (start < 0 || end < start)) return fail('unexpected bracketed paste end');
        if (start >= 0) { plain(parsing.slice(0, start)); parsing = parsing.slice(start + START.length); if (!closed) beginPaste(); }
        else { const held = holdSuffix(parsing, [START, END]); plain(parsing.slice(0, parsing.length - held)); parsing = parsing.slice(parsing.length - held); break; }
      }
    }
  }
  function receive(chunk) {
    if (closed) return;
    try { parsing += decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), { stream: true }); parse(); }
    catch { fail('invalid UTF-8 input'); }
  }
  function ended() {
    if (closed) return;
    try { parsing += decoder.decode(); parse(); } catch { return fail('incomplete UTF-8 input at EOF'); }
    if (frame || parsing || hasPaste || currentLine()) return fail('incomplete input at EOF');
    cleanEOF = true; retire(new Error('Terminal input ended')); 
  }
  function inputError(error) { retire(error); }
  editor.on('close', ended);
  input.on('data', receive); input.on('end', ended); input.on('error', inputError);
  input.resume?.();
  function question(label, { signal, approval: approvalMode = false } = {}) {
    if (signal?.aborted) { const error = signal.reason || new Error('Terminal input aborted'); retire(error); return Promise.reject(error); }
    if (!approvalMode && cleanEOF && queue.length) { const text = queue.shift(); queuedBytes -= bytes(text); return Promise.resolve(text); }
    if (failure || closed) return Promise.reject(failure || new Error('Terminal input closed'));
    if (!approvalMode && queue.length) { const text = queue.shift(); queuedBytes -= bytes(text); return Promise.resolve(text); }
    if ((approvalMode && approval) || (!approvalMode && ordinary)) return Promise.reject(new Error('Concurrent terminal question unsupported'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      waiter.abort = () => retire(signal.reason || new Error('Terminal input aborted'));
      if (approvalMode) approval = waiter; else ordinary = waiter;
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (terminal) { editor.setPrompt(label); editor.prompt(true); } else output.write(label);
    });
  }
  return { question, on(name, handler) { events.on(name, handler); return this; },
    close() { retire(); } };
}
