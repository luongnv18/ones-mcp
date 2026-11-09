import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeJwtPayload, getTokenExpiresAt, isTokenExpiringSoon } from '../src/auth/jwt.js';
import { TokenStore } from '../src/auth/token-store.js';
import { detectBrowserExecutable } from '../src/auth/browser.js';
import { OnesApiError } from '../src/client/errors.js';

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('jwt helpers', () => {
  it('decodes JWT exp claim into epoch milliseconds and detects expiring tokens', () => {
    const expSeconds = 1_800_000_000;
    const token = makeFakeJwt({ sub: 'user-1', exp: expSeconds });
    expect(decodeJwtPayload(token)?.sub).toBe('user-1');
    expect(getTokenExpiresAt(token)).toBe(expSeconds * 1000);

    const sixMinBefore = expSeconds * 1000 - 360_000;
    const twoMinBefore = expSeconds * 1000 - 120_000;
    expect(isTokenExpiringSoon(expSeconds * 1000, 300, sixMinBefore)).toBe(false);
    expect(isTokenExpiringSoon(expSeconds * 1000, 300, twoMinBefore)).toBe(true);
    expect(isTokenExpiringSoon(undefined, 300, twoMinBefore)).toBe(false);
  });

  it('returns null/undefined safely for opaque non-JWT tokens', () => {
    expect(decodeJwtPayload('opaque-token-string')).toBeNull();
    expect(getTokenExpiresAt('opaque-token-string')).toBeUndefined();
    expect(decodeJwtPayload('header.invalid-base64-json.sig')).toBeNull();
  });
});

describe('TokenStore', () => {
  it('atomically saves, reads, and clears AuthSession with 0600 permissions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-token-'));
    const filePath = path.join(dir, 'nested', 'auth.json');
    try {
      const store = new TokenStore(filePath);
      expect(store.getPath()).toBe(filePath);
      expect(store.read()).toBeNull();

      store.write({
        baseUrl: 'https://ones.example.com',
        accessToken: 'jwt-123',
        teamUUID: 'team-1',
        capturedAt: 1000
      });

      const readBack = store.read();
      expect(readBack?.accessToken).toBe('jwt-123');
      expect(readBack?.teamUUID).toBe('team-1');
      if (process.platform !== 'win32') {
        const mode = fs.statSync(filePath).mode & 0o777;
        expect(mode).toBe(0o600);
      }

      store.clear();
      expect(store.read()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles non-existent or corrupted files gracefully in read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-token-corrupt-'));
    const filePath = path.join(dir, 'corrupt-auth.json');
    try {
      const store = new TokenStore(filePath);
      expect(store.read()).toBeNull();

      fs.writeFileSync(filePath, '{ not valid json');
      expect(store.read()).toBeNull();

      fs.writeFileSync(filePath, JSON.stringify({ baseUrl: 'https://ones.example.com' }));
      expect(store.read()).toBeNull();

      fs.writeFileSync(filePath, JSON.stringify({ accessToken: 'jwt-123' }));
      expect(store.read()).toBeNull();

      fs.writeFileSync(filePath, JSON.stringify({ accessToken: 'jwt-123', baseUrl: '' }));
      expect(store.read()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('detectBrowserExecutable', () => {
  it('prefers ONES_BROWSER_PATH when file exists, else falls back to OS Chrome/Edge paths', () => {
    const custom = detectBrowserExecutable({
      envPath: '/custom/chrome',
      existsSync: (p) => p === '/custom/chrome'
    });
    expect(custom.executablePath).toBe('/custom/chrome');

    const macChrome = detectBrowserExecutable({
      platform: 'darwin',
      existsSync: (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    });
    expect(macChrome.executablePath).toContain('Google Chrome');

    const winEdge = detectBrowserExecutable({
      platform: 'win32',
      existsSync: (p) => p.endsWith('msedge.exe')
    });
    expect(winEdge.executablePath).toContain('msedge.exe');
  });

  it('throws OnesApiError when envPath does not exist', () => {
    expect(() =>
      detectBrowserExecutable({
        envPath: '/non/existent/path',
        existsSync: () => false
      })
    ).toThrowError(OnesApiError);
  });

  it('falls back to playwright channel chrome when no browser binary found', () => {
    const fallback = detectBrowserExecutable({
      platform: 'linux',
      existsSync: () => false
    });
    expect(fallback.channel).toBe('chrome');
    expect(fallback.source).toBe('playwright-channel-chrome');
  });
});
