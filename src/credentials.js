import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = join(homedir(), '.claude', '.credentials.json');

/**
 * Read the OAuth credential that Claude Code stores when you log in with your
 * Claude account. This is deliberately *reading* an existing login rather than
 * running our own OAuth flow: it means the dashboard never impersonates an
 * OAuth client, never asks you for a password, and never stores a second copy
 * of your token. `claude` refreshes the credential in place, so re-reading it
 * on every request keeps us current.
 *
 * macOS  -> login keychain, service "Claude Code-credentials"
 * others -> ~/.claude/.credentials.json
 */
async function readRaw() {
  if (platform() === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { maxBuffer: 1024 * 1024 },
      );
      return { text: stdout.trim(), source: 'macOS Keychain' };
    } catch {
      // Fall through to the file, which some setups use even on macOS.
    }
  }
  try {
    const text = await readFile(CREDENTIALS_FILE, 'utf8');
    return { text: text.trim(), source: '~/.claude/.credentials.json' };
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<null | {
 *   accessToken: string, expiresAt: number|null, refreshTokenExpiresAt: number|null,
 *   subscriptionType: string|null, scopes: string[], source: string
 * }>}
 */
export async function readCredentials() {
  const raw = await readRaw();
  if (!raw || !raw.text) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return null;
  }

  const oauth = parsed.claudeAiOauth ?? parsed;
  if (!oauth || typeof oauth.accessToken !== 'string') return null;

  // `scopes` has been observed both as an array and as an object keyed by index.
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes
    : oauth.scopes && typeof oauth.scopes === 'object'
      ? Object.values(oauth.scopes)
      : [];

  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    refreshTokenExpiresAt:
      typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : null,
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
    scopes: scopes.filter((s) => typeof s === 'string'),
    source: raw.source,
  };
}

/**
 * Connection state for the UI. Never includes the token itself.
 * status: 'missing' | 'expired' | 'connected'
 */
export async function readConnection() {
  const creds = await readCredentials();
  if (!creds) {
    return {
      status: 'missing',
      detail:
        platform() === 'darwin'
          ? 'No Claude Code credential found in the login keychain.'
          : 'No credential found at ~/.claude/.credentials.json.',
    };
  }
  const expired = creds.expiresAt != null && creds.expiresAt <= Date.now();
  return {
    status: expired ? 'expired' : 'connected',
    detail: expired ? 'The stored access token has expired.' : null,
    source: creds.source,
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
    scopes: creds.scopes,
    expiresAt: creds.expiresAt,
  };
}
