// Shared constants of the version 5 contract. Nothing here names a model, a revision or a chunk
// size: those live only in recipe/RECIPE.json.
export const CONTRACT_VERSION = 1;
export const SUPPORTED_RECIPE_VERSIONS = [1];
export const SHIM_VERSION = 1;
export const STANDINGS = ['implemented', 'measured', 'decided', 'corrected', 'negative', 'claimed', 'planned', 'instructing', 'speculative', 'spoken'];
export const STATES = ['ok', 'degraded', 'down', 'not-installed', 'unknown'];
export const MIN_NODE = [22, 13];
export const HOME_ENV = 'RUVNET_BRAIN5_HOME';
// Operational timings. Each can be overridden per machine in <home>/state/config.json.
export const DEFAULTS = {
  heartbeatMs: 60_000,
  staleAfterMs: 180_000,
  probeIntervalMs: 30 * 60_000,
  updateIntervalMs: 4 * 60 * 60_000,
  rollbackNoticeMs: 24 * 60 * 60_000,
  autoUpdate: true,
  updateUrl: null,
};
export const LINE_MAX = 160;
