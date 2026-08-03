const IGNORED_ENV = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']);

// Boolean-only by construction: no credential value can cross the Console API boundary.
export function providerAvailability(catalog, subscriptions = {}, env = process.env) {
  if (catalog?.providers && typeof catalog.providers === 'object') {
    return Object.fromEntries(Object.entries(catalog.providers).map(([name, provider]) => [
      name,
      (provider?.detect_env || []).some((key) => !IGNORED_ENV.has(key) && Boolean(env[key])),
    ]));
  }
  return Object.fromEntries(Object.entries(subscriptions).map(([name, value]) => [name, Boolean(value?.apiKey)]));
}
