/** One capture budget shared by the dispatcher and snapshot entrypoint. */
export const CAPTURE_BUDGET_MS = 8_000;

export function effectiveBudgetMs(env = process.env) {
  const handed = Number(env.RUVNET_CODEX_BUDGET_MS);
  return Number.isFinite(handed) && handed > 0
    ? Math.max(0, Math.min(CAPTURE_BUDGET_MS, handed - 300))
    : CAPTURE_BUDGET_MS;
}

export function snapshotDeadlineAt(env = process.env, startedAt = performance.timeOrigin) {
  const own = Math.floor(startedAt + effectiveBudgetMs(env));
  const inherited = Number(env.RUVNET_SESSION_SNAPSHOT_DEADLINE_AT);
  return Number.isFinite(inherited) && inherited > 0 ? Math.floor(Math.min(own, inherited)) : own;
}
