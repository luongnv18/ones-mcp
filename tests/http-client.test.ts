import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenStore } from '../src/auth/token-store.js';
import { RefreshManager } from '../src/auth/refresh-manager.js';
import { OnesHttpClient } from '../src/client/http-client.js';
import { createLogger } from '../src/client/logger.js';
import { OnesApiError } from '../src/client/errors.js';

describe('OnesHttpClient', () => {
  const logger = createLogger({ write: () => {} });

  function makeClient(
    fetchImpl: typeof fetch,
    options?: { silentToken?: string; sleep?: (ms: number) => Promise<void> }
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-http-'));
    const store = new TokenStore(path.join(dir, 'auth.json'));
    store.write({
      baseUrl: 'https://ones.example.com',
      accessToken: 'initial-tok',
      teamUUID: 'team-1',
      capturedAt: Date.now()
    });

    const refreshManager = new RefreshManager({
      tokenStore: store,
      fetchImpl,
      silentBrowserRefresh: async () => ({
        baseUrl: 'https://ones.example.com',
        accessToken: options?.silentToken ?? 'refreshed-tok',
        teamUUID: 'team-1',
        capturedAt: Date.now()
      }),
      logger
    });

    const client = new OnesHttpClient({
      baseUrl: 'https://ones.example.com/',
      refreshManager,
      fetchImpl,
      logger,
      sleep: options?.sleep ?? (async () => {})
    });

    return { client, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it('getBaseUrl returns base URL without trailing slashes', () => {
    const { client, cleanup } = makeClient(vi.fn() as unknown as typeof fetch);
    try {
      expect(client.getBaseUrl()).toBe('https://ones.example.com');
    } finally {
      cleanup();
    }
  });

  it('retries once after 401 token refresh and attaches refreshed Bearer header', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const headers = new Headers(init?.headers);
      if (calls === 1) {
        expect(headers.get('Authorization')).toBe('Bearer initial-tok');
        return new Response('Unauthorized', { status: 401 });
      }
      expect(headers.get('Authorization')).toBe('Bearer refreshed-tok');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const { client, cleanup } = makeClient(fetchMock as unknown as typeof fetch);
    try {
      const res = await client.requestJson<{ ok: boolean }>('/wiki/api/wiki/team/team-1/spaces');
      expect(res.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it('retries GET and isReadOnlyQuery POST on 429/503, but never retries mutating POST on 503', async () => {
    let getCalls = 0;
    const getFetch = vi.fn(async () => {
      getCalls++;
      if (getCalls < 3) return new Response('Busy', { status: 503 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    const c1 = makeClient(getFetch as unknown as typeof fetch);
    try {
      const res = await c1.client.requestJson<{ items: unknown[] }>('/wiki/api/wiki/team/t/spaces');
      expect(res.items).toEqual([]);
      expect(getFetch).toHaveBeenCalledTimes(3);
    } finally {
      c1.cleanup();
    }

    let readOnlyPostCalls = 0;
    const readOnlyPostFetch = vi.fn(async () => {
      readOnlyPostCalls++;
      if (readOnlyPostCalls < 2) return new Response('Rate limited', { status: 429 });
      return new Response(JSON.stringify({ results: [1, 2] }), { status: 200 });
    });

    const cReadOnly = makeClient(readOnlyPostFetch as unknown as typeof fetch);
    try {
      const res = await cReadOnly.client.requestJson<{ results: number[] }>(
        '/project/api/project/team/t/tasks/query',
        {
          method: 'POST',
          body: { query: 'assignee = me' },
          isReadOnlyQuery: true
        }
      );
      expect(res.results).toEqual([1, 2]);
      expect(readOnlyPostCalls).toBe(2);
    } finally {
      cReadOnly.cleanup();
    }

    const postFetch = vi.fn(async () => new Response('Server Error', { status: 503 }));
    const c2 = makeClient(postFetch as unknown as typeof fetch);
    try {
      await expect(
        c2.client.requestJson('/project/api/project/team/t/tasks/add', {
          method: 'POST',
          body: { summary: 'Do not duplicate' }
        })
      ).rejects.toMatchObject({ code: 'API_ERROR', status: 503 } satisfies Partial<OnesApiError>);
      expect(postFetch).toHaveBeenCalledTimes(1);
    } finally {
      c2.cleanup();
    }
  });

  it('drains/cancels unconsumed response body on retryable status to avoid socket leak', async () => {
    let attempts = 0;
    const cancelSpy = vi.fn();

    const fetchMock = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel(reason) {
            cancelSpy(reason);
          }
        });
        return new Response(stream, { status: 502 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { client, cleanup } = makeClient(fetchMock as unknown as typeof fetch);
    try {
      const res = await client.requestJson<{ ok: boolean }>('/wiki/api/health');
      expect(res.ok).toBe(true);
      expect(attempts).toBe(2);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('enforces maxBytes limit in requestBinary before reading large payloads', async () => {
    const cancelSpy = vi.fn();
    const fetchMock = vi.fn(async () => {
      const stream = new ReadableStream({
        cancel: cancelSpy
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '5000' }
      });
    });

    const { client, cleanup } = makeClient(fetchMock as unknown as typeof fetch);
    try {
      await expect(
        client.requestBinary('/wiki/api/wiki/team/t/file/1', { maxBytes: 1024 })
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('5000 bytes')
      });
      expect(cancelSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('enforces maxBytes limit in requestBinary after reading when Content-Length is missing', async () => {
    const largeBuffer = Buffer.alloc(2048, 'a');
    const fetchMock = vi.fn(async () =>
      new Response(largeBuffer, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
    );

    const { client, cleanup } = makeClient(fetchMock as unknown as typeof fetch);
    try {
      await expect(
        client.requestBinary('/wiki/api/wiki/team/t/file/2', { maxBytes: 1024 })
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('2048 bytes')
      });
    } finally {
      cleanup();
    }
  });

  it('requestBinary parses fileName safely from Content-Disposition and handles malformed % escapes', async () => {
    const validFetch = vi.fn(async () =>
      new Response(Buffer.from('hello world'), {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="test%20document.txt"'
        }
      })
    );

    const { client: cValid, cleanup: clValid } = makeClient(validFetch as unknown as typeof fetch);
    try {
      const res = await cValid.requestBinary('/file/valid');
      expect(res.fileName).toBe('test document.txt');
      expect(res.contentType).toBe('text/plain');
      expect(res.buffer.toString()).toBe('hello world');
    } finally {
      clValid();
    }

    // Malformed % escape (e.g. invalid hex like %ZZ or trailing %)
    const malformedFetch = vi.fn(async () =>
      new Response(Buffer.from('corrupt name file'), {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="report_%ZZ_data.txt"'
        }
      })
    );

    const { client: cMalformed, cleanup: clMalformed } = makeClient(
      malformedFetch as unknown as typeof fetch
    );
    try {
      const res = await cMalformed.requestBinary('/file/malformed');
      expect(res.fileName).toBe('report_%ZZ_data.txt');
    } finally {
      clMalformed();
    }
  });

  it('uploadMultipart sends FormData with Authorization and supports safe JSON / text parsing', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ fileId: 'f-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const { client, cleanup } = makeClient(fetchMock as unknown as typeof fetch);
    try {
      const fd = new FormData();
      fd.append('file', new Blob(['test-content']), 'test.txt');

      const res = await client.uploadMultipart<{ fileId: string }>('/wiki/upload', fd);
      expect(res.fileId).toBe('f-123');
      expect(capturedInit?.method).toBe('POST');
      expect(new Headers(capturedInit?.headers).get('Authorization')).toBe('Bearer initial-tok');
      expect(capturedInit?.body).toBe(fd);
    } finally {
      cleanup();
    }

    // Test uploadMultipart fallback on non-JSON plain text response
    const textFetchMock = vi.fn(async () =>
      new Response('UPLOAD_SUCCESS_PLAIN_TEXT', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      })
    );
    const { client: cText, cleanup: clText } = makeClient(textFetchMock as unknown as typeof fetch);
    try {
      const fd = new FormData();
      const res = await cText.uploadMultipart<string>('/wiki/upload', fd);
      expect(res).toBe('UPLOAD_SUCCESS_PLAIN_TEXT');
    } finally {
      clText();
    }
  });

  it('maps HTTP 403, 404, 429, and 500 error responses with parsed details', async () => {
    const errorCases = [
      { status: 403, expectedCode: 'FORBIDDEN' },
      { status: 404, expectedCode: 'NOT_FOUND' },
      { status: 429, expectedCode: 'RATE_LIMITED' },
      { status: 500, expectedCode: 'API_ERROR' }
    ];

    for (const ec of errorCases) {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error_code: 'TEST_ERR', message: `fail ${ec.status}` }), {
          status: ec.status,
          headers: { 'content-type': 'application/json' }
        })
      );
      const { client, cleanup } = makeClient(fetchMock as unknown as typeof fetch);
      try {
        await expect(
          client.requestJson('/test/endpoint', { method: 'POST', body: {} })
        ).rejects.toMatchObject({
          code: ec.expectedCode,
          status: ec.status,
          details: { error_code: 'TEST_ERR', message: `fail ${ec.status}` }
        });
      } finally {
        cleanup();
      }
    }
  });

  it('retries on network errors for idempotent requests and throws NETWORK_ERROR on exhaustion', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts++;
      throw new Error('ECONNRESET');
    });

    const sleepCalls: number[] = [];
    const { client, cleanup } = makeClient(fetchMock as unknown as typeof fetch, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      }
    });

    try {
      await expect(client.requestJson('/test/network-fail')).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: expect.stringContaining('ECONNRESET')
      });
      // 1 initial + 2 retries (delays: 500ms, 1500ms)
      expect(attempts).toBe(3);
      expect(sleepCalls).toEqual([500, 1500]);
    } finally {
      cleanup();
    }
  });

  it('appends query parameters properly and handles path or full URL', async () => {
    let capturedUrl = '';
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { client, cleanup } = makeClient(fetchMock as unknown as typeof fetch);
    try {
      await client.requestJson('wiki/spaces', {
        query: { page: 1, limit: 20, active: true, unused: undefined }
      });
      expect(capturedUrl).toBe(
        'https://ones.example.com/wiki/spaces?page=1&limit=20&active=true'
      );

      // Full URL override
      await client.requestJson('https://api.other.com/v1/test', { query: { q: 'search' } });
      expect(capturedUrl).toBe('https://api.other.com/v1/test?q=search');
    } finally {
      cleanup();
    }
  });
});
