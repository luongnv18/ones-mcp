import fs from 'node:fs';
import { chromium, type BrowserContext, type Request, type Response } from 'playwright-core';
import { getBrowserProfileDir } from '../config/paths.js';
import { OnesApiError } from '../client/errors.js';
import type { Logger } from '../client/logger.js';
import { detectBrowserExecutable } from './browser.js';
import { getTokenExpiresAt } from './jwt.js';
import type { AuthSession } from './token-store.js';

export function extractCapturedToken(headers: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' && /^Bearer\s+\S+/i.test(v)) {
      return v.replace(/^Bearer\s+/i, '').trim();
    }
  }
  return undefined;
}

export function extractTeamUUIDFromUrl(url: string): string | undefined {
  const match = url.match(/\/team\/([^/?#]+)/);
  return match?.[1];
}

async function launchPersistentBrowser(options: {
  headless: boolean;
  profileDir: string;
  browserPath?: string;
}): Promise<BrowserContext> {
  fs.mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  const detected = detectBrowserExecutable({ envPath: options.browserPath });

  return chromium.launchPersistentContext(options.profileDir, {
    headless: options.headless,
    executablePath: detected.executablePath,
    channel: detected.executablePath ? undefined : detected.channel,
    viewport: options.headless ? { width: 1280, height: 800 } : null
  });
}

async function captureSessionFromBrowser(options: {
  baseUrl: string;
  headless: boolean;
  profileDir: string;
  browserPath?: string;
  timeoutMs: number;
  logger: Logger;
}): Promise<AuthSession | null> {
  const context = await launchPersistentBrowser({
    headless: options.headless,
    profileDir: options.profileDir,
    browserPath: options.browserPath
  });

  let timer: NodeJS.Timeout | undefined;

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    let accessToken: string | undefined;
    let refreshToken: string | undefined;
    let refreshEndpoint: string | undefined;
    let expiresAt: number | undefined;
    let teamUUID: string | undefined;
    let userUUID: string | undefined;
    let userEmail: string | undefined;

    const resultPromise = new Promise<AuthSession | null>((resolve) => {
      let settled = false;

      const finishWithNull = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(null);
      };

      timer = setTimeout(() => {
        finishWithNull();
      }, options.timeoutMs);

      const maybeFinish = async () => {
        if (settled || !accessToken || !teamUUID) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const rawCookies = await context.cookies(options.baseUrl).catch(() => []);
        const cookies = rawCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path
        }));
        resolve({
          baseUrl: options.baseUrl,
          accessToken,
          refreshToken,
          refreshEndpoint,
          expiresAt: expiresAt ?? getTokenExpiresAt(accessToken),
          teamUUID,
          userUUID,
          userEmail,
          cookies,
          capturedAt: Date.now()
        });
      };

      page.on('close', finishWithNull);
      context.on('close', finishWithNull);

      page.on('request', (req: Request) => {
        const url = req.url();
        if (!url.startsWith(options.baseUrl)) return;
        if (url.includes('/wiki/api/wiki/') || url.includes('/project/api/project/')) {
          const tok = extractCapturedToken(req.headers());
          if (tok) accessToken = tok;
          const tId = extractTeamUUIDFromUrl(url);
          if (tId) teamUUID = tId;
          void maybeFinish();
        }
      });

      page.on('response', async (res: Response) => {
        const url = res.url();
        if (!url.startsWith(options.baseUrl)) return;
        const tId = extractTeamUUIDFromUrl(url);
        if (tId) teamUUID = tId;

        if (
          res.status() === 200 &&
          (url.includes('/oauth2/token') ||
            url.includes('/auth/login') ||
            url.includes('/auth/token') ||
            url.includes('/auth/refresh'))
        ) {
          try {
            const json = (await res.json()) as Record<string, unknown>;
            if (typeof json.access_token === 'string') accessToken = json.access_token;
            if (typeof json.refresh_token === 'string') {
              refreshToken = json.refresh_token;
              refreshEndpoint = url;
            }
            if (typeof json.expires_in === 'number') {
              expiresAt = Date.now() + json.expires_in * 1000;
            }
            const userObj = json.user as Record<string, unknown> | undefined;
            if (userObj && typeof userObj.uuid === 'string') userUUID = userObj.uuid;
            if (userObj && typeof userObj.email === 'string') userEmail = userObj.email;
          } catch {
            // Non-JSON response ignored
          }
        }
        await maybeFinish();
      });

      page.on('framenavigated', () => {
        const tId = extractTeamUUIDFromUrl(page.url());
        if (tId) {
          teamUUID = tId;
          void maybeFinish();
        }
      });
    });

    await page.goto(options.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs
    });
    const captured = await resultPromise;
    if (captured) return captured;

    // If token was captured from API calls without teamUUID in URL, return partial session
    if (accessToken) {
      return {
        baseUrl: options.baseUrl,
        accessToken,
        refreshToken,
        refreshEndpoint,
        expiresAt: expiresAt ?? getTokenExpiresAt(accessToken),
        teamUUID,
        userUUID,
        userEmail,
        capturedAt: Date.now()
      };
    }

    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    await context.close().catch((err) => {
      options.logger.warn('Failed to close browser context cleanly', String(err));
    });
  }
}

export async function runInteractiveBrowserLogin(options: {
  baseUrl: string;
  profileDir?: string;
  browserPath?: string;
  timeoutMs?: number;
  logger: Logger;
}): Promise<AuthSession> {
  const session = await captureSessionFromBrowser({
    baseUrl: options.baseUrl,
    headless: false,
    profileDir: options.profileDir ?? getBrowserProfileDir(),
    browserPath: options.browserPath,
    timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
    logger: options.logger
  });

  if (!session) {
    throw new OnesApiError(
      'AUTH_REQUIRED',
      'Timed out waiting for ONES login completion in the browser. Please retry and finish 2FA OTP verification.'
    );
  }
  return session;
}

export async function trySilentBrowserRefresh(options: {
  baseUrl: string;
  profileDir?: string;
  browserPath?: string;
  timeoutMs?: number;
  logger: Logger;
}): Promise<AuthSession | null> {
  try {
    return await captureSessionFromBrowser({
      baseUrl: options.baseUrl,
      headless: true,
      profileDir: options.profileDir ?? getBrowserProfileDir(),
      browserPath: options.browserPath,
      timeoutMs: options.timeoutMs ?? 12_000,
      logger: options.logger
    });
  } catch (err) {
    options.logger.warn('Silent browser refresh failed', String(err));
    return null;
  }
}
