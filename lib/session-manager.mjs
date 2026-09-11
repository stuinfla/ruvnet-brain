/**
 * session-manager.mjs — Session ID management for memory isolation
 *
 * PHASE 2: Session Isolation Implementation
 * Provides getCurrentSessionId() and setSessionContext() for session-scoped memory access
 *
 * Session ID is derived from:
 * 1. CLAUDE_SESSION env var (set by Claude Code) - preferred
 * 2. Generated UUID on first access - fallback
 * 3. Persisted in ~/.claude/session-context.json - survival across restarts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const SESSION_CONTEXT_PATH = path.join(os.homedir(), '.claude', 'session-context.json');

/**
 * loadOrCreateSessionContext — persist session ID across invocations
 */
function loadOrCreateSessionContext() {
  try {
    if (fs.existsSync(SESSION_CONTEXT_PATH)) {
      const content = fs.readFileSync(SESSION_CONTEXT_PATH, 'utf8');
      const ctx = JSON.parse(content);
      if (ctx.sessionId) return ctx;
    }
  } catch {
    // Ignore parse errors, create new
  }

  // Generate new session ID
  const sessionId = randomUUID();
  const context = {
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Persist it (best effort)
  try {
    const dir = path.dirname(SESSION_CONTEXT_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(SESSION_CONTEXT_PATH, JSON.stringify(context, null, 2), {
      mode: 0o600,
    });
  } catch {
    // If we can't persist, continue with ephemeral session ID
  }

  return context;
}

// Singleton context
let currentContext = null;

/**
 * getCurrentSessionId — get or create the current session ID
 *
 * Priority:
 * 1. CLAUDE_SESSION env var (Claude Code sets this)
 * 2. CLAUDE_WORKDIR + loaded context
 * 3. Fallback: generate + persist new UUID
 */
export function getCurrentSessionId() {
  // Check for Claude Code session first (most authoritative)
  if (process.env.CLAUDE_SESSION) {
    return process.env.CLAUDE_SESSION;
  }

  // Load or create persisted context
  if (!currentContext) {
    currentContext = loadOrCreateSessionContext();
  }

  return currentContext.sessionId;
}

/**
 * setSessionContext — override session context (for testing/special cases)
 */
export function setSessionContext(sessionId) {
  if (!currentContext) {
    currentContext = loadOrCreateSessionContext();
  }
  currentContext.sessionId = sessionId;
  currentContext.updatedAt = Date.now();
}

/**
 * getSessionMetadata — return full session context
 */
export function getSessionMetadata() {
  if (!currentContext) {
    currentContext = loadOrCreateSessionContext();
  }
  return {
    sessionId: getCurrentSessionId(),
    ...currentContext,
  };
}

/**
 * clearSessionContext — clear ephemeral session (for testing)
 */
export function clearSessionContext() {
  currentContext = null;
}
