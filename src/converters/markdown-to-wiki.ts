import { marked, type Tokens } from 'marked';
import { OnesApiError } from '../client/errors.js';

export interface OnesWikiDoc {
  blocks: Array<Record<string, unknown>>;
  comments?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

function makeBlockId(index: number): string {
  return `blk_${Date.now().toString(36)}_${index}`;
}

export function markdownToWikiBlocks(markdown: string): Array<Record<string, unknown>> {
  const tokens = marked.lexer(markdown);
  const blocks: Array<Record<string, unknown>> = [];
  let idx = 0;

  for (const token of tokens) {
    if (token.type === 'space') continue;

    if (token.type === 'heading') {
      blocks.push({
        id: makeBlockId(idx++),
        type: 'heading',
        level: token.depth,
        text: token.text
      });
    } else if (token.type === 'code') {
      blocks.push({
        id: makeBlockId(idx++),
        type: 'code',
        language: token.lang || 'plain',
        text: token.text
      });
    } else if (token.type === 'list') {
      const listTok = token as Tokens.List;
      blocks.push({
        id: makeBlockId(idx++),
        type: 'list',
        ordered: listTok.ordered,
        items: listTok.items.map((item) => ({
          text: item.text,
          ...(item.task ? { checked: Boolean(item.checked) } : {})
        }))
      });
    } else if (token.type === 'blockquote') {
      blocks.push({
        id: makeBlockId(idx++),
        type: 'blockquote',
        text: token.text
      });
    } else if (token.type === 'table') {
      const tbl = token as Tokens.Table;
      const rows = [
        tbl.header.map((c) => c.text),
        ...tbl.rows.map((r) => r.map((c) => c.text))
      ];
      blocks.push({
        id: makeBlockId(idx++),
        type: 'table',
        rows
      });
    } else if (token.type === 'hr') {
      blocks.push({ id: makeBlockId(idx++), type: 'divider' });
    } else if ('text' in token && typeof token.text === 'string') {
      blocks.push({
        id: makeBlockId(idx++),
        type: 'paragraph',
        text: token.text
      });
    }
  }

  return blocks;
}

export function markdownToWikiPayload(markdown: string): string {
  const doc: OnesWikiDoc = {
    blocks: markdownToWikiBlocks(markdown),
    comments: {},
    meta: { version: 1 }
  };
  return JSON.stringify(doc);
}

export function mergeWikiUpdatePayload(options: {
  existingContent: unknown;
  locked?: boolean;
  markdown?: string;
  mode: 'replace' | 'append';
}): string {
  if (options.locked) {
    throw new OnesApiError(
      'PAGE_LOCKED',
      'This Wiki page is locked in ONES and cannot be modified.'
    );
  }

  let existingDoc: OnesWikiDoc = { blocks: [], comments: {}, meta: {} };
  if (typeof options.existingContent === 'string' && options.existingContent.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(options.existingContent) as Partial<OnesWikiDoc>;
      existingDoc = {
        blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
        comments: parsed.comments && typeof parsed.comments === 'object' ? parsed.comments : {},
        meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}
      };
    } catch {
      // Fallback to empty envelope
    }
  } else if (options.existingContent && typeof options.existingContent === 'object') {
    const parsed = options.existingContent as Partial<OnesWikiDoc>;
    existingDoc = {
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
      comments: parsed.comments && typeof parsed.comments === 'object' ? parsed.comments : {},
      meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}
    };
  }

  const incomingBlocks = options.markdown ? markdownToWikiBlocks(options.markdown) : [];
  const nextBlocks =
    options.mode === 'append' ? [...existingDoc.blocks, ...incomingBlocks] : incomingBlocks;

  return JSON.stringify({
    blocks: nextBlocks,
    comments: existingDoc.comments ?? {},
    meta: existingDoc.meta ?? {}
  });
}
