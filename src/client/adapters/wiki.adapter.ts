import { wikiContentToMarkdown } from '../../converters/wiki-to-markdown.js';
import {
  markdownToWikiPayload,
  mergeWikiUpdatePayload
} from '../../converters/markdown-to-wiki.js';
import { readDocumentBuffer } from '../../converters/document-reader.js';
import { OnesApiError } from '../errors.js';
import type { OnesHttpClient } from '../http-client.js';
import type {
  OnesComment,
  WikiPageContentResult,
  WikiPageNode,
  WikiSpace
} from './types.js';

type AnyObj = Record<string, unknown>;

function normalizeNode(raw: AnyObj, defaultSpaceUUID?: string, parentUUID?: string): WikiPageNode {
  const subRaw = (Array.isArray(raw.sub_pages)
    ? raw.sub_pages
    : Array.isArray(raw.children)
      ? raw.children
      : []) as AnyObj[];
  const pageUUID = String(raw.uuid ?? raw.page_uuid ?? raw.id ?? '');
  const spaceUUID = String(raw.space_uuid ?? defaultSpaceUUID ?? '');
  const rawType = String(raw.type ?? raw.ref_type ?? 'online_page').toLowerCase();
  const nodeType: WikiPageNode['nodeType'] =
    rawType.includes('file') || rawType === 'resource'
      ? 'file'
      : 'online_page';

  const children = subRaw.map((c) => normalizeNode(c, spaceUUID, pageUUID));
  return {
    pageUUID,
    spaceUUID: spaceUUID || undefined,
    parentPageUUID: parentUUID ?? (raw.parent_uuid ? String(raw.parent_uuid) : undefined),
    title: String(raw.title ?? raw.name ?? 'Untitled'),
    nodeType,
    fileUrl: raw.file_url ? String(raw.file_url) : undefined,
    hasChildren: children.length > 0 || Boolean(raw.has_sub_pages),
    children
  };
}

function findNodeInTree(nodes: WikiPageNode[], targetUUID: string): WikiPageNode | undefined {
  for (const node of nodes) {
    if (node.pageUUID === targetUUID) return node;
    const nested = findNodeInTree(node.children, targetUUID);
    if (nested) return nested;
  }
  return undefined;
}

function pruneTreeDepth(nodes: WikiPageNode[], maxDepth: number, depth = 1): WikiPageNode[] {
  return nodes.map((n) => ({
    ...n,
    children: depth < maxDepth ? pruneTreeDepth(n.children, maxDepth, depth + 1) : []
  }));
}

export class WikiAdapter {
  constructor(
    private readonly http: OnesHttpClient,
    private readonly maxReadBytes = 15 * 1024 * 1024
  ) {}

  async listSpaces(options: { teamUUID: string; limit?: number; offset?: number }): Promise<WikiSpace[]> {
    const limit = Math.min(options.limit ?? 20, 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const data = await this.http.requestJson<AnyObj>(
      `/wiki/api/wiki/team/${options.teamUUID}/spaces`,
      { query: { limit, offset } }
    );
    const list = (Array.isArray(data.spaces) ? data.spaces : Array.isArray(data.list) ? data.list : []) as AnyObj[];
    return list.map((s) => ({
      spaceUUID: String(s.uuid ?? s.id ?? ''),
      name: String(s.name ?? s.title ?? ''),
      description: s.description ? String(s.description) : undefined
    }));
  }

  async getPageTree(options: {
    teamUUID: string;
    spaceUUID: string;
    parentPageUUID?: string;
    maxDepth?: number;
  }): Promise<WikiPageNode[]> {
    const data = await this.http.requestJson<AnyObj>(
      `/wiki/api/wiki/team/${options.teamUUID}/space/${options.spaceUUID}/pages/tree`
    );
    const rawPages = (Array.isArray(data.pages) ? data.pages : Array.isArray(data.list) ? data.list : []) as AnyObj[];
    const tree = rawPages.map((p) => normalizeNode(p, options.spaceUUID));

    let scoped = tree;
    if (options.parentPageUUID) {
      const parent = findNodeInTree(tree, options.parentPageUUID);
      scoped = parent ? parent.children : [];
    }

    const depth = Math.min(Math.max(options.maxDepth ?? 3, 1), 10);
    return pruneTreeDepth(scoped, depth);
  }

  async searchPages(options: {
    teamUUID: string;
    query: string;
    spaceUUID?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<{ pageUUID: string; spaceUUID?: string; title: string; snippet?: string }>> {
    const limit = Math.min(options.limit ?? 20, 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const data = await this.http.requestJson<AnyObj>(
      `/wiki/api/wiki/team/${options.teamUUID}/pages/search`,
      {
        query: {
          keyword: options.query,
          space_uuid: options.spaceUUID,
          limit,
          offset
        }
      }
    );
    const list = (Array.isArray(data.pages) ? data.pages : Array.isArray(data.list) ? data.list : []) as AnyObj[];
    return list.map((p) => ({
      pageUUID: String(p.uuid ?? p.page_uuid ?? ''),
      spaceUUID: p.space_uuid ? String(p.space_uuid) : undefined,
      title: String(p.title ?? ''),
      snippet: p.snippet ? String(p.snippet) : undefined
    }));
  }

  private async fetchSinglePageRaw(teamUUID: string, pageUUID: string): Promise<AnyObj> {
    return this.http.requestJson<AnyObj>(
      `/wiki/api/wiki/team/${teamUUID}/online_page/${pageUUID}/content`
    );
  }

  private async extractPageContent(
    teamUUID: string,
    target: {
      pageUUID: string;
      title?: string;
      nodeType?: 'online_page' | 'file' | 'unknown';
      fileUrl?: string;
      raw?: AnyObj;
    }
  ): Promise<{
    title: string;
    markdown: string;
    nodeType: 'online_page' | 'file';
    locked: boolean;
    raw?: AnyObj;
  }> {
    const isFileFromNode = target.nodeType === 'file' && Boolean(target.fileUrl);
    let raw: AnyObj | undefined = target.raw;

    if (!isFileFromNode && !raw) {
      try {
        raw = await this.fetchSinglePageRaw(teamUUID, target.pageUUID);
      } catch (err) {
        if (!target.fileUrl) throw err;
      }
    }

    const rawType = String(raw?.type ?? target.nodeType ?? 'online_page').toLowerCase();
    const fileUrl = (raw?.file_url ? String(raw.file_url) : undefined) ?? target.fileUrl;
    const isFile = isFileFromNode || rawType.includes('file') || Boolean(fileUrl && rawType !== 'online_page');
    const title = String(raw?.title ?? target.title ?? 'Untitled');
    const locked = Boolean(raw?.locked);

    if (isFile && fileUrl) {
      const bin = await this.http.requestBinary(fileUrl, { maxBytes: this.maxReadBytes });
      const extracted = await readDocumentBuffer({
        buffer: bin.buffer,
        fileName: bin.fileName ?? title,
        contentType: bin.contentType,
        maxBytes: this.maxReadBytes
      });
      const markdown = extracted.kind === 'text' ? extracted.text : `[Image attachment: ${bin.contentType}]`;
      return {
        title,
        markdown,
        nodeType: 'file',
        locked,
        raw
      };
    }

    const content = raw ? (raw.content ?? raw.data ?? raw) : '';
    const markdown = wikiContentToMarkdown(content);
    return {
      title,
      markdown,
      nodeType: 'online_page',
      locked,
      raw
    };
  }

  async getPage(options: {
    teamUUID: string;
    spaceUUID?: string;
    pageUUID: string;
    format?: 'markdown' | 'raw';
    includeChildren?: boolean;
    maxDepth?: number;
    maxPages?: number;
    maxTotalChars?: number;
  }): Promise<WikiPageContentResult> {
    const raw = await this.fetchSinglePageRaw(options.teamUUID, options.pageUUID);
    const spaceUUID = options.spaceUUID ?? (raw.space_uuid ? String(raw.space_uuid) : undefined);
    const title = String(raw.title ?? 'Untitled');
    const rawType = String(raw.type ?? 'online_page').toLowerCase();
    const nodeType: 'online_page' | 'file' = rawType.includes('file') ? 'file' : 'online_page';

    let markdown: string | undefined;
    if (options.format !== 'raw') {
      const extracted = await this.extractPageContent(options.teamUUID, {
        pageUUID: options.pageUUID,
        title,
        nodeType,
        fileUrl: raw.file_url ? String(raw.file_url) : undefined,
        raw
      });
      markdown = extracted.markdown;
    }

    let directChildren: WikiPageNode[] = [];
    if (spaceUUID) {
      const tree = await this.getPageTree({ teamUUID: options.teamUUID, spaceUUID, maxDepth: 10 }).catch(() => []);
      const node = findNodeInTree(tree, options.pageUUID);
      directChildren = node?.children ?? [];
    }

    const result: WikiPageContentResult = {
      pageUUID: options.pageUUID,
      spaceUUID,
      title,
      nodeType,
      locked: Boolean(raw.locked),
      url: `${this.http.getBaseUrl()}/wiki/#/team/${options.teamUUID}/space/${spaceUUID ?? 'unknown'}/page/${options.pageUUID}`,
      markdown,
      raw: options.format === 'raw' ? raw : undefined,
      children: directChildren.map((c) => ({
        pageUUID: c.pageUUID,
        title: c.title,
        nodeType: c.nodeType,
        hasChildren: c.hasChildren
      }))
    };

    if (options.includeChildren && directChildren.length > 0) {
      const maxDepth = Math.min(Math.max(options.maxDepth ?? 1, 1), 3);
      const maxPages = Math.min(Math.max(options.maxPages ?? 10, 1), 25);
      const maxTotalChars = options.maxTotalChars ?? 60_000;

      const queue: Array<{ node: WikiPageNode; depth: number }> = directChildren.map((c) => ({
        node: c,
        depth: 1
      }));
      const childPages: Array<{ pageUUID: string; title: string; depth: number; markdown: string }> = [];
      let totalChars = markdown?.length ?? 0;

      while (queue.length > 0) {
        if (childPages.length >= maxPages || totalChars >= maxTotalChars) {
          result.truncated = true;
          result.remainingPages = queue.map((q) => ({ pageUUID: q.node.pageUUID, title: q.node.title }));
          break;
        }
        const current = queue.shift()!;
        let childContent: {
          title: string;
          markdown: string;
          nodeType: WikiPageNode['nodeType'];
          locked: boolean;
        };
        try {
          childContent = await this.extractPageContent(options.teamUUID, {
            pageUUID: current.node.pageUUID,
            title: current.node.title,
            nodeType: current.node.nodeType,
            fileUrl: current.node.fileUrl
          });
        } catch (err) {
          if (err instanceof OnesApiError && err.code === 'UNSUPPORTED_FILE') {
            childContent = {
              title: current.node.title,
              markdown: `[Attached file: ${current.node.title} (unsupported format for inline read; use ones_attachment_download)]`,
              nodeType: current.node.nodeType,
              locked: false
            };
          } else {
            throw err;
          }
        }

        totalChars += childContent.markdown.length;
        childPages.push({
          pageUUID: current.node.pageUUID,
          title: childContent.title,
          depth: current.depth,
          markdown: childContent.markdown
        });

        if (current.depth < maxDepth && current.node.children.length > 0) {
          for (const grandChild of current.node.children) {
            queue.push({ node: grandChild, depth: current.depth + 1 });
          }
        }
      }

      result.childPages = childPages;
    }

    return result;
  }

  async createPage(options: {
    teamUUID: string;
    spaceUUID?: string;
    parentPageUUID?: string;
    title: string;
    markdown: string;
  }): Promise<{ pageUUID: string; title: string; url: string }> {
    const content = markdownToWikiPayload(options.markdown);
    const data = await this.http.requestJson<AnyObj>(
      `/wiki/api/wiki/team/${options.teamUUID}/online_page/add`,
      {
        method: 'POST',
        body: {
          space_uuid: options.spaceUUID,
          parent_uuid: options.parentPageUUID,
          title: options.title,
          content
        }
      }
    );
    const pageUUID = String(data.uuid ?? data.page_uuid ?? '');
    return {
      pageUUID,
      title: options.title,
      url: `${this.http.getBaseUrl()}/wiki/#/team/${options.teamUUID}/space/${options.spaceUUID ?? 'unknown'}/page/${pageUUID}`
    };
  }

  async updatePage(options: {
    teamUUID: string;
    pageUUID: string;
    title?: string;
    markdown?: string;
    mode: 'replace' | 'append';
  }): Promise<{ pageUUID: string; title: string }> {
    const current = await this.fetchSinglePageRaw(options.teamUUID, options.pageUUID);

    // Controller Ruling 1: Check locked status immediately before checking options.markdown
    if (current.locked) {
      throw new OnesApiError(
        'PAGE_LOCKED',
        'This Wiki page is locked in ONES and cannot be modified.'
      );
    }

    const nextTitle = options.title ?? String(current.title ?? 'Untitled');
    const nextContent =
      options.markdown !== undefined
        ? mergeWikiUpdatePayload({
            existingContent: current.content ?? current.data,
            locked: Boolean(current.locked),
            markdown: options.markdown,
            mode: options.mode
          })
        : undefined;

    await this.http.requestJson<AnyObj>(
      `/wiki/api/wiki/team/${options.teamUUID}/online_page/${options.pageUUID}/update`,
      {
        method: 'POST',
        body: {
          title: nextTitle,
          ...(nextContent !== undefined ? { content: nextContent } : {})
        }
      }
    );

    return { pageUUID: options.pageUUID, title: nextTitle };
  }

  async listComments(options: {
    teamUUID: string;
    pageUUID: string;
    limit?: number;
    offset?: number;
  }): Promise<OnesComment[]> {
    const limit = Math.min(options.limit ?? 20, 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const data = await this.http.requestJson<AnyObj>(
      `/wiki/api/wiki/team/${options.teamUUID}/page/${options.pageUUID}/comments`,
      { query: { limit, offset } }
    );
    const list = (Array.isArray(data.comments) ? data.comments : Array.isArray(data.list) ? data.list : []) as AnyObj[];
    return list.map((c) => ({
      commentUUID: String(c.uuid ?? c.id ?? ''),
      authorName: (c.owner as AnyObj | undefined)?.name ? String((c.owner as AnyObj).name) : undefined,
      authorUUID: (c.owner as AnyObj | undefined)?.uuid ? String((c.owner as AnyObj).uuid) : undefined,
      createdAt: typeof c.create_time === 'number' ? c.create_time : undefined,
      text: String(c.text ?? c.content ?? '')
    }));
  }

  async addComment(options: {
    teamUUID: string;
    pageUUID: string;
    content: string;
  }): Promise<{ commentUUID: string }> {
    const data = await this.http.requestJson<AnyObj>(
      `/wiki/api/wiki/team/${options.teamUUID}/page/${options.pageUUID}/comments/add`,
      {
        method: 'POST',
        body: { text: options.content }
      }
    );
    return { commentUUID: String(data.uuid ?? data.id ?? '') };
  }
}
