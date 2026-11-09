import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAuthFilePath, getConfigFilePath, getStateDir } from './paths.js';

export const DEFAULT_BASE_URL = '';
export const DEFAULT_MAX_READ_BYTES = 15 * 1024 * 1024;

export interface OnesConfig {
  baseUrl: string;
  defaultTeamUUID?: string;
  browserPath?: string;
  maxReadBytes: number;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function readDiskConfig(homeDir: string): Partial<OnesConfig> {
  const filePath = getConfigFilePath(homeDir);
  let config: Partial<OnesConfig> = {};
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      config = JSON.parse(raw) as Partial<OnesConfig>;
    } catch {
      config = {};
    }
  }

  if (!config.baseUrl) {
    const authPath = getAuthFilePath(homeDir);
    if (fs.existsSync(authPath)) {
      try {
        const rawAuth = fs.readFileSync(authPath, 'utf8');
        const parsed = JSON.parse(rawAuth) as { baseUrl?: unknown };
        if (typeof parsed?.baseUrl === 'string' && parsed.baseUrl.trim()) {
          config.baseUrl = parsed.baseUrl.trim();
        }
      } catch {
        // ignore malformed auth.json
      }
    }
  }

  return config;
}

export function loadConfig(options?: { env?: NodeJS.ProcessEnv; homeDir?: string }): OnesConfig {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const disk = readDiskConfig(homeDir);

  const rawBaseUrl = env.ONES_BASE_URL?.trim() || disk.baseUrl || DEFAULT_BASE_URL;
  const rawMaxBytes = env.ONES_MAX_READ_BYTES ? Number(env.ONES_MAX_READ_BYTES) : disk.maxReadBytes;
  const maxReadBytes =
    typeof rawMaxBytes === 'number' && Number.isFinite(rawMaxBytes) && rawMaxBytes > 0
      ? Math.floor(rawMaxBytes)
      : DEFAULT_MAX_READ_BYTES;

  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    defaultTeamUUID: env.ONES_TEAM_UUID?.trim() || disk.defaultTeamUUID,
    browserPath: env.ONES_BROWSER_PATH?.trim() || disk.browserPath,
    maxReadBytes
  };
}

export function saveConfig(
  partial: Partial<OnesConfig>,
  options?: { homeDir?: string }
): OnesConfig {
  const homeDir = options?.homeDir ?? os.homedir();
  const stateDir = getStateDir(homeDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const current = loadConfig({ env: {}, homeDir });
  const merged: OnesConfig = {
    baseUrl: normalizeBaseUrl(partial.baseUrl ?? current.baseUrl),
    defaultTeamUUID: partial.defaultTeamUUID ?? current.defaultTeamUUID,
    browserPath: partial.browserPath ?? current.browserPath,
    maxReadBytes: partial.maxReadBytes ?? current.maxReadBytes
  };

  const filePath = getConfigFilePath(homeDir);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  return merged;
}
