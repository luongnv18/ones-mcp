import type { RefreshManager } from '../auth/refresh-manager.js';
import { OnesApiError } from './errors.js';
import type { Logger } from './logger.js';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  isReadOnlyQuery?: boolean;
  timeoutMs?: number;
}

export interface BinaryResponse {
  buffer: Buffer;
  contentType: string;
  fileName?: string;
  contentLength?: number;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

export class OnesHttpClient {
  private readonly baseUrl: string;
  private readonly refreshManager: RefreshManager;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: {
    baseUrl: string;
    refreshManager: RefreshManager;
    fetchImpl?: typeof fetch;
    logger: Logger;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.refreshManager = options.refreshManager;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private buildUrl(
    pathOrUrl: string,
    query?: Record<string, string | number | boolean | undefined>
  ): string {
    const raw =
      pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
        ? pathOrUrl
        : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    const url = new URL(raw);
    if (query) {
      for (const [key, val] of Object.entries(query)) {
        if (val !== undefined) url.searchParams.set(key, String(val));
      }
    }
    return url.toString();
  }

  private async executeWithAuth(
    url: string,
    buildInit: (token: string) => RequestInit,
    allowTransientRetry: boolean,
    timeoutMs: number
  ): Promise<Response> {
    let forceRefresh = false;
    let didAuthRetry = false;
    let retryAttempt = 0;

    while (true) {
      const session = await this.refreshManager.getValidSession({ forceRefresh });
      forceRefresh = false;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...buildInit(session.accessToken),
          signal: controller.signal
        });
      } catch (err) {
        clearTimeout(timer);
        if (allowTransientRetry && retryAttempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[retryAttempt++];
          this.logger.warn(`Network error on ${url}, retrying in ${delay}ms`, String(err));
          await this.sleep(delay);
          continue;
        }
        throw new OnesApiError('NETWORK_ERROR', `Network request failed: ${String(err)}`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 401 && !didAuthRetry) {
        await response.body?.cancel().catch(() => {});
        didAuthRetry = true;
        forceRefresh = true;
        this.logger.warn(`Received 401 on ${url}, triggering token refresh`);
        continue;
      }

      if (
        allowTransientRetry &&
        RETRYABLE_STATUSES.has(response.status) &&
        retryAttempt < RETRY_DELAYS_MS.length
      ) {
        await response.body?.cancel().catch(() => {});
        const delay = RETRY_DELAYS_MS[retryAttempt++];
        this.logger.warn(`HTTP ${response.status} on ${url}, retrying in ${delay}ms`);
        await this.sleep(delay);
        continue;
      }

      return response;
    }
  }

  private async mapHttpFailure(response: Response): Promise<OnesApiError> {
    const text = await response.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text || undefined;
    }

    if (response.status === 401) {
      return new OnesApiError('AUTH_REQUIRED', 'Unauthorized response from ONES API.', {
        status: 401,
        details: parsed
      });
    }
    if (response.status === 403) {
      return new OnesApiError('FORBIDDEN', 'Permission denied for this ONES resource.', {
        status: 403,
        details: parsed
      });
    }
    if (response.status === 404) {
      return new OnesApiError('NOT_FOUND', 'Requested ONES resource was not found.', {
        status: 404,
        details: parsed
      });
    }
    if (response.status === 429) {
      return new OnesApiError('RATE_LIMITED', 'ONES API rate limit exceeded.', {
        status: 429,
        details: parsed
      });
    }
    return new OnesApiError('API_ERROR', `ONES API request failed with status ${response.status}`, {
      status: response.status,
      details: parsed
    });
  }

  async requestJson<T>(pathOrUrl: string, opts: HttpRequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const url = this.buildUrl(pathOrUrl, opts.query);
    const allowRetry = method === 'GET' || Boolean(opts.isReadOnlyQuery);
    const timeoutMs = opts.timeoutMs ?? 30_000;

    const response = await this.executeWithAuth(
      url,
      (token) => ({
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      }),
      allowRetry,
      timeoutMs
    );

    if (!response.ok) {
      throw await this.mapHttpFailure(response);
    }

    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async requestBinary(
    pathOrUrl: string,
    opts?: { maxBytes?: number; timeoutMs?: number }
  ): Promise<BinaryResponse> {
    const url = this.buildUrl(pathOrUrl);
    const maxBytes = opts?.maxBytes ?? 15 * 1024 * 1024;
    const response = await this.executeWithAuth(
      url,
      (token) => ({
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      }),
      true,
      opts?.timeoutMs ?? 120_000
    );

    if (!response.ok) {
      throw await this.mapHttpFailure(response);
    }

    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    if (contentLength && Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new OnesApiError(
        'VALIDATION_ERROR',
        `File size (${contentLength} bytes) exceeds max allowed read limit (${maxBytes} bytes).`
      );
    }

    const arrayBuf = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.byteLength > maxBytes) {
      throw new OnesApiError(
        'VALIDATION_ERROR',
        `Downloaded file size (${buffer.byteLength} bytes) exceeds max allowed limit (${maxBytes} bytes).`
      );
    }

    const disposition = response.headers.get('content-disposition') ?? '';
    const fnMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
    let fileName: string | undefined;
    if (fnMatch?.[1]) {
      const raw = fnMatch[1].trim();
      try {
        fileName = decodeURIComponent(raw);
      } catch {
        fileName = raw;
      }
    }

    return {
      buffer,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      fileName,
      contentLength
    };
  }

  async uploadMultipart<T>(
    pathOrUrl: string,
    formData: FormData,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    const url = this.buildUrl(pathOrUrl);
    const response = await this.executeWithAuth(
      url,
      (token) => ({
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      }),
      false,
      opts?.timeoutMs ?? 120_000
    );

    if (!response.ok) {
      throw await this.mapHttpFailure(response);
    }

    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
