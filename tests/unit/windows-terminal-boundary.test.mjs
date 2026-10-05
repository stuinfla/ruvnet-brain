import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { installTerminalLaunchers, validateClaudeTerminalArguments } from '../../scripts/model-terminal-launchers.mjs';
import { createTerminalTransport } from '../../scripts/model-terminal-gateway.mjs';

it('refuses Windows transport before creating a socket or changing an explicit temporary root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-win-transport-'));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    await expect(createTerminalTransport({ tempRoot: root })).rejects.toThrow('requires macOS or Linux');
    expect(fs.readdirSync(root)).toEqual([]);
  } finally {
    Object.defineProperty(process, 'platform', descriptor); fs.rmSync(root, { recursive: true, force: true });
  }
});

it('refuses unsupported Windows terminal installation before reading or changing user state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-win-boundary-'));
  const config = path.join(home, 'unrelated-settings.json'); fs.writeFileSync(config, 'owner data');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    expect(() => installTerminalLaunchers({ home, apply: true })).toThrow('Terminal launchers require macOS or Linux');
    expect(fs.readdirSync(home)).toEqual(['unrelated-settings.json']);
    expect(fs.readFileSync(config, 'utf8')).toBe('owner data');
  } finally {
    Object.defineProperty(process, 'platform', descriptor); fs.rmSync(home, { recursive: true, force: true });
  }
});

it('retains portable CLI routing conflict checks on Windows', () => {
  expect(() => validateClaudeTerminalArguments(['--settings', 'custom'])).toThrow();
  expect(() => validateClaudeTerminalArguments(['--model', 'custom'])).toThrow();
  expect(() => validateClaudeTerminalArguments(['--permission-mode', 'default'])).not.toThrow();
});
