// Compatibility import surface. The installed plugin owns coverage validation so `/coverage`,
// Console, build, update, and release tooling all execute the same implementation.
export * from '../plugin/scripts/coverage-integrity.mjs';
