// npm-pack-json.mjs — the ONE reader of `npm pack --json` output for the test suite.
//
// npm changed the document shape between majors (captured 2026-10-25 on this repo, same 591 files):
//   npm 10.9.9 / 11.21.1:  [ { id, name, version, filename, files: [{ path, size, mode }], ... } ]
//   npm 12.2.1:            { "ruvnet-brain": { id, name, version, filename, files: [...], ... } }
// Every test used to read `JSON.parse(out)[0]`, which is `undefined` on npm 12, and one read
// `report[0]?.files || []`, which turned the npm 12 shape into an EMPTY file list and then accused the
// package of shipping nothing. This reader accepts exactly the two known shapes, each holding exactly one
// package, and THROWS on anything else. It never degrades to an empty answer.
//
// Test-side only: the release scripts keep their own parsing in 4.7.21 (their npm parsing is deferred to 4.7.22).

function preview(value) {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.slice(0, 160);
}

/** Parse the JSON document npm printed. A non-JSON preamble (a lifecycle script or a shell banner on
 *  stdout) is skipped only up to the first line that IS the document's opening bracket, never by
 *  searching for the first `[` anywhere (that is the inner `files` array on npm 12). */
function parseDocument(stdout) {
  const text = String(stdout ?? '');
  try { return JSON.parse(text); } catch (first) {
    const start = text.search(/^[[{]\s*$/m);
    if (start > 0) {
      try { return JSON.parse(text.slice(start)); } catch { /* reported below with the original error */ }
    }
    throw new Error(`npm pack --json: output is not a JSON document (${first.message}): ${text.slice(0, 160)}`);
  }
}

/** The single package entry from `npm pack --json` (npm 10, 11 or 12). Throws on any other shape. */
export function parseNpmPack(stdout, { expectName } = {}) {
  const parsed = parseDocument(stdout);
  let entries;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object' && !('filename' in parsed) && !('error' in parsed)) {
    entries = Object.entries(parsed).map(([key, entry]) => {
      if (!entry || typeof entry !== 'object' || entry.name !== key) {
        throw new Error(`npm pack --json: object entry "${key}" is not keyed by its package name: ${preview(entry)}`);
      }
      return entry;
    });
  } else {
    throw new Error(`npm pack --json: unrecognised document shape: ${preview(parsed)}`);
  }
  if (entries.length !== 1) {
    throw new Error(`npm pack --json: expected exactly one package entry, got ${entries.length}: ${preview(parsed)}`);
  }
  const [entry] = entries;
  if (!entry || typeof entry !== 'object' || typeof entry.filename !== 'string' || !entry.filename.endsWith('.tgz')) {
    throw new Error(`npm pack --json: entry has no .tgz filename: ${preview(entry)}`);
  }
  if (expectName && entry.name !== expectName) {
    throw new Error(`npm pack --json: packed ${entry.name}, expected ${expectName}`);
  }
  return entry;
}

/** The published paths of a parsed entry, POSIX-separated. Throws when the entry carries no file list. */
export function packedPaths(entry) {
  if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
    throw new Error(`npm pack --json: entry has no files list: ${preview(entry)}`);
  }
  return new Set(entry.files.map((file) => {
    if (!file || typeof file.path !== 'string' || !file.path) {
      throw new Error(`npm pack --json: file record without a path: ${preview(file)}`);
    }
    return file.path.replace(/\\/g, '/');
  }));
}
