import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenStore, type AuthSession } from '../src/auth/token-store.js';
import { RefreshManager } from '../src/auth/refresh-manager.js';
import { extractCapturedToken, extractTeamUUIDFromUrl } from '../src/auth/login-flow.js';
import { createLogger } from '../src/client/logger.js';
import { OnesApiError } from '../src/client/errors.js';

function makeJwt(expSeconds: number): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${h}.${p}.sig`;
}

describe('login capture helpers', () => {
  it('extracts Bearer token case-insensitively and teamUUID from API/UI URLs', () => {
    expect(extractCapturedToken({ authorization: 'Bearer tok_abc_123' })).toBe('tok_abc_123');
    expect(extractCapturedToken({ Authorization: 'Bearer tok_xyz' })).toBe('tok_xyz');
    expect(extractCapturedToken({ authorization: 'Basic 123' })).toBeUndefined();
    expect(
      extractTeamUUIDFromUrl('https://ones.example.com/wiki/api/wiki/team/Tm9988/spaces')
    ).toBe('Tm9988');
  });
});

describe('RefreshManager', () => {
  const logger = createLogger({ write: () => {} });

  function setupTempStore(initial: AuthSession | null): { store: TokenStore; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-rm-'));
    const store = new TokenStore(path.join(dir, 'auth.json'));
    if (initial) store.write(initial);
    return { store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it('uses Tier 1 refresh API and deduplicates concurrent refreshes with single-flight mutex', async () => {
    const nowMs = 1_700_000_000_000;
    const expiringJwt = makeJwt(Math.floor(nowMs / 1000) + 60); // 1 min left (< 5 min buffer)
    const freshJwt = makeJwt(Math.floor(nowMs / 1000) + 3600);

    const { store, cleanup } = setupTempStore({
      baseUrl: 'https://ones.example.com',
      accessToken: expiringJwt,
      refreshToken: 'rt-old',
      refreshEndpoint: 'https://ones.example.com/oauth2/token',
      expiresAt: nowMs + 60_000,
      teamUUID: 'team-1',
      capturedAt: nowMs - 10_000
    });

    try {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: freshJwt,
            refresh_token: 'rt-new',
            expires_in: 3600
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const silentRefresh = vi.fn(async () => null);
      const manager = new RefreshManager({
        tokenStore: store,
        fetchImpl: fetchMock as unknown as typeof fetch,
        silentBrowserRefresh: silentRefresh,
        logger,
        now: () => nowMs
      });

      const results = await Promise.all([
        manager.getValidSession(),
        manager.getValidSession(),
        manager.getValidSession()
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(silentRefresh).not.toHaveBeenCalled();
      expect(results.every((r) => r.accessToken === freshJwt)).toBe(true);
      expect(store.read()?.refreshToken).toBe('rt-new');
    } finally {
      cleanup();
    }
  });

  it('falls back to Tier 2 silent headless browser refresh when Tier 1 fails or is absent', async () => {
    const nowMs = 1_700_000_000_000;
    const { store, cleanup } = setupTempStore({
      baseUrl: 'https://ones.example.com',
      accessToken: 'expired-tok',
      teamUUID: 'team-1',
      capturedAt: nowMs - 10_000
    });

    try {
      const silentBrowserRefresh = vi.fn(async () => ({
        baseUrl: 'https://ones.example.com',
        accessToken: 'browser-refreshed-tok',
        teamUUID: 'team-1',
        capturedAt: nowMs
      }));

      const manager = new RefreshManager({
        tokenStore: store,
        fetchImpl: vi.fn() as unknown as typeof fetch,
        silentBrowserRefresh,
        logger,
        now: () => nowMs
      });

      const session = await manager.getValidSession({ forceRefresh: true });
      expect(session.accessToken).toBe('browser-refreshed-tok');
      expect(store.read()?.accessToken).toBe('browser-refreshed-tok');
    } finally {
      cleanup();
    }
  });

  it('Tier 2 preserves refreshToken, refreshEndpoint, cookies, and teamUUID when silent refresh returns undefined for them', async () => {
    const oldCapturedAt = 1_699_000_000_000;
    const nowMs = 1_700_000_000_000;
    const oldExpiresAt = nowMs - 1000;
    const newExpiresAt = nowMs + 3600_000;

    const initialCookies = [
      { name: 'session_id', value: 's_abc', domain: 'ones.example.com', path: '/' }
    ];

    const { store, cleanup } = setupTempStore({
      baseUrl: 'https://ones.example.com',
      accessToken: 'old-access-tok',
      refreshToken: 'rt-preserve-me',
      refreshEndpoint: 'https://ones.example.com/oauth2/token',
      expiresAt: oldExpiresAt,
      teamUUID: 'team-preserve-me',
      cookies: initialCookies,
      capturedAt: oldCapturedAt
    });

    try {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 500 })
      );

      const silentBrowserRefresh = vi.fn(async () => ({
        baseUrl: 'https://ones.example.com',
        accessToken: 'new-browser-tok',
        refreshToken: undefined,
        refreshEndpoint: undefined,
        cookies: undefined,
        teamUUID: undefined,
        expiresAt: newExpiresAt,
        capturedAt: nowMs
      }));

      const manager = new RefreshManager({
        tokenStore: store,
        fetchImpl: fetchMock as unknown as typeof fetch,
        silentBrowserRefresh,
        logger,
        now: () => nowMs
      });

      const session = await manager.getValidSession({ forceRefresh: true });

      // Updated fields
      expect(session.accessToken).toBe('new-browser-tok');
      expect(session.expiresAt).toBe(newExpiresAt);
      expect(session.capturedAt).toBe(nowMs);

      // Preserved fields
      expect(session.refreshToken).toBe('rt-preserve-me');
      expect(session.refreshEndpoint).toBe('https://ones.example.com/oauth2/token');
      expect(session.cookies).toEqual(initialCookies);
      expect(session.teamUUID).toBe('team-preserve-me');

      // Stored session
      const stored = store.read();
      expect(stored?.accessToken).toBe('new-browser-tok');
      expect(stored?.expiresAt).toBe(newExpiresAt);
      expect(stored?.capturedAt).toBe(nowMs);
      expect(stored?.refreshToken).toBe('rt-preserve-me');
      expect(stored?.refreshEndpoint).toBe('https://ones.example.com/oauth2/token');
      expect(stored?.cookies).toEqual(initialCookies);
      expect(stored?.teamUUID).toBe('team-preserve-me');
    } finally {
      cleanup();
    }
  });

  it('throws AUTH_REQUIRED (Tier 3) when no session exists or both refresh tiers fail', async () => {
    const { store, cleanup } = setupTempStore(null);
    try {
      const manager = new RefreshManager({
        tokenStore: store,
        fetchImpl: vi.fn() as unknown as typeof fetch,
        silentBrowserRefresh: async () => null,
        logger
      });

      await expect(manager.getValidSession()).rejects.toMatchObject({
        name: 'OnesApiError',
        code: 'AUTH_REQUIRED'
      } satisfies Partial<OnesApiError>);
    } finally {
      cleanup();
    }
  });
});
