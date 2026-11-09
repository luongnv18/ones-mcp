import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WikiAdapter } from '../src/client/adapters/wiki.adapter.js';
import { ProjectAdapter } from '../src/client/adapters/project.adapter.js';
import { IssueAdapter } from '../src/client/adapters/issue.adapter.js';
import { WorklogAdapter } from '../src/client/adapters/worklog.adapter.js';
import { AttachmentAdapter } from '../src/client/adapters/attachment.adapter.js';
import { OnesApiError } from '../src/client/errors.js';
import type { OnesHttpClient } from '../src/client/http-client.js';

function mockHttp(
  routes: Record<string, (opts?: { query?: Record<string, unknown>; body?: unknown; method?: string }) => unknown>,
  binaryRoute?: (url: string) => Promise<{ buffer: Buffer; contentType: string; fileName: string }>
): OnesHttpClient {
  return {
    getBaseUrl: () => 'https://ones.example.com',
    requestJson: vi.fn(async (p: string, opts?: { query?: Record<string, unknown>; body?: unknown; method?: string }) => {
      for (const [pattern, handler] of Object.entries(routes)) {
        if (p.includes(pattern)) return handler(opts);
      }
      throw new Error(`Unexpected path: ${p}`);
    }),
    requestBinary: vi.fn(async (url: string) => {
      if (binaryRoute) return binaryRoute(url);
      return {
        buffer: Buffer.from('Attachment text body'),
        contentType: 'text/plain',
        fileName: 'readme.txt'
      };
    }),
    uploadMultipart: vi.fn(async (_url: string, _form: FormData) => ({
      uuid: 'att-new',
      name: 'spec.md'
    }))
  } as unknown as OnesHttpClient;
}

describe('WikiAdapter', () => {
  it('reads parent page with breadth-first child traversal obeying maxPages and truncation metadata', async () => {
    const http = mockHttp({
      '/pages/tree': () => ({
        pages: [
          {
            uuid: 'p-root',
            title: 'Root Doc',
            sub_pages: [
              { uuid: 'c1', title: 'Child 1', type: 'online_page', sub_pages: [] },
              { uuid: 'c2', title: 'Child 2', type: 'online_page', sub_pages: [] },
              { uuid: 'c3', title: 'Child 3', type: 'online_page', sub_pages: [] }
            ]
          }
        ]
      }),
      '/online_page/p-root/content': () => ({
        uuid: 'p-root',
        space_uuid: 'sp-1',
        title: 'Root Doc',
        content: JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Parent body' }] })
      }),
      '/online_page/c1/content': () => ({
        uuid: 'c1',
        space_uuid: 'sp-1',
        title: 'Child 1',
        content: JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Child 1 body' }] })
      })
    });

    const adapter = new WikiAdapter(http);
    const result = await adapter.getPage({
      teamUUID: 't1',
      spaceUUID: 'sp-1',
      pageUUID: 'p-root',
      includeChildren: true,
      maxDepth: 2,
      maxPages: 1
    });

    expect(result.markdown).toContain('Parent body');
    expect(result.children).toHaveLength(3);
    expect(result.childPages).toHaveLength(1);
    expect(result.childPages?.[0].markdown).toContain('Child 1 body');
    expect(result.truncated).toBe(true);
    expect(result.remainingPages?.map((p) => p.pageUUID)).toEqual(['c2', 'c3']);
  });

  it('resiliently handles unsupported child file format without failing parent read or sibling traversal', async () => {
    const http = mockHttp(
      {
        '/pages/tree': () => ({
          pages: [
            {
              uuid: 'p-parent',
              title: 'Parent Page',
              sub_pages: [
                {
                  uuid: 'c-zip',
                  title: 'archive.zip',
                  type: 'file',
                  file_url: '/wiki/files/archive.zip',
                  sub_pages: []
                },
                {
                  uuid: 'c-doc',
                  title: 'Child Doc',
                  type: 'online_page',
                  sub_pages: []
                }
              ]
            }
          ]
        }),
        '/online_page/p-parent/content': () => ({
          uuid: 'p-parent',
          space_uuid: 'sp-1',
          title: 'Parent Page',
          content: JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Parent content' }] })
        }),
        '/online_page/c-doc/content': () => ({
          uuid: 'c-doc',
          space_uuid: 'sp-1',
          title: 'Child Doc',
          content: JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Child document content' }] })
        })
      },
      async (url: string) => {
        if (url.includes('archive.zip')) {
          return {
            buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
            contentType: 'application/zip',
            fileName: 'archive.zip'
          };
        }
        return {
          buffer: Buffer.from('fallback'),
          contentType: 'text/plain',
          fileName: 'readme.txt'
        };
      }
    );

    const adapter = new WikiAdapter(http);
    const result = await adapter.getPage({
      teamUUID: 't1',
      spaceUUID: 'sp-1',
      pageUUID: 'p-parent',
      includeChildren: true
    });

    expect(result.markdown).toContain('Parent content');
    expect(result.childPages).toBeDefined();
    expect(result.childPages).toHaveLength(2);
    expect(result.childPages?.[0]).toEqual({
      pageUUID: 'c-zip',
      title: 'archive.zip',
      depth: 1,
      markdown:
        '[Attached file: archive.zip (unsupported format for inline read; use ones_attachment_download)]'
    });
    expect(result.childPages?.[1]).toEqual({
      pageUUID: 'c-doc',
      title: 'Child Doc',
      depth: 1,
      markdown: 'Child document content'
    });
  });

  it('Controller Ruling 1: blocks title-only edit on locked page with PAGE_LOCKED error', async () => {
    const http = mockHttp({
      '/online_page/p-locked/content': () => ({
        uuid: 'p-locked',
        title: 'Locked Page',
        locked: true,
        content: JSON.stringify({ blocks: [] })
      }),
      '/online_page/p-locked/update': () => ({
        uuid: 'p-locked'
      })
    });

    const adapter = new WikiAdapter(http);
    await expect(
      adapter.updatePage({
        teamUUID: 't1',
        pageUUID: 'p-locked',
        title: 'New Title Only',
        mode: 'replace'
      })
    ).rejects.toThrowError(OnesApiError);

    try {
      await adapter.updatePage({
        teamUUID: 't1',
        pageUUID: 'p-locked',
        title: 'New Title Only',
        mode: 'replace'
      });
    } catch (err: unknown) {
      expect((err as OnesApiError).code).toBe('PAGE_LOCKED');
      expect((err as OnesApiError).message).toContain('locked');
    }
  });

  it('Controller Ruling 2: reads a child file node under a parent page without failing on /online_page/:id/content', async () => {
    const http = mockHttp(
      {
        '/pages/tree': () => ({
          pages: [
            {
              uuid: 'p-root',
              title: 'Root Doc',
              sub_pages: [
                {
                  uuid: 'c-file',
                  title: 'Spec.txt',
                  type: 'file',
                  file_url: '/wiki/api/wiki/team/t1/file/f-1',
                  sub_pages: []
                }
              ]
            }
          ]
        }),
        '/online_page/p-root/content': () => ({
          uuid: 'p-root',
          space_uuid: 'sp-1',
          title: 'Root Doc',
          content: JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Root page content' }] })
        })
        // Note: '/online_page/c-file/content' is NOT defined here.
        // It must NOT be called for child file nodes!
      },
      async (url: string) => {
        expect(url).toBe('/wiki/api/wiki/team/t1/file/f-1');
        return {
          buffer: Buffer.from('Child file text content'),
          contentType: 'text/plain',
          fileName: 'Spec.txt'
        };
      }
    );

    const adapter = new WikiAdapter(http);
    const result = await adapter.getPage({
      teamUUID: 't1',
      spaceUUID: 'sp-1',
      pageUUID: 'p-root',
      includeChildren: true,
      maxDepth: 1,
      maxPages: 5
    });

    expect(result.childPages).toHaveLength(1);
    expect(result.childPages?.[0].pageUUID).toBe('c-file');
    expect(result.childPages?.[0].title).toBe('Spec.txt');
    expect(result.childPages?.[0].markdown).toContain('Child file text content');
  });

  it('lists spaces, gets page tree, searches pages, creates page, and handles comments', async () => {
    const calls: Array<{ path: string; body?: unknown; query?: unknown }> = [];
    const http = {
      getBaseUrl: () => 'https://ones.example.com',
      requestJson: vi.fn(async (p: string, opts?: { query?: unknown; body?: unknown }) => {
        calls.push({ path: p, body: opts?.body, query: opts?.query });
        if (p.includes('/spaces')) {
          return { spaces: [{ uuid: 'sp-1', name: 'Engineering Space', description: 'Tech docs' }] };
        }
        if (p.includes('/pages/tree')) {
          return {
            pages: [
              {
                uuid: 'root-1',
                title: 'Root',
                children: [
                  { uuid: 'sub-1', title: 'Sub', children: [{ uuid: 'sub-sub', title: 'Deep' }] }
                ]
              }
            ]
          };
        }
        if (p.includes('/pages/search')) {
          return { pages: [{ uuid: 'p-s1', space_uuid: 'sp-1', title: 'API Guide', snippet: 'Guide...' }] };
        }
        if (p.includes('/online_page/add')) {
          return { uuid: 'p-new', space_uuid: 'sp-1' };
        }
        if (p.includes('/comments/add')) {
          return { uuid: 'c-new' };
        }
        if (p.includes('/comments')) {
          return {
            comments: [
              {
                uuid: 'comm-1',
                owner: { name: 'Alice', uuid: 'u-1' },
                create_time: 1700000000,
                text: 'Looks great!'
              }
            ]
          };
        }
        throw new Error(`Unexpected path: ${p}`);
      }),
      requestBinary: vi.fn(),
      uploadMultipart: vi.fn()
    } as unknown as OnesHttpClient;

    const adapter = new WikiAdapter(http);

    const spaces = await adapter.listSpaces({ teamUUID: 't1' });
    expect(spaces).toEqual([{ spaceUUID: 'sp-1', name: 'Engineering Space', description: 'Tech docs' }]);

    const tree = await adapter.getPageTree({ teamUUID: 't1', spaceUUID: 'sp-1', maxDepth: 2 });
    expect(tree[0].pageUUID).toBe('root-1');
    expect(tree[0].children[0].pageUUID).toBe('sub-1');
    expect(tree[0].children[0].children).toHaveLength(0); // pruned at depth 2

    const searchResults = await adapter.searchPages({ teamUUID: 't1', query: 'API' });
    expect(searchResults[0].title).toBe('API Guide');

    const created = await adapter.createPage({
      teamUUID: 't1',
      spaceUUID: 'sp-1',
      title: 'New Page',
      markdown: '# Title'
    });
    expect(created.pageUUID).toBe('p-new');
    expect(created.url).toContain('/space/sp-1/page/p-new');

    const comments = await adapter.listComments({ teamUUID: 't1', pageUUID: 'p-new' });
    expect(comments[0].authorName).toBe('Alice');
    expect(comments[0].text).toBe('Looks great!');

    const added = await adapter.addComment({ teamUUID: 't1', pageUUID: 'p-new', content: 'Reply' });
    expect(added.commentUUID).toBe('c-new');
  });
});

describe('ProjectAdapter & IssueAdapter', () => {
  it('resolves target status name to transitionUUID when executing issue transition', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const http = {
      getBaseUrl: () => 'https://ones.example.com',
      requestJson: vi.fn(async (p: string, opts?: { body?: unknown }) => {
        calls.push({ path: p, body: opts?.body });
        if (p.includes('/transitions')) {
          return {
            transitions: [
              { uuid: 'tr-progress', name: 'Start Progress', end_status_name: 'In Progress' },
              { uuid: 'tr-done', name: 'Resolve', end_status_name: 'Done' }
            ]
          };
        }
        return { uuid: 'iss-1', status: 'In Progress' };
      })
    } as unknown as OnesHttpClient;

    const issueAdapter = new IssueAdapter(http);
    await issueAdapter.transitionIssue({
      teamUUID: 't1',
      issueUUID: 'iss-1',
      targetStatus: 'In Progress'
    });

    expect(calls[1].path).toContain('/tasks/iss-1/transitions');
    expect(calls[1].body).toEqual({ transition_uuid: 'tr-progress' });
  });

  it('throws VALIDATION_ERROR when target transition does not match any available transitions', async () => {
    const http = mockHttp({
      '/transitions': () => ({
        transitions: [
          { uuid: 'tr-done', name: 'Resolve', end_status_name: 'Done' }
        ]
      })
    });

    const issueAdapter = new IssueAdapter(http);
    await expect(
      issueAdapter.transitionIssue({
        teamUUID: 't1',
        issueUUID: 'iss-1',
        targetStatus: 'NonExistentStatus'
      })
    ).rejects.toThrowError(OnesApiError);
  });

  it('lists projects, worklogs, and reads text attachments', async () => {
    const http = mockHttp({
      '/projects': () => ({ projects: [{ uuid: 'prj-1', name: 'Core Platform' }] }),
      '/manhours': () => ({ manhours: [{ uuid: 'wl-1', hours: 7200, description: 'Code review' }] }),
      '/attachments': () => ({ files: [{ uuid: 'att-1', name: 'readme.txt', mime_type: 'text/plain' }] })
    });

    const projectAdapter = new ProjectAdapter(http);
    const projects = await projectAdapter.listProjects({ teamUUID: 't1' });
    expect(projects[0].name).toBe('Core Platform');

    const worklogAdapter = new WorklogAdapter(http);
    const logs = await worklogAdapter.listWorklogs({ teamUUID: 't1', issueUUID: 'iss-1' });
    expect(logs).toHaveLength(1);

    const attachmentAdapter = new AttachmentAdapter(http, 1024 * 1024);
    const doc = await attachmentAdapter.readAttachment({
      teamUUID: 't1',
      fileUrl: '/wiki/api/wiki/team/t1/file/att-1'
    });
    expect(doc.kind).toBe('text');
  });

  it('ProjectAdapter.getProjectMetadata returns full stamp schema', async () => {
    const http = mockHttp({
      '/stamp': () => ({
        issue_types: [{ uuid: 'it-1', name: 'Story' }],
        task_statuses: [{ uuid: 'st-1', name: 'To Do', category: 'to_do' }],
        priorities: [{ uuid: 'pr-1', name: 'High' }],
        sprints: [{ uuid: 'sp-1', name: 'Sprint 1', status: 'active' }],
        members: [{ uuid: 'u-1', name: 'Bob', email: 'bob@example.com' }],
        fields: [{ uuid: 'f-1', name: 'Custom Notes', type: 'text' }]
      })
    });

    const adapter = new ProjectAdapter(http);
    const meta = await adapter.getProjectMetadata({ teamUUID: 't1', projectUUID: 'prj-1' });
    expect(meta.projectUUID).toBe('prj-1');
    expect(meta.issueTypes).toEqual([{ uuid: 'it-1', name: 'Story' }]);
    expect(meta.statuses).toEqual([{ uuid: 'st-1', name: 'To Do', category: 'to_do' }]);
    expect(meta.priorities).toEqual([{ uuid: 'pr-1', name: 'High' }]);
    expect(meta.sprints).toEqual([{ uuid: 'sp-1', name: 'Sprint 1', status: 'active' }]);
    expect(meta.members).toEqual([{ uuid: 'u-1', name: 'Bob', email: 'bob@example.com' }]);
    expect(meta.customFields).toEqual([{ uuid: 'f-1', name: 'Custom Notes', type: 'text' }]);
  });

  it('IssueAdapter handles search, get, create, update, and comments', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const http = {
      getBaseUrl: () => 'https://ones.example.com',
      requestJson: vi.fn(async (p: string, opts?: { body?: unknown }) => {
        calls.push({ path: p, body: opts?.body });
        if (p.includes('/items/graphql')) {
          return {
            data: {
              tasks: [
                {
                  uuid: 'iss-1',
                  number: 101,
                  name: 'Bug in auth',
                  status: { name: 'Open' },
                  issueType: { name: 'Bug' },
                  priority: { value: 'High' },
                  assign: { uuid: 'u-1', name: 'Alice' },
                  project: { uuid: 'prj-1' }
                }
              ]
            }
          };
        }
        if (p.includes('/task/iss-1/info')) {
          return {
            uuid: 'iss-1',
            number: 101,
            summary: 'Bug in auth',
            status_name: 'Open',
            issue_type_name: 'Bug',
            project_uuid: 'prj-1',
            desc: 'Found error on login',
            field_values: { custom_1: 'val1' }
          };
        }
        if (p.includes('/transitions')) {
          return { transitions: [] };
        }
        if (p.includes('/task/iss-1/messages/add')) {
          return { uuid: 'comm-new' };
        }
        if (p.includes('/message/comm-new/update')) {
          return { uuid: 'comm-new' };
        }
        if (p.includes('/messages')) {
          return { messages: [{ uuid: 'comm-old', text: 'Existing comment' }] };
        }
        if (p.includes('/tasks/add')) {
          return { tasks: [{ uuid: 'iss-new' }] };
        }
        if (p.includes('/tasks/update')) {
          return { tasks: [{ uuid: 'iss-1' }] };
        }
        throw new Error(`Unexpected path: ${p}`);
      })
    } as unknown as OnesHttpClient;

    const issueAdapter = new IssueAdapter(http);

    const searchRes = await issueAdapter.searchIssues({ teamUUID: 't1', query: 'auth', status: 'Open' });
    expect(searchRes).toHaveLength(1);
    expect(searchRes[0].summary).toBe('Bug in auth');
    expect(searchRes[0].number).toBe(101);

    const detail = await issueAdapter.getIssue({ teamUUID: 't1', issueUUID: 'iss-1' });
    expect(detail.summary).toBe('Bug in auth');
    expect(detail.descriptionMarkdown).toBe('Found error on login');
    expect(detail.customFields).toEqual({ custom_1: 'val1' });

    const created = await issueAdapter.createIssue({
      teamUUID: 't1',
      projectUUID: 'prj-1',
      issueType: 'it-1',
      summary: 'Brand new issue'
    });
    expect(created.issueUUID).toBe('iss-new');

    const updated = await issueAdapter.updateIssue({
      teamUUID: 't1',
      issueUUID: 'iss-1',
      summary: 'Updated summary'
    });
    expect(updated.issueUUID).toBe('iss-1');

    const comments = await issueAdapter.listComments({ teamUUID: 't1', issueUUID: 'iss-1' });
    expect(comments[0].text).toBe('Existing comment');

    const addedComm = await issueAdapter.addComment({ teamUUID: 't1', issueUUID: 'iss-1', content: 'New message' });
    expect(addedComm.commentUUID).toBe('comm-new');

    const updComm = await issueAdapter.updateComment({ teamUUID: 't1', issueUUID: 'iss-1', commentUUID: 'comm-new', content: 'Edited message' });
    expect(updComm.commentUUID).toBe('comm-new');
  });
});

describe('WorklogAdapter', () => {
  it('Controller Ruling 3: throws VALIDATION_ERROR when startDate is invalid', async () => {
    const http = mockHttp({});
    const adapter = new WorklogAdapter(http);

    await expect(
      adapter.addWorklog({
        teamUUID: 't1',
        issueUUID: 'iss-1',
        hours: 2,
        startDate: 'invalid-date-string'
      })
    ).rejects.toThrowError(OnesApiError);

    try {
      await adapter.addWorklog({
        teamUUID: 't1',
        issueUUID: 'iss-1',
        hours: 2,
        startDate: 'invalid-date-string'
      });
    } catch (err: unknown) {
      expect((err as OnesApiError).code).toBe('VALIDATION_ERROR');
      expect((err as OnesApiError).message).toContain('invalid-date-string');
    }
  });

  it('adds worklog with valid startDate and converts hours to seconds', async () => {
    let capturedBody: unknown;
    const http = {
      getBaseUrl: () => 'https://ones.example.com',
      requestJson: vi.fn(async (_p: string, opts?: { body?: unknown }) => {
        capturedBody = opts?.body;
        return { uuid: 'wl-100' };
      })
    } as unknown as OnesHttpClient;

    const adapter = new WorklogAdapter(http);
    const res = await adapter.addWorklog({
      teamUUID: 't1',
      issueUUID: 'iss-1',
      hours: 1.5,
      startDate: '2026-11-08T10:00:00Z',
      description: 'Worked on adapters'
    });

    expect(res.worklogUUID).toBe('wl-100');
    expect(capturedBody).toEqual({
      hours: 5400, // 1.5 * 3600
      start_time: Math.floor(new Date('2026-11-08T10:00:00Z').getTime() / 1000),
      description: 'Worked on adapters'
    });
  });
});

describe('AttachmentAdapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Controller Ruling 4: uploadAttachment packages file as Blob with Uint8Array and returns uuid', async () => {
    const testFile = path.join(tmpDir, 'test-doc.txt');
    fs.writeFileSync(testFile, 'Hello attachment');

    let uploadedFormData: FormData | undefined;
    const http = {
      getBaseUrl: () => 'https://ones.example.com',
      requestJson: vi.fn(),
      requestBinary: vi.fn(),
      uploadMultipart: vi.fn(async (_url: string, form: FormData) => {
        uploadedFormData = form;
        return { uuid: 'att-uploaded', name: 'test-doc.txt' };
      })
    } as unknown as OnesHttpClient;

    const adapter = new AttachmentAdapter(http);
    const res = await adapter.uploadAttachment({
      teamUUID: 't1',
      targetType: 'issue',
      targetUUID: 'iss-1',
      filePath: testFile
    });

    expect(res.attachmentUUID).toBe('att-uploaded');
    expect(res.name).toBe('test-doc.txt');
    expect(uploadedFormData).toBeDefined();
    expect(uploadedFormData?.get('file')).toBeInstanceOf(Blob);
  });

  it('uploadAttachment throws VALIDATION_ERROR if local file does not exist', async () => {
    const http = mockHttp({});
    const adapter = new AttachmentAdapter(http);

    await expect(
      adapter.uploadAttachment({
        teamUUID: 't1',
        targetType: 'wiki',
        targetUUID: 'p-1',
        filePath: '/non/existent/file.txt'
      })
    ).rejects.toThrowError(OnesApiError);
  });

  it('downloads attachment and saves to specified path', async () => {
    const downloadDest = path.join(tmpDir, 'saved.txt');
    const http = mockHttp(
      {},
      async () => ({
        buffer: Buffer.from('Saved content bytes'),
        contentType: 'text/plain',
        fileName: 'remote.txt'
      })
    );

    const adapter = new AttachmentAdapter(http);
    const res = await adapter.downloadAttachment({
      teamUUID: 't1',
      attachmentUUID: 'att-123',
      targetType: 'wiki',
      outputPath: downloadDest
    });

    expect(res.savedPath).toBe(downloadDest);
    expect(res.bytes).toBe(19);
    expect(fs.readFileSync(downloadDest, 'utf8')).toBe('Saved content bytes');
  });

  it('listAttachments returns attachments for both wiki and issue targets', async () => {
    const http = mockHttp({
      '/page/p-1/attachments': () => ({
        files: [{ uuid: 'att-wiki-1', name: 'guide.pdf', mime_type: 'application/pdf', size: 1024 }]
      }),
      '/task/iss-1/attachments': () => ({
        attachments: [{ uuid: 'att-iss-1', title: 'log.txt', size: 500 }]
      })
    });

    const adapter = new AttachmentAdapter(http);
    const wikiAtts = await adapter.listAttachments({
      teamUUID: 't1',
      targetType: 'wiki',
      targetUUID: 'p-1'
    });
    expect(wikiAtts[0].attachmentUUID).toBe('att-wiki-1');
    expect(wikiAtts[0].downloadUrl).toBe('/wiki/api/wiki/team/t1/file/att-wiki-1');

    const issueAtts = await adapter.listAttachments({
      teamUUID: 't1',
      targetType: 'issue',
      targetUUID: 'iss-1'
    });
    expect(issueAtts[0].attachmentUUID).toBe('att-iss-1');
    expect(issueAtts[0].name).toBe('log.txt');
    expect(issueAtts[0].downloadUrl).toBe('/project/api/project/team/t1/res/attachment/att-iss-1');
  });
});
