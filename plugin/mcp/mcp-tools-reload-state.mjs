// Track MCP tools reload state for health monitoring.
// This file is written by server.mjs when tools are successfully reloaded.
// Consumers (e.g., --doctor, Claude Code) can check this to verify the reload worked.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BRAIN_HOME = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');

export function recordToolsReload(manifestVersion) {
  const stateFile = path.join(BRAIN_HOME, 'mcp-tools-reload-state.json');
  try {
    const state = {
      manifestVersion,
      lastReloadAt: new Date().toISOString(),
      pid: process.pid,
    };
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    console.error(`[ruvnet-brain] could not record tools reload state: ${e.message}`);
  }
}

export function getToolsReloadState() {
  const stateFile = path.join(BRAIN_HOME, 'mcp-tools-reload-state.json');
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch (e) {
    // state file corrupted or missing, return null
  }
  return null;
}
