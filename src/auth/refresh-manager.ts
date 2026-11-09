import { OnesApiError } from '../client/errors.js';
import type { Logger } from '../client/logger.js';
import { getTokenExpiresAt, isTokenExpiringSoon } from './jwt.js';
import type { AuthSession, TokenStore } from './token-store.js';

export interface RefreshDependencies {
  tokenStore: TokenStore;
  fetchImpl: typeof fetch;
  silentBrowserRefresh: () => Promise<AuthSession | null>;
  logger: Logger;
  now?: () => number;
}

export class RefreshManager {
  private readonly deps: RefreshDependencies;
  private activeRefresh: Promise<AuthSession> | null = null;

  constructor(deps: RefreshDependencies) {
    this.deps = deps;
  }

  getCurrentSession(): AuthSession | null {
    return this.deps.tokenStore.read();
  }

  async getValidSession(options?: { forceRefresh?: boolean }): Promise<AuthSession> {
    const nowMs = this.deps.now?.() ?? Date.now();
    const existing = this.deps.tokenStore.read();

    if (!existing) {
      throw new OnesApiError('AUTH_REQUIRED', 'Not logged in to ONES.');
    }

    const expiresAt = existing.expiresAt ?? getTokenExpiresAt(existing.accessToken);
    const needsRefresh = Boolean(options?.forceRefresh) || isTokenExpiringSoon(expiresAt, 300, nowMs);

    if (!needsRefresh) {
      return existing;
    }

    if (!this.activeRefresh) {
      this.activeRefresh = this.performRefresh(existing).finally(() => {
        this.activeRefresh = null;
      });
    }

    return this.activeRefresh;
  }

  private async performRefresh(existing: AuthSession): Promise<AuthSession> {
    const nowMs = this.deps.now?.() ?? Date.now();

    // Tier 1: Direct refresh token endpoint if captured
    if (existing.refreshToken && existing.refreshEndpoint) {
      try {
        this.deps.logger.info('Attempting Tier 1 direct refresh_token renewal');
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: existing.refreshToken
        });
        const res = await this.deps.fetchImpl(existing.refreshEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });

        if (res.ok) {
          const json = (await res.json()) as Record<string, unknown>;
          if (typeof json.access_token === 'string' && json.access_token) {
            const newExpiresAt =
              typeof json.expires_in === 'number'
                ? nowMs + json.expires_in * 1000
                : getTokenExpiresAt(json.access_token);
            const updated: AuthSession = {
              ...existing,
              accessToken: json.access_token,
              refreshToken:
                typeof json.refresh_token === 'string' ? json.refresh_token : existing.refreshToken,
              expiresAt: newExpiresAt,
              capturedAt: nowMs
            };
            this.deps.tokenStore.write(updated);
            return updated;
          }
        }
        this.deps.logger.warn(`Tier 1 refresh returned HTTP ${res.status}, falling back to Tier 2`);
      } catch (err) {
        this.deps.logger.warn('Tier 1 refresh error, falling back to Tier 2', String(err));
      }
    }

    // Tier 2: Silent headless browser session renewal
    this.deps.logger.info('Attempting Tier 2 silent headless browser refresh');
    const refreshed = await this.deps.silentBrowserRefresh();
    if (refreshed?.accessToken) {
      const merged: AuthSession = {
        ...existing,
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? existing.refreshToken,
        refreshEndpoint: refreshed.refreshEndpoint ?? existing.refreshEndpoint,
        cookies: refreshed.cookies ?? existing.cookies,
        teamUUID: refreshed.teamUUID ?? existing.teamUUID,
        userUUID: refreshed.userUUID ?? existing.userUUID,
        userEmail: refreshed.userEmail ?? existing.userEmail
      };
      this.deps.tokenStore.write(merged);
      return merged;
    }

    // Tier 3: Session expired completely; interactive login + OTP required
    throw new OnesApiError(
      'AUTH_REQUIRED',
      'ONES session expired and automatic refresh failed (2FA OTP re-login required).'
    );
  }
}
