import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAllTools } from '../src/tools/register-all.js';
import { createOnesMcpServer } from '../src/server.js';
import type { ToolContext } from '../src/tools/helpers.js';
import { OnesApiError } from '../src/client/errors.js';

const EXPECTED_26_TOOLS = [
  'ones_auth_status',
  'ones_login',
  'ones_wiki_list_spaces',
  'ones_wiki_get_page_tree',
  'ones_wiki_search',
  'ones_wiki_get_page',
  'ones_wiki_create_page',
  'ones_wiki_update_page',
  'ones_wiki_list_comments',
  'ones_wiki_add_comment',
  'ones_project_list',
  'ones_project_get_metadata',
  'ones_issue_search',
  'ones_issue_get',
  'ones_issue_create',
  'ones_issue_update',
  'ones_issue_transition',
  'ones_issue_list_comments',
  'ones_issue_add_comment',
  'ones_issue_update_comment',
  'ones_worklog_list',
  'ones_worklog_add',
  'ones_attachment_list',
  'ones_attachment_read',
  'ones_attachment_download',
  'ones_attachment_upload'
].sort();

async function connectServer(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
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
      maxReadBytes: 15_000_000
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
        teamUUID: 'TmSession',
        userUUID: 'Usr1',
        userEmail: 'dev@example.com',
        expiresAt: Date.now() + 3_600_000,
        capturedAt: Date.now()
      }))
    } as any,
    triggerInteractiveLogin: vi.fn(),
    wiki: {} as any,
    project: {
      listProjects: vi.fn(async () => [
        { projectUUID: 'Prj1', name: 'Alpha', key: 'ALP', status: 'normal' }
      ]),
      getProjectMetadata: vi.fn(async () => ({
        projectUUID: 'Prj1',
        issueTypes: [{ uuid: 'it-bug', name: 'Bug' }],
        statuses: [{ uuid: 'st-open', name: 'Open' }],
        priorities: [{ uuid: 'pr-high', name: 'High' }],
        sprints: [{ uuid: 'sp-1', name: 'Sprint 1' }],
        members: [{ uuid: 'mb-1', name: 'Alice' }],
        customFields: [{ uuid: 'cf-1', name: 'Severity' }]
      }))
    } as any,
    issue: {
      searchIssues: vi.fn(async () => [
        {
          issueUUID: 'iss-1',
          number: 101,
          summary: 'Issue 101',
          projectUUID: 'Prj1',
          url: 'https://ones.example.com/project/#/team/TmSession/project/Prj1/issue/iss-1'
        }
      ]),
      getIssue: vi.fn(async () => ({
        issueUUID: 'iss-1',
        number: 101,
        summary: 'Issue 101',
        descriptionMarkdown: 'Detailed description',
        status: 'Open',
        customFields: {},
        transitions: [{ uuid: 'tr-1', name: 'Close', targetStatus: 'Closed' }],
        comments: []
      })),
      createIssue: vi.fn(async () => ({
        issueUUID: 'iss-new',
        url: 'https://ones.example.com/project/#/team/TmSession/project/Prj1/issue/iss-new'
      })),
      updateIssue: vi.fn(async () => ({
        issueUUID: 'iss-1'
      })),
      transitionIssue: vi.fn(async () => ({
        issueUUID: 'iss-1',
        transitionUUID: 'tr-1',
        targetStatus: 'Closed'
      })),
      listComments: vi.fn(async () => [
        { commentUUID: 'cm-1', content: 'First comment', userUUID: 'Usr1', createdAt: 1700000000 }
      ]),
      addComment: vi.fn(async () => ({
        commentUUID: 'cm-new'
      })),
      updateComment: vi.fn(async () => ({
        commentUUID: 'cm-1'
      }))
    } as any,
    worklog: {
      listWorklogs: vi.fn(async () => [
        { worklogUUID: 'wl-1', hours: 2.5, startTime: 1700000000, description: 'Coding' }
      ]),
      addWorklog: vi.fn(async () => ({
        worklogUUID: 'wl-new'
      }))
    } as any,
    attachment: {
      listAttachments: vi.fn(async () => [
        { attachmentUUID: 'att-1', name: 'spec.pdf', size: 1024, downloadUrl: '/file/att-1' }
      ]),
      readAttachment: vi.fn(async () => ({
        kind: 'text' as const,
        text: 'Document content',
        fileName: 'spec.txt'
      })),
      downloadAttachment: vi.fn(async () => ({
        savedPath: '/tmp/spec.pdf',
        bytes: 1024
      })),
      uploadAttachment: vi.fn(async () => ({
        attachmentUUID: 'att-new',
        name: 'upload.png'
      }))
    } as any,
    ...overrides
  };
}

describe('Task 10: Project, Issue, Worklog, Attachment MCP Tools and Server Entrypoint', () => {
  it('registers all 26 tools via registerAllTools', async () => {
    const ctx = createMockContext();
    const server = new McpServer({ name: 'ones-all-tools-test', version: '1.0.0' });
    registerAllTools(server, ctx);

    const { client, close } = await connectServer(server);
    try {
      const res = await client.listTools();
      const toolNames = res.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual(EXPECTED_26_TOOLS);
      expect(toolNames.length).toBe(26);
    } finally {
      await close();
    }
  });

  describe('Project Tools', () => {
    it('ones_project_list passes query, limit, offset, and resolved teamUUID', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_project_list',
          arguments: { query: 'Alpha', limit: 10, offset: 5, teamUUID: 'TmCustom' }
        });
        expect(ctx.project.listProjects).toHaveBeenCalledWith({
          teamUUID: 'TmCustom',
          query: 'Alpha',
          limit: 10,
          offset: 5
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({
          teamUUID: 'TmCustom',
          count: 1,
          projects: [{ projectUUID: 'Prj1', name: 'Alpha' }]
        });
      } finally {
        await close();
      }
    });

    it('ones_project_get_metadata resolves URL reference and retrieves metadata', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_project_get_metadata',
          arguments: {
            projectOrUrl: 'https://ones.example.com/project/#/team/TmUrl/project/Prj1'
          }
        });
        expect(ctx.project.getProjectMetadata).toHaveBeenCalledWith({
          teamUUID: 'TmUrl',
          projectUUID: 'Prj1'
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({
          projectUUID: 'Prj1',
          issueTypes: [{ uuid: 'it-bug', name: 'Bug' }]
        });
      } finally {
        await close();
      }
    });
  });

  describe('Issue Tools', () => {
    it('ones_issue_search searches by project, keyword, status, assignee, sprint, and issueType', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_issue_search',
          arguments: {
            projectOrUrl: 'https://ones.example.com/project/#/team/TmUrl/project/Prj1',
            query: 'login',
            status: 'Open',
            assigneeUUID: 'Usr1',
            sprintUUID: 'sp-1',
            issueType: 'Bug',
            limit: 15,
            offset: 0
          }
        });
        expect(ctx.issue.searchIssues).toHaveBeenCalledWith({
          teamUUID: 'TmUrl',
          projectUUID: 'Prj1',
          query: 'login',
          status: 'Open',
          assigneeUUID: 'Usr1',
          sprintUUID: 'sp-1',
          issueType: 'Bug',
          limit: 15,
          offset: 0
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({
          teamUUID: 'TmUrl',
          count: 1,
          issues: [{ issueUUID: 'iss-1', number: 101 }]
        });
      } finally {
        await close();
      }
    });

    it('ones_issue_get fetches issue details by UUID or URL', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_issue_get',
          arguments: {
            issueOrUrl: 'https://ones.example.com/project/#/team/TmUrl/project/Prj1/issue/iss-1'
          }
        });
        expect(ctx.issue.getIssue).toHaveBeenCalledWith({
          teamUUID: 'TmUrl',
          issueUUID: 'iss-1'
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({
          issueUUID: 'iss-1',
          summary: 'Issue 101'
        });
      } finally {
        await close();
      }
    });

    it('ones_issue_create creates a new issue with project URL and options', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_issue_create',
          arguments: {
            projectOrUrl: 'https://ones.example.com/project/#/team/Tm1/project/P1',
            issueType: 'it-bug',
            summary: 'Fix 2FA login redirect',
            descriptionMarkdown: '# Details\nNeed fix',
            assigneeUUID: 'Usr1',
            priority: 'pr-high',
            sprintUUID: 'sp-1',
            parentIssueUUID: 'iss-parent',
            customFields: { field_1: 'val' }
          }
        });
        expect(ctx.issue.createIssue).toHaveBeenCalledWith({
          teamUUID: 'Tm1',
          projectUUID: 'P1',
          issueType: 'it-bug',
          summary: 'Fix 2FA login redirect',
          descriptionMarkdown: '# Details\nNeed fix',
          assigneeUUID: 'Usr1',
          priority: 'pr-high',
          sprintUUID: 'sp-1',
          parentIssueUUID: 'iss-parent',
          customFields: { field_1: 'val' }
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({
          issueUUID: 'iss-new',
          url: expect.stringContaining('iss-new')
        });
      } finally {
        await close();
      }
    });

    it('ones_issue_update updates issue fields', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_issue_update',
          arguments: {
            issueOrUrl: 'https://ones.example.com/project/#/team/Tm1/project/P1/issue/iss-1',
            summary: 'Updated summary',
            priority: 'pr-low'
          }
        });
        expect(ctx.issue.updateIssue).toHaveBeenCalledWith({
          teamUUID: 'Tm1',
          issueUUID: 'iss-1',
          summary: 'Updated summary',
          priority: 'pr-low'
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({ issueUUID: 'iss-1' });
      } finally {
        await close();
      }
    });

    it('ones_issue_update validates that at least one mutable field is provided', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_issue_update',
          arguments: {
            issueOrUrl: 'iss-1'
          }
        });
        expect(res.isError).toBe(true);
        expect((res.content[0] as { text: string }).text).toContain(
          'Provide at least one field to update'
        );
        expect(ctx.issue.updateIssue).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('ones_issue_transition transitions issue workflow status', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_issue_transition',
          arguments: {
            issueOrUrl: 'https://ones.example.com/project/#/team/Tm1/project/P1/issue/iss-1',
            targetStatus: 'Closed'
          }
        });
        expect(ctx.issue.transitionIssue).toHaveBeenCalledWith({
          teamUUID: 'Tm1',
          issueUUID: 'iss-1',
          targetStatus: 'Closed'
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({
          issueUUID: 'iss-1',
          transitionUUID: 'tr-1',
          targetStatus: 'Closed'
        });
      } finally {
        await close();
      }
    });

    it('ones_issue_list_comments, ones_issue_add_comment, and ones_issue_update_comment work', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const listRes = await client.callTool({
          name: 'ones_issue_list_comments',
          arguments: { issueOrUrl: 'iss-1', limit: 5 }
        });
        expect(ctx.issue.listComments).toHaveBeenCalledWith({
          teamUUID: 'TmSession',
          issueUUID: 'iss-1',
          limit: 5,
          offset: 0
        });
        const listData = JSON.parse((listRes.content[0] as { text: string }).text);
        expect(listData).toMatchObject({
          issueUUID: 'iss-1',
          count: 1,
          comments: [{ commentUUID: 'cm-1' }]
        });

        const addRes = await client.callTool({
          name: 'ones_issue_add_comment',
          arguments: {
            issueOrUrl: 'iss-1',
            content: 'New comment',
            replyToCommentUUID: 'cm-1'
          }
        });
        expect(ctx.issue.addComment).toHaveBeenCalledWith({
          teamUUID: 'TmSession',
          issueUUID: 'iss-1',
          content: 'New comment',
          replyToCommentUUID: 'cm-1'
        });
        const addData = JSON.parse((addRes.content[0] as { text: string }).text);
        expect(addData).toMatchObject({ commentUUID: 'cm-new' });

        const updateRes = await client.callTool({
          name: 'ones_issue_update_comment',
          arguments: {
            issueOrUrl: 'iss-1',
            commentUUID: 'cm-1',
            content: 'Updated comment'
          }
        });
        expect(ctx.issue.updateComment).toHaveBeenCalledWith({
          teamUUID: 'TmSession',
          issueUUID: 'iss-1',
          commentUUID: 'cm-1',
          content: 'Updated comment'
        });
        const updateData = JSON.parse((updateRes.content[0] as { text: string }).text);
        expect(updateData).toMatchObject({ commentUUID: 'cm-1' });
      } finally {
        await close();
      }
    });
  });

  describe('Worklog Tools', () => {
    it('ones_worklog_list lists recorded worklogs on issue', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_worklog_list',
          arguments: {
            issueOrUrl: 'https://ones.example.com/project/#/team/Tm1/project/P1/issue/iss-1'
          }
        });
        expect(ctx.worklog.listWorklogs).toHaveBeenCalledWith({
          teamUUID: 'Tm1',
          issueUUID: 'iss-1'
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({
          issueUUID: 'iss-1',
          count: 1,
          worklogs: [{ worklogUUID: 'wl-1', hours: 2.5 }]
        });
      } finally {
        await close();
      }
    });

    it('ones_worklog_add logs hours on issue', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_worklog_add',
          arguments: {
            issueOrUrl: 'iss-1',
            hours: 3.5,
            startDate: '2026-11-08',
            description: 'Refactoring'
          }
        });
        expect(ctx.worklog.addWorklog).toHaveBeenCalledWith({
          teamUUID: 'TmSession',
          issueUUID: 'iss-1',
          hours: 3.5,
          startDate: '2026-11-08',
          description: 'Refactoring'
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({ worklogUUID: 'wl-new' });
      } finally {
        await close();
      }
    });
  });

  describe('Attachment Tools', () => {
    it('ones_attachment_list lists attachments for issue or wiki', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const resIssue = await client.callTool({
          name: 'ones_attachment_list',
          arguments: {
            targetType: 'issue',
            targetOrUrl: 'https://ones.example.com/project/#/team/Tm1/project/P1/issue/iss-1'
          }
        });
        expect(ctx.attachment.listAttachments).toHaveBeenCalledWith({
          teamUUID: 'Tm1',
          targetType: 'issue',
          targetUUID: 'iss-1'
        });
        const dataIssue = JSON.parse((resIssue.content[0] as { text: string }).text);
        expect(dataIssue).toMatchObject({
          targetType: 'issue',
          targetUUID: 'iss-1',
          count: 1
        });

        const resWiki = await client.callTool({
          name: 'ones_attachment_list',
          arguments: {
            targetType: 'wiki',
            targetOrUrl: 'https://ones.example.com/wiki/#/team/Tm2/space/Sp1/page/pg-1'
          }
        });
        expect(ctx.attachment.listAttachments).toHaveBeenCalledWith({
          teamUUID: 'Tm2',
          targetType: 'wiki',
          targetUUID: 'pg-1'
        });
        const dataWiki = JSON.parse((resWiki.content[0] as { text: string }).text);
        expect(dataWiki).toMatchObject({
          targetType: 'wiki',
          targetUUID: 'pg-1',
          count: 1
        });
      } finally {
        await close();
      }
    });

    it('ones_attachment_read returns image content block when kind is image', async () => {
      const readAttachmentMock = vi.fn(async () => ({
        kind: 'image' as const,
        base64: 'AAAA',
        mimeType: 'image/png',
        fileName: 'arch.png'
      }));
      const ctx = createMockContext({
        attachment: {
          ...createMockContext().attachment,
          readAttachment: readAttachmentMock
        } as any
      });
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_attachment_read',
          arguments: {
            attachmentUUID: 'att-img-1',
            targetType: 'issue'
          }
        });
        expect(readAttachmentMock).toHaveBeenCalledWith({
          teamUUID: 'TmSession',
          attachmentUUID: 'att-img-1',
          fileUrl: undefined,
          targetType: 'issue',
          maxChars: 50000
        });
        expect(res.content).toEqual([
          { type: 'image', data: 'AAAA', mimeType: 'image/png' }
        ]);
      } finally {
        await close();
      }
    });

    it('ones_attachment_read returns toolJson when kind is text or table', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_attachment_read',
          arguments: {
            fileUrl: '/wiki/api/wiki/team/Tm1/file/att-1'
          }
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({
          kind: 'text',
          text: 'Document content',
          fileName: 'spec.txt'
        });
      } finally {
        await close();
      }
    });

    it('ones_attachment_download downloads attachment to local path', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_attachment_download',
          arguments: {
            attachmentUUID: 'att-1',
            targetType: 'wiki',
            outputPath: '/tmp/downloaded.pdf',
            teamUUID: 'Tm1'
          }
        });
        expect(ctx.attachment.downloadAttachment).toHaveBeenCalledWith({
          teamUUID: 'Tm1',
          attachmentUUID: 'att-1',
          fileUrl: undefined,
          targetType: 'wiki',
          outputPath: '/tmp/downloaded.pdf'
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({ savedPath: '/tmp/spec.pdf', bytes: 1024 });
      } finally {
        await close();
      }
    });

    it('ones_attachment_read and ones_attachment_download with fileUrl succeed when session is null and defaultTeamUUID is undefined', async () => {
      const ctx = createMockContext({
        config: {
          baseUrl: 'https://ones.example.com',
          defaultTeamUUID: undefined,
          maxReadBytes: 15_000_000
        },
        refreshManager: {
          getCurrentSession: vi.fn(() => null)
        } as any
      });
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        // 1. ones_attachment_read with /team/ in URL extracts teamUUID
        const resReadTeam = await client.callTool({
          name: 'ones_attachment_read',
          arguments: {
            fileUrl: 'https://ones.example.com/wiki/api/wiki/team/TmInUrl/file/att-1'
          }
        });
        expect(resReadTeam.isError).toBeFalsy();
        expect(ctx.attachment.readAttachment).toHaveBeenCalledWith(
          expect.objectContaining({
            teamUUID: 'TmInUrl',
            fileUrl: 'https://ones.example.com/wiki/api/wiki/team/TmInUrl/file/att-1'
          })
        );

        // 2. ones_attachment_read without /team/ in URL falls back to empty string without throwing
        const resReadNoTeam = await client.callTool({
          name: 'ones_attachment_read',
          arguments: {
            fileUrl: 'https://ones.example.com/files/download/att-2'
          }
        });
        expect(resReadNoTeam.isError).toBeFalsy();
        expect(ctx.attachment.readAttachment).toHaveBeenCalledWith(
          expect.objectContaining({
            teamUUID: '',
            fileUrl: 'https://ones.example.com/files/download/att-2'
          })
        );

        // 3. ones_attachment_download with /team/ in URL
        const resDlTeam = await client.callTool({
          name: 'ones_attachment_download',
          arguments: {
            fileUrl: 'https://ones.example.com/wiki/api/wiki/team/TmInUrl/file/att-1',
            outputPath: '/tmp/out1.pdf'
          }
        });
        expect(resDlTeam.isError).toBeFalsy();
        expect(ctx.attachment.downloadAttachment).toHaveBeenCalledWith(
          expect.objectContaining({
            teamUUID: 'TmInUrl',
            fileUrl: 'https://ones.example.com/wiki/api/wiki/team/TmInUrl/file/att-1',
            outputPath: '/tmp/out1.pdf'
          })
        );

        // 4. ones_attachment_download without /team/ in URL
        const resDlNoTeam = await client.callTool({
          name: 'ones_attachment_download',
          arguments: {
            fileUrl: 'https://ones.example.com/files/download/att-2',
            outputPath: '/tmp/out2.pdf'
          }
        });
        expect(resDlNoTeam.isError).toBeFalsy();
        expect(ctx.attachment.downloadAttachment).toHaveBeenCalledWith(
          expect.objectContaining({
            teamUUID: '',
            fileUrl: 'https://ones.example.com/files/download/att-2',
            outputPath: '/tmp/out2.pdf'
          })
        );

        // 5. When fileUrl is omitted, attachmentUUID-only call still requires teamUUID and fails
        const resNoFileUrl = await client.callTool({
          name: 'ones_attachment_read',
          arguments: {
            attachmentUUID: 'att-1'
          }
        });
        expect(resNoFileUrl.isError).toBe(true);
        expect((resNoFileUrl.content[0] as { text: string }).text).toContain('Missing teamUUID');
      } finally {
        await close();
      }
    });

    it('ones_attachment_upload forwards upload to attachment adapter', async () => {
      const ctx = createMockContext();
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_attachment_upload',
          arguments: {
            targetType: 'issue',
            targetOrUrl: 'https://ones.example.com/project/#/team/Tm1/project/P1/issue/iss-1',
            filePath: '/tmp/screenshot.png'
          }
        });
        expect(ctx.attachment.uploadAttachment).toHaveBeenCalledWith({
          teamUUID: 'Tm1',
          targetType: 'issue',
          targetUUID: 'iss-1',
          filePath: '/tmp/screenshot.png'
        });
        const data = JSON.parse((res.content[0] as { text: string }).text);
        expect(data).toMatchObject({ attachmentUUID: 'att-new', name: 'upload.png' });
      } finally {
        await close();
      }
    });
  });

  describe('Error Propagation', () => {
    it('catches OnesApiError and returns formatted MCP error with isError: true', async () => {
      const ctx = createMockContext({
        project: {
          listProjects: vi.fn(async () => {
            throw new OnesApiError('AUTH_REQUIRED', 'Please sign in first');
          })
        } as any
      });
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      registerAllTools(server, ctx);

      const { client, close } = await connectServer(server);
      try {
        const res = await client.callTool({
          name: 'ones_project_list',
          arguments: {}
        });
        expect(res.isError).toBe(true);
        expect((res.content[0] as { text: string }).text).toContain(
          '[AUTH_REQUIRED] Please sign in first'
        );
      } finally {
        await close();
      }
    });
  });

  describe('createOnesMcpServer', () => {
    it('creates an McpServer instance and ToolContext with all 26 tools registered', async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-srv-test-'));
      try {
        const fakeFetch = vi.fn() as unknown as typeof fetch;
        const { server, ctx } = createOnesMcpServer({
          env: {
            ONES_BASE_URL: 'https://custom.ones.com',
            ONES_TEAM_UUID: 'TmEnv',
            ONES_MAX_READ_BYTES: '20000000'
          },
          homeDir: tmpHome,
          fetchImpl: fakeFetch
        });

        expect(ctx.config.baseUrl).toBe('https://custom.ones.com');
        expect(ctx.config.defaultTeamUUID).toBe('TmEnv');
        expect(ctx.config.maxReadBytes).toBe(20_000_000);

        const { client, close } = await connectServer(server);
        try {
          const listRes = await client.listTools();
          const toolNames = listRes.tools.map((t) => t.name).sort();
          expect(toolNames).toEqual(EXPECTED_26_TOOLS);
          expect(toolNames.length).toBe(26);
        } finally {
          await close();
        }
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });
});
