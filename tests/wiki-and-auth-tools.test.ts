import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAuthTools } from '../src/tools/auth.tools.js';
import { registerWikiTools } from '../src/tools/wiki.tools.js';
import {
  toolJson,
  resolveTeamUUID,
  withToolErrors,
  type ToolContext
} from '../src/tools/helpers.js';
import { OnesApiError } from '../src/client/errors.js';

async function connectTestServer(setup: (server: McpServer) => void) {
  const server = new McpServer({ name: 'ones-test', version: '1.0.0' });
  setup(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    config: {
      baseUrl: 'https://ones.example.com',
      defaultTeamUUID: 'TmDefault',
      maxReadBytes: 15_000_000,
      interactiveLoginTimeoutMs: 300_000,
      tokenFile: '/tmp/test-token.json',
      port: 3000,
      sessionTtlSeconds: 3600,
      refreshThresholdSeconds: 300,
      readOnlyBackoffMs: 1000,
      logLevel: 'info'
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as any,
    tokenStore: {} as any,
    refreshManager: {
      getCurrentSession: vi.fn(() => ({
        baseUrl: 'https://ones.example.com',
        accessToken: 'tok-123',
        refreshToken: 'ref-123',
        teamUUID: 'TmSession',
        userUUID: 'Usr1',
        userEmail: 'dev@example.com',
        expiresAt: Date.now() + 3_600_000,
        capturedAt: Date.now()
      }))
    } as any,
    triggerInteractiveLogin: vi.fn(async () => ({
      baseUrl: 'https://ones.example.com',
      accessToken: 'fresh-tok',
      teamUUID: 'TmFresh',
      userUUID: 'UsrFresh',
      userEmail: 'fresh@example.com',
      expiresAt: Date.now() + 7_200_000,
      capturedAt: Date.now()
    })),
    wiki: {
      listSpaces: vi.fn(async () => [
        { spaceUUID: 'Sp1', name: 'Engineering', description: 'Docs' }
      ]),
      getPageTree: vi.fn(async () => [
        { pageUUID: 'Pg1', title: 'Root Page', nodeType: 'online_page', hasChildren: true }
      ]),
      searchPages: vi.fn(async () => [
        { pageUUID: 'Pg2', spaceUUID: 'Sp1', title: 'Architecture Guide', matchSnippet: 'Arch...' }
      ]),
      getPage: vi.fn(async () => ({
        pageUUID: 'Pg9',
        spaceUUID: 'Sp2',
        title: 'Specs',
        nodeType: 'online_page' as const,
        url: 'https://ones.example.com/wiki/#/team/Tm1/space/Sp2/page/Pg9',
        markdown: '# Specs\nHello world',
        children: [{ pageUUID: 'Pg10', title: 'Sub', nodeType: 'online_page', hasChildren: false }]
      })),
      createPage: vi.fn(async () => ({
        pageUUID: 'PgNew',
        spaceUUID: 'Sp1',
        title: 'New Page',
        url: 'https://ones.example.com/wiki/#/team/TmSession/space/Sp1/page/PgNew'
      })),
      updatePage: vi.fn(async () => ({
        pageUUID: 'Pg9',
        spaceUUID: 'Sp2',
        title: 'Updated Specs',
        version: 2
      })),
      listComments: vi.fn(async () => [
        { commentUUID: 'Cm1', content: 'Looks good', userUUID: 'Usr1', createdAt: 1700000000 }
      ]),
      addComment: vi.fn(async () => ({
        commentUUID: 'CmNew',
        pageUUID: 'Pg9',
        content: 'Nice writeup'
      }))
    } as any,
    project: {} as any,
    issue: {} as any,
    worklog: {} as any,
    attachment: {} as any,
    ...overrides
  };
}

describe('Tool Helpers', () => {
  it('toolJson formats data into text content block', () => {
    const res = toolJson({ foo: 'bar', count: 42 });
    expect(res).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ foo: 'bar', count: 42 }, null, 2)
        }
      ]
    });
  });

  describe('resolveTeamUUID', () => {
    it('prefers explicit teamUUID', () => {
      const ctx = createMockContext();
      const team = resolveTeamUUID(ctx, 'TmExplicit', 'TmParsed');
      expect(team).toBe('TmExplicit');
    });

    it('falls back to parsed teamUUID if explicit is absent or empty', () => {
      const ctx = createMockContext();
      const team = resolveTeamUUID(ctx, '   ', 'TmParsed');
      expect(team).toBe('TmParsed');
    });

    it('falls back to active session teamUUID if explicit and parsed are absent', () => {
      const ctx = createMockContext();
      const team = resolveTeamUUID(ctx);
      expect(team).toBe('TmSession');
    });

    it('falls back to config defaultTeamUUID if session has no teamUUID', () => {
      const ctx = createMockContext({
        refreshManager: {
          getCurrentSession: () => null
        } as any
      });
      const team = resolveTeamUUID(ctx);
      expect(team).toBe('TmDefault');
    });

    it('throws VALIDATION_ERROR when no teamUUID is found anywhere', () => {
      const ctx = createMockContext({
        config: { ...createMockContext().config, defaultTeamUUID: undefined },
        refreshManager: {
          getCurrentSession: () => null
        } as any
      });
      expect(() => resolveTeamUUID(ctx)).toThrow(OnesApiError);
      expect(() => resolveTeamUUID(ctx)).toThrowError(/Missing teamUUID/);
    });
  });

  describe('withToolErrors', () => {
    it('returns result when wrapped function succeeds', async () => {
      const res = await withToolErrors(async () => toolJson({ success: true }));
      expect(res).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }]
      });
    });

    it('catches OnesApiError and returns formatted MCP error with isError: true', async () => {
      const res = await withToolErrors(async () => {
        throw new OnesApiError('AUTH_REQUIRED', 'Please log in');
      });
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain('[AUTH_REQUIRED] Please log in');
      expect((res.content[0] as { text: string }).text).toContain('ones_login');
    });

    it('catches generic Error and formats as API_ERROR', async () => {
      const res = await withToolErrors(async () => {
        throw new Error('Unexpected crash');
      });
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain('[API_ERROR] Unexpected crash');
    });

    it('supports union types such as image and text content blocks', async () => {
      const resImage = await withToolErrors(async () => {
        return {
          content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }]
        };
      });
      expect(resImage.content).toEqual([
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]);
    });
  });
});

describe('Auth Tools', () => {
  it('ones_auth_status reports active session details', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerAuthTools(srv, ctx);
    });

    try {
      const res = await client.callTool({ name: 'ones_auth_status', arguments: {} });
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toMatchObject({
        authenticated: true,
        baseUrl: 'https://ones.example.com',
        teamUUID: 'TmSession',
        userUUID: 'Usr1',
        userEmail: 'dev@example.com',
        hasRefreshToken: true
      });
      expect(typeof data.expiresInSeconds).toBe('number');
    } finally {
      await close();
    }
  });

  it('ones_auth_status reports not logged in when session is null', async () => {
    const ctx = createMockContext({
      refreshManager: {
        getCurrentSession: () => null
      } as any
    });
    const { client, close } = await connectTestServer((srv) => {
      registerAuthTools(srv, ctx);
    });

    try {
      const res = await client.callTool({ name: 'ones_auth_status', arguments: {} });
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toEqual({
        authenticated: false,
        baseUrl: 'https://ones.example.com',
        message: 'Not logged in. Call `ones_login` or run `ones-mcp login` in your terminal.'
      });
    } finally {
      await close();
    }
  });

  it('ones_login triggers interactive login and returns new session', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerAuthTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_login',
        arguments: { timeoutSeconds: 60 }
      });
      expect(ctx.triggerInteractiveLogin).toHaveBeenCalledWith(60_000);
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toMatchObject({
        authenticated: true,
        baseUrl: 'https://ones.example.com',
        teamUUID: 'TmFresh',
        userEmail: 'fresh@example.com'
      });

      await client.callTool({
        name: 'ones_login',
        arguments: { timeoutSeconds: 120, baseUrl: 'https://custom.example.com' }
      });
      expect(ctx.triggerInteractiveLogin).toHaveBeenCalledWith(120_000, 'https://custom.example.com');
    } finally {
      await close();
    }
  });
});

describe('Wiki Tools', () => {
  it('ones_wiki_list_spaces lists spaces with pagination', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_wiki_list_spaces',
        arguments: { limit: 10, offset: 5, teamUUID: 'TmExplicit' }
      });
      expect(ctx.wiki.listSpaces).toHaveBeenCalledWith({
        teamUUID: 'TmExplicit',
        limit: 10,
        offset: 5
      });
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toMatchObject({
        teamUUID: 'TmExplicit',
        count: 1,
        spaces: [{ spaceUUID: 'Sp1' }]
      });
    } finally {
      await close();
    }
  });

  it('ones_wiki_get_page_tree resolves space URL and fetches tree', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_wiki_get_page_tree',
        arguments: {
          spaceOrUrl: 'https://ones.example.com/wiki/#/team/Tm1/space/Sp2',
          maxDepth: 2
        }
      });
      expect(ctx.wiki.getPageTree).toHaveBeenCalledWith({
        teamUUID: 'Tm1',
        spaceUUID: 'Sp2',
        parentPageUUID: undefined,
        maxDepth: 2
      });
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toMatchObject({
        teamUUID: 'Tm1',
        spaceUUID: 'Sp2',
        tree: [{ pageUUID: 'Pg1' }]
      });
    } finally {
      await close();
    }
  });

  it('ones_wiki_get_page_tree handles page URL as spaceOrUrl and uses pageUUID as parent', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      await client.callTool({
        name: 'ones_wiki_get_page_tree',
        arguments: {
          spaceOrUrl: 'https://ones.example.com/wiki/#/team/Tm1/space/Sp2/page/Pg9'
        }
      });
      expect(ctx.wiki.getPageTree).toHaveBeenCalledWith({
        teamUUID: 'Tm1',
        spaceUUID: 'Sp2',
        parentPageUUID: 'Pg9',
        maxDepth: 3
      });
    } finally {
      await close();
    }
  });

  it('ones_wiki_search searches wiki pages', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_wiki_search',
        arguments: { query: 'Architecture', spaceUUID: 'Sp1', limit: 5 }
      });
      expect(ctx.wiki.searchPages).toHaveBeenCalledWith({
        teamUUID: 'TmSession',
        query: 'Architecture',
        spaceUUID: 'Sp1',
        limit: 5,
        offset: 0
      });
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toMatchObject({
        teamUUID: 'TmSession',
        count: 1,
        results: [{ pageUUID: 'Pg2' }]
      });
    } finally {
      await close();
    }
  });

  it('ones_wiki_get_page parses wiki page URL and options', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_wiki_get_page',
        arguments: {
          pageOrUrl: 'https://ones.example.com/wiki/#/team/Tm1/space/Sp2/page/Pg9',
          includeChildren: true,
          format: 'markdown',
          maxDepth: 2,
          maxPages: 5,
          maxTotalChars: 10000
        }
      });
      expect(ctx.wiki.getPage).toHaveBeenCalledWith({
        teamUUID: 'Tm1',
        spaceUUID: 'Sp2',
        pageUUID: 'Pg9',
        format: 'markdown',
        includeChildren: true,
        maxDepth: 2,
        maxPages: 5,
        maxTotalChars: 10000
      });
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toMatchObject({
        pageUUID: 'Pg9',
        title: 'Specs',
        markdown: '# Specs\nHello world'
      });
    } finally {
      await close();
    }
  });

  it('ones_wiki_create_page creates page under space and parent page', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_wiki_create_page',
        arguments: {
          spaceOrUrl: 'https://ones.example.com/wiki/#/team/Tm1/space/Sp1',
          parentPageOrUrl: 'PgParent',
          title: 'Design Doc',
          markdown: '# Design'
        }
      });
      expect(ctx.wiki.createPage).toHaveBeenCalledWith({
        teamUUID: 'Tm1',
        spaceUUID: 'Sp1',
        parentPageUUID: 'PgParent',
        title: 'Design Doc',
        markdown: '# Design'
      });
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toMatchObject({
        pageUUID: 'PgNew'
      });
    } finally {
      await close();
    }
  });

  it('ones_wiki_create_page rejects when neither space nor parent page provided', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_wiki_create_page',
        arguments: {
          title: 'Orphan Page',
          markdown: '# Orphan'
        }
      });
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain('Provide spaceOrUrl or a parentPageOrUrl');
    } finally {
      await close();
    }
  });

  it('ones_wiki_update_page updates title and content with replace/append mode', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_wiki_update_page',
        arguments: {
          pageOrUrl: 'https://ones.example.com/wiki/#/team/Tm1/space/Sp2/page/Pg9',
          title: 'Updated Specs',
          markdown: '## New Section',
          mode: 'append'
        }
      });
      expect(ctx.wiki.updatePage).toHaveBeenCalledWith({
        teamUUID: 'Tm1',
        pageUUID: 'Pg9',
        title: 'Updated Specs',
        markdown: '## New Section',
        mode: 'append'
      });
      const data = JSON.parse((res.content[0] as { text: string }).text);
      expect(data).toMatchObject({
        pageUUID: 'Pg9',
        version: 2
      });
    } finally {
      await close();
    }
  });

  it('ones_wiki_update_page validates that at least title or markdown is provided', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const res = await client.callTool({
        name: 'ones_wiki_update_page',
        arguments: {
          pageOrUrl: 'Pg9'
        }
      });
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain(
        'Provide at least title or markdown to update'
      );
    } finally {
      await close();
    }
  });

  it('ones_wiki_list_comments and ones_wiki_add_comment work with page URL or UUID', async () => {
    const ctx = createMockContext();
    const { client, close } = await connectTestServer((srv) => {
      registerWikiTools(srv, ctx);
    });

    try {
      const listRes = await client.callTool({
        name: 'ones_wiki_list_comments',
        arguments: {
          pageOrUrl: 'https://ones.example.com/wiki/#/team/Tm1/space/Sp2/page/Pg9',
          limit: 10
        }
      });
      expect(ctx.wiki.listComments).toHaveBeenCalledWith({
        teamUUID: 'Tm1',
        pageUUID: 'Pg9',
        limit: 10,
        offset: 0
      });
      const listData = JSON.parse((listRes.content[0] as { text: string }).text);
      expect(listData).toMatchObject({
        pageUUID: 'Pg9',
        count: 1,
        comments: [{ commentUUID: 'Cm1' }]
      });

      const addRes = await client.callTool({
        name: 'ones_wiki_add_comment',
        arguments: {
          pageOrUrl: 'Pg9',
          content: 'Nice writeup',
          teamUUID: 'TmCustom'
        }
      });
      expect(ctx.wiki.addComment).toHaveBeenCalledWith({
        teamUUID: 'TmCustom',
        pageUUID: 'Pg9',
        content: 'Nice writeup'
      });
      const addData = JSON.parse((addRes.content[0] as { text: string }).text);
      expect(addData).toMatchObject({
        commentUUID: 'CmNew',
        pageUUID: 'Pg9'
      });
    } finally {
      await close();
    }
  });
});
