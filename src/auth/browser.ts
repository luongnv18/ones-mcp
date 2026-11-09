import fs from 'node:fs';
import path from 'node:path';
import { OnesApiError } from '../client/errors.js';

export interface DetectedBrowser {
  executablePath?: string;
  channel?: 'chrome' | 'msedge';
  source: string;
}

const DARWIN_CANDIDATES = [
  { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', source: 'macOS Chrome' },
  { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', source: 'macOS Edge' },
  { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', source: 'macOS Chromium' }
];

const LINUX_CANDIDATES = [
  { path: '/usr/bin/google-chrome', source: 'Linux Chrome' },
  { path: '/usr/bin/google-chrome-stable', source: 'Linux Chrome Stable' },
  { path: '/usr/bin/microsoft-edge', source: 'Linux Edge' },
  { path: '/usr/bin/chromium', source: 'Linux Chromium' },
  { path: '/usr/bin/chromium-browser', source: 'Linux Chromium' }
];

function getWinCandidates(env: NodeJS.ProcessEnv = process.env): Array<{ path: string; source: string }> {
  const roots = [
    env['PROGRAMFILES'],
    env['PROGRAMFILES(X86)'],
    env['LOCALAPPDATA'],
    'C:\\Program Files',
    'C:\\Program Files (x86)'
  ].filter((v): v is string => Boolean(v));

  const out: Array<{ path: string; source: string }> = [];
  for (const root of roots) {
    out.push({ path: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), source: 'Windows Chrome' });
    out.push({ path: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), source: 'Windows Edge' });
  }
  return out;
}

export function detectBrowserExecutable(options?: {
  envPath?: string;
  platform?: NodeJS.Platform;
  existsSync?: (p: string) => boolean;
}): DetectedBrowser {
  const exists = options?.existsSync ?? fs.existsSync;
  const platform = options?.platform ?? process.platform;

  if (options?.envPath) {
    if (!exists(options.envPath)) {
      throw new OnesApiError(
        'VALIDATION_ERROR',
        `ONES_BROWSER_PATH does not exist: ${options.envPath}`
      );
    }
    return { executablePath: options.envPath, source: 'ONES_BROWSER_PATH' };
  }

  const candidates =
    platform === 'darwin'
      ? DARWIN_CANDIDATES
      : platform === 'win32'
        ? getWinCandidates()
        : LINUX_CANDIDATES;

  for (const c of candidates) {
    if (exists(c.path)) {
      return { executablePath: c.path, source: c.source };
    }
  }

  return { channel: 'chrome', source: 'playwright-channel-chrome' };
}
