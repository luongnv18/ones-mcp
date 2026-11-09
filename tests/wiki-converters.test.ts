import { describe, expect, it } from 'vitest';
import { wikiContentToMarkdown } from '../src/converters/wiki-to-markdown.js';
import {
  markdownToWikiBlocks,
  markdownToWikiPayload,
  mergeWikiUpdatePayload
} from '../src/converters/markdown-to-wiki.js';
import { OnesApiError } from '../src/client/errors.js';

describe('wikiContentToMarkdown', () => {
  it('converts ONES collaboration JSON blocks including headings, tasks, code, mermaid, and tables', () => {
    const collab = JSON.stringify({
      blocks: [
        { type: 'heading', level: 1, text: 'Architecture Overview' },
        { type: 'paragraph', children: [{ text: 'Intro ' }, { text: 'bold', bold: true }] },
        { type: 'list', ordered: false, items: [{ text: 'First item' }, { text: 'Done task', checked: true }] },
        { type: 'code', language: 'mermaid', text: 'flowchart LR\nA-->B' },
        {
          type: 'table',
          rows: [
            ['Service', 'Owner'],
            ['Auth', 'Platform']
          ]
        }
      ],
      comments: { c1: { text: 'keep me' } },
      meta: { version: 3 }
    });

    const md = wikiContentToMarkdown(collab);
    expect(md).toContain('# Architecture Overview');
    expect(md).toContain('Intro **bold**');
    expect(md).toContain('- First item');
    expect(md).toContain('- [x] Done task');
    expect(md).toContain('```mermaid\nflowchart LR\nA-->B\n```');
    expect(md).toContain('| Service | Owner |');
    expect(md).toContain('| Auth | Platform |');
  });

  it('converts HTML Wiki body cleanly to Markdown', () => {
    const html = '<h2>API Guide</h2><p>Read <a href="https://example.com">docs</a></p><pre><code class="language-ts">const x = 1;</code></pre>';
    const md = wikiContentToMarkdown(html);
    expect(md).toContain('## API Guide');
    expect(md).toContain('[docs](https://example.com)');
    expect(md).toContain('```ts');
    expect(md).toContain('const x = 1;');
  });

  it('handles empty, null, undefined, and plain text content cleanly', () => {
    expect(wikiContentToMarkdown(null)).toBe('');
    expect(wikiContentToMarkdown(undefined)).toBe('');
    expect(wikiContentToMarkdown('')).toBe('');
    expect(wikiContentToMarkdown('   ')).toBe('');
    expect(wikiContentToMarkdown('Plain text only')).toBe('Plain text only');
  });

  it('converts ordered lists, blockquotes, images, and dividers in block JSON', () => {
    const collab = {
      blocks: [
        {
          type: 'list',
          ordered: true,
          items: [{ text: 'Step 1' }, { text: 'Step 2' }]
        },
        {
          type: 'blockquote',
          text: 'This is a quote\nsecond line'
        },
        {
          type: 'image',
          url: 'https://example.com/logo.png',
          alt: 'Logo'
        },
        {
          type: 'divider'
        }
      ]
    };

    const md = wikiContentToMarkdown(collab);
    expect(md).toContain('1. Step 1\n2. Step 2');
    expect(md).toContain('> This is a quote\n> second line');
    expect(md).toContain('![Logo](https://example.com/logo.png)');
    expect(md).toContain('---');
  });

  it('converts inline formatting (italic, strikethrough, code, links)', () => {
    const collab = {
      blocks: [
        {
          type: 'paragraph',
          children: [
            { text: 'code snippet', code: true },
            { text: ' ' },
            { text: 'italic text', italic: true },
            { text: ' ' },
            { text: 'struck text', strikethrough: true },
            { text: ' ' },
            { type: 'link', href: 'https://ones.com', text: 'ONES Link' }
          ]
        }
      ]
    };

    const md = wikiContentToMarkdown(collab);
    expect(md).toContain('`code snippet` *italic text* ~~struck text~~ [ONES Link](https://ones.com)');
  });
});

describe('markdownToWikiPayload & mergeWikiUpdatePayload', () => {
  it('rejects updating locked pages with PAGE_LOCKED', () => {
    expect(() =>
      mergeWikiUpdatePayload({
        existingContent: '{"blocks":[]}',
        locked: true,
        markdown: '# New',
        mode: 'replace'
      })
    ).toThrowError(OnesApiError);

    try {
      mergeWikiUpdatePayload({
        existingContent: '{"blocks":[]}',
        locked: true,
        markdown: '# New',
        mode: 'replace'
      });
    } catch (e) {
      expect((e as OnesApiError).code).toBe('PAGE_LOCKED');
    }
  });

  it('preserves existing comments and meta in replace and append modes', () => {
    const existing = JSON.stringify({
      blocks: [{ id: 'b1', type: 'paragraph', text: 'Existing intro' }],
      comments: { c1: { text: 'important comment' } },
      meta: { version: 7, custom: true }
    });

    const appended = JSON.parse(
      mergeWikiUpdatePayload({
        existingContent: existing,
        markdown: '## Added Section\nNew details',
        mode: 'append'
      })
    );
    expect(appended.blocks[0].text).toBe('Existing intro');
    expect(appended.blocks.some((b: { text?: string }) => b.text === 'Added Section')).toBe(true);
    expect(appended.comments.c1.text).toBe('important comment');
    expect(appended.meta.version).toBe(7);

    const replaced = JSON.parse(
      mergeWikiUpdatePayload({
        existingContent: existing,
        markdown: '# Fresh Title',
        mode: 'replace'
      })
    );
    expect(replaced.blocks).toHaveLength(1);
    expect(replaced.blocks[0].text).toBe('Fresh Title');
    expect(replaced.comments.c1.text).toBe('important comment');

    const fresh = JSON.parse(markdownToWikiPayload('# Brand New\n\n- bullet'));
    expect(fresh.blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('converts markdown blocks cleanly with markdownToWikiBlocks', () => {
    const md = `# Title
Here is a paragraph with [link](https://example.com)

\`\`\`python
print("hello")
\`\`\`

> Quote here

- [ ] Task pending
- [x] Task finished

| Col A | Col B |
| --- | --- |
| Val 1 | Val 2 |

---
`;
    const blocks = markdownToWikiBlocks(md);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'heading', level: 1, text: 'Title' }),
        expect.objectContaining({ type: 'paragraph' }),
        expect.objectContaining({ type: 'code', language: 'python', text: 'print("hello")' }),
        expect.objectContaining({ type: 'blockquote', text: 'Quote here' }),
        expect.objectContaining({
          type: 'list',
          ordered: false,
          items: [
            { text: 'Task pending', checked: false },
            { text: 'Task finished', checked: true }
          ]
        }),
        expect.objectContaining({
          type: 'table',
          rows: [
            ['Col A', 'Col B'],
            ['Val 1', 'Val 2']
          ]
        }),
        expect.objectContaining({ type: 'divider' })
      ])
    );
  });

  it('handles null/invalid existingContent gracefully in mergeWikiUpdatePayload', () => {
    const res = JSON.parse(
      mergeWikiUpdatePayload({
        existingContent: null,
        markdown: 'Some text',
        mode: 'append'
      })
    );
    expect(res.blocks).toHaveLength(1);
    expect(res.blocks[0].text).toBe('Some text');
    expect(res.comments).toEqual({});
    expect(res.meta).toEqual({});
  });
});
