// Secret-shaped values are never printed or logged as given (review F21): an address loses its
// user/password and its query values; common token forms (provider keys, bearer tokens) are masked.
const TOKENS = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{20,})\b/g,
  /\b(Bearer|token|apikey|api_key|password|secret)(\s*[:=]\s*|\s+)([^\s"'&]{6,})/gi,
];

/** An address with its credentials and query values removed (the shape stays readable). */
export function redactUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.username || u.password) [u.username, u.password] = ['REDACTED', ''];
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, 'REDACTED');
    return u.toString();
  } catch {
    return redact(String(value));
  }
}

/** Text with every address and token form above masked. */
export function redact(text) {
  let out = String(text).replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (m) => redactUrl(m));
  out = out.replace(TOKENS[0], 'REDACTED');
  return out.replace(TOKENS[1], (_, k, sep) => `${k}${sep}REDACTED`);
}
