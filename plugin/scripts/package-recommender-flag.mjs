// package-recommender-flag.mjs — the two pieces of the package recommender (ADR-093) that advocacy-route
// needs even when the recommender is OFF, kept dependency-free so a default-off hook never loads the
// matcher, the card snapshot reader, or the socket client (adversarial review L1, 2026-10-01).

/** THE FLAG, DEFAULT OFF: only an explicit opt-in is on. Read per call, never cached. */
export function packageRecommenderEnabled(env = process.env) {
  return ['1', 'on', 'true', 'yes'].includes(String(env.RUVNET_PACKAGE_RECOMMENDER || '').trim().toLowerCase());
}

// Short package names that are ordinary words ("don't touch the memory layout"): never treated as the
// user naming an offered package (adversarial review H2c). Full ids ("@ruvector/router") always count.
const COMMON_WORDS = new Set(`
  memory testing hooks hook server router core node gate runtime backend frontend cli wasm graph cache
  client sdk api types utils common shared config solver index search agent agents swarm flow store
  queue worker workers proxy bridge monitor dashboard plugin plugins cluster raft replication
`.trim().split(/\s+/));

/**
 * The names a user can answer an offer with, and whether the offer is a candidate SET.
 * A set (several packages shown, the model asked to mention at most one) answers only to a package
 * the user actually names — never to a bare "ok"/"no", which may be about something else entirely.
 */
export function offerNames(offer) {
  const set = Array.isArray(offer?.candidates) && offer.candidates.length > 0;
  if (!set) return { set: false, names: [String(offer?.capability || '')].filter(Boolean) };
  const distinctive = (n) => n.startsWith('@') || (n.length >= 5 && !COMMON_WORDS.has(n.toLowerCase()));
  const full = (Array.isArray(offer.packages) ? offer.packages : []).map(String).filter(distinctive);
  const short = offer.candidates.map(String).filter(distinctive);
  return { set: true, names: [...new Set([...full, ...short])] };
}
