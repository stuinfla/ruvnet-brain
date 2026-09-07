import path from 'node:path';

export const CONSOLE_FIXTURE_PATH_KEYS = Object.freeze([
  'RUVNET_CONSOLE_ROOT',
  'RUVNET_BRAIN_CONFIG_FILE',
  'RUVNET_SETTINGS_FILE',
  'RUVNET_BRAIN_SECRETS_FILE',
  'RUVNET_BRAIN_PROJECT_SETTINGS_FILE',
  'RUVNET_BRAIN_STATE_DIR',
  'RUVNET_BRAIN_KB',
  'RUVNET_LESSON_STORE',
  'RUVNET_ADVOCACY_OUTCOMES',
  'RUVNET_CAPABILITY_STATE_LOG',
]);

/** Build the complete writable Console fixture boundary without redefining the system home. */
export function consoleFixtureEnvironment(fixtureRoot, { baseEnv = process.env, extras = {} } = {}) {
  if (typeof fixtureRoot !== 'string' || !path.isAbsolute(fixtureRoot)) {
    throw new Error('console fixture root must be an absolute path');
  }
  const root = path.resolve(fixtureRoot);
  const config = path.join(root, '.config', 'ruvnet-brain');
  const protectedKeys = [
    ...CONSOLE_FIXTURE_PATH_KEYS,
    'HOME', 'USERPROFILE', 'CODEX_HOME', 'RUVNET_BRAIN_TEST',
  ];
  const forbidden = protectedKeys.find((key) => Object.hasOwn(extras, key));
  if (forbidden) throw new Error(`console fixture extras may not override ${forbidden}`);
  return {
    ...baseEnv,
    ...extras,
    // The console root is a test-only filesystem boundary. Carry the installer's independent
    // side-effect guard too, so a fixture preference can never reach the real launchd domain.
    RUVNET_BRAIN_TEST: '1',
    RUVNET_CONSOLE_ROOT: root,
    RUVNET_BRAIN_CONFIG_FILE: path.join(root, '.claude', 'ruvnet-brain', 'config.json'),
    RUVNET_SETTINGS_FILE: path.join(config, 'settings.json'),
    RUVNET_BRAIN_SECRETS_FILE: path.join(config, 'secrets.enc.json'),
    RUVNET_BRAIN_PROJECT_SETTINGS_FILE: path.join(root, 'Code', 'dirty-console-fixture', '.swarm', 'ruvnet-brain-settings.json'),
    RUVNET_BRAIN_STATE_DIR: config,
    RUVNET_BRAIN_KB: path.join(root, '.cache', 'ruvnet-brain', 'kb'),
    RUVNET_LESSON_STORE: path.join(config, 'lessons.json'),
    RUVNET_ADVOCACY_OUTCOMES: path.join(config, 'advocacy-outcomes.jsonl'),
    RUVNET_CAPABILITY_STATE_LOG: path.join(config, 'capability-states.jsonl'),
  };
}
