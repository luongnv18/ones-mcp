import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAuthFilePath, getBrowserProfileDir, getConfigFilePath, getStateDir } from '../src/config/paths.js';
import { loadConfig, saveConfig } from '../src/config/env.js';
import { createLogger, redactSecrets } from '../src/client/logger.js';

describe('paths & config', () => {
  it('resolves state paths relative to provided home directory', () => {
    const fakeHome = path.join(os.tmpdir(), 'fake-home');
    expect(getStateDir(fakeHome)).toBe(path.join(fakeHome, '.ones-mcp'));
    expect(getAuthFilePath(fakeHome)).toBe(path.join(fakeHome, '.ones-mcp', 'auth.json'));
    expect(getConfigFilePath(fakeHome)).toBe(path.join(fakeHome, '.ones-mcp', 'config.json'));
    expect(getBrowserProfileDir(fakeHome)).toBe(path.join(fakeHome, '.ones-mcp', 'browser-profile'));
  });

  it('loads default config and applies env overrides over saved config', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-mcp-cfg-'));
    try {
      const saved = saveConfig(
        { baseUrl: 'https://saved.ones.test/', defaultTeamUUID: 'team-saved' },
        { homeDir: tempHome }
      );
      expect(saved.baseUrl).toBe('https://saved.ones.test');

      const fromDisk = loadConfig({ env: {}, homeDir: tempHome });
      expect(fromDisk.baseUrl).toBe('https://saved.ones.test');
      expect(fromDisk.defaultTeamUUID).toBe('team-saved');
      expect(fromDisk.maxReadBytes).toBe(15 * 1024 * 1024);

      const overridden = loadConfig({
        env: {
          ONES_BASE_URL: 'https://ones.example.com/',
          ONES_TEAM_UUID: 'team-env',
          ONES_MAX_READ_BYTES: '1048576'
        },
        homeDir: tempHome
      });
      expect(overridden.baseUrl).toBe('https://ones.example.com');
      expect(overridden.defaultTeamUUID).toBe('team-env');
      expect(overridden.maxReadBytes).toBe(1048576);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('falls back to auth.json baseUrl when config.json and env have no baseUrl', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-mcp-cfg-auth-'));
    try {
      const authDir = getStateDir(tempHome);
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(
        getAuthFilePath(tempHome),
        JSON.stringify({ baseUrl: 'https://from-auth.example.com', hasToken: true })
      );
      const conf = loadConfig({ env: {}, homeDir: tempHome });
      expect(conf.baseUrl).toBe('https://from-auth.example.com');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('logger & secret redaction', () => {
  it('redacts Bearer tokens, cookies, and JSON token fields', () => {
    const raw = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def cookie=sid=xyz123 "refreshToken":"rt-secret-999"';
    const clean = redactSecrets(raw);
    expect(clean).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(clean).not.toContain('sid=xyz123');
    expect(clean).not.toContain('rt-secret-999');
    expect(clean).toContain('[REDACTED]');
  });

  it('redacts entire multi-cookie headers while preserving JSON fields', () => {
    const multiCookieHeader = 'Cookie: a=1; b=2; c=3\nSet-Cookie: sid=xyz; Path=/; HttpOnly\nUser-Agent: test';
    const cleanHeader = redactSecrets(multiCookieHeader);
    expect(cleanHeader).not.toContain('a=1');
    expect(cleanHeader).not.toContain('b=2');
    expect(cleanHeader).not.toContain('c=3');
    expect(cleanHeader).not.toContain('sid=xyz');
    expect(cleanHeader).toContain('Cookie: [REDACTED]');
    expect(cleanHeader).toContain('Set-Cookie: [REDACTED]');
    expect(cleanHeader).toContain('User-Agent: test');

    const json = JSON.stringify({ cookie: 'a=1; b=2; c=3', normal: 'safe' });
    const cleanJson = redactSecrets(json);
    expect(cleanJson).toContain('"cookie":"[REDACTED]"');
    expect(cleanJson).toContain('"normal":"safe"');
  });

  it('writes logs through provided writer and respects minLevel', () => {
    const lines: string[] = [];
    const logger = createLogger({ minLevel: 'warn', write: (line) => lines.push(line) });
    logger.info('ignored info');
    logger.warn('Bearer super-secret-token failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[WARN]');
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[0]).not.toContain('super-secret-token');
  });

  it('serializes Error instances with message and stack instead of empty object', () => {
    const lines: string[] = [];
    const logger = createLogger({ minLevel: 'error', write: (line) => lines.push(line) });
    const err = new Error('Database connection failed');
    logger.error('Failed to connect', err);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[ERROR] Failed to connect Error: Database connection failed');
    expect(lines[0]).not.toContain('{}');
  });

  it('handles case-insensitive ONES_LOG_LEVEL env variable', () => {
    const origEnv = process.env.ONES_LOG_LEVEL;
    try {
      process.env.ONES_LOG_LEVEL = 'WARN';
      const lines: string[] = [];
      const logger = createLogger({ write: (line) => lines.push(line) });
      logger.info('should be ignored');
      logger.warn('should be logged');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[WARN] should be logged');
    } finally {
      process.env.ONES_LOG_LEVEL = origEnv;
    }
  });
});
