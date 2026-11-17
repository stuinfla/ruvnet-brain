// lf-lines.mjs — read JSON Lines split on '\n' ONLY.
//
// WHY (4.7.31): node:readline also ends a line at U+2028 and U+2029, and JSON.stringify leaves both RAW inside
// a string. One ruflo passage carried a raw U+2028, so readline read one JSONL record as two halves that both
// failed to parse: every 4.7.30 update died in forge-guard ("PARITY 19,275 != 19,274", 2 invalid passages), and a
// JSON-RPC reply carrying that passage could not be parsed by the reader on the other end of the pipe. JSONL and
// newline-delimited JSON-RPC are delimited by LF; a trailing CR is dropped as readline's crlfDelay did.
//
// kb/ files cannot import this module (the knowledge bundle ships its own code list), so each carries the same
// few lines inline; tests/unit/lf-lines.test.mjs pins every reader to this behaviour.
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

const strip = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** Async iterator of lines (for `for await`). Breaking out destroys the input. */
export async function* lfLines(input) {
  const decoder = new StringDecoder('utf8'); // never setEncoding: a caller may also hash the raw bytes
  let rest = '';
  for await (const chunk of input) {
    rest += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    let nl;
    while ((nl = rest.indexOf('\n', start)) >= 0) { yield strip(rest.slice(start, nl)); start = nl + 1; }
    rest = rest.slice(start);
  }
  rest += decoder.end();
  if (rest) yield strip(rest);
}

/** readline.Interface's event surface ('line', 'close', 'error', close()) for event-style readers. */
export function lfLineReader(input) {
  const emitter = new EventEmitter();
  const decoder = new StringDecoder('utf8');
  let rest = '';
  let closed = false;
  input.on('data', (chunk) => {
    rest += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    let nl;
    while (!closed && (nl = rest.indexOf('\n', start)) >= 0) { emitter.emit('line', strip(rest.slice(start, nl))); start = nl + 1; }
    rest = closed ? '' : rest.slice(start);
  });
  input.on('end', () => { rest += decoder.end(); if (!closed && rest) emitter.emit('line', strip(rest)); rest = ''; emitter.close(); });
  input.on('error', (error) => { if (emitter.listenerCount('error')) emitter.emit('error', error); });
  input.on('close', () => emitter.close());
  emitter.close = () => { if (closed) return; closed = true; emitter.emit('close'); };
  return emitter;
}
