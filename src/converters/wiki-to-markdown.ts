import TurndownService from 'turndown';

type GenericObj = Record<string, unknown>;

function inlineChildrenToMarkdown(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(inlineChildrenToMarkdown).join('');

  const obj = node as GenericObj;
  let text = typeof obj.text === 'string' ? obj.text : '';
  if (!text && Array.isArray(obj.children)) {
    text = obj.children.map(inlineChildrenToMarkdown).join('');
  }
  if (!text && typeof obj.content === 'string') {
    text = obj.content;
  }

  if (obj.code) text = `\`${text}\``;
  if (obj.bold || obj.strong) text = `**${text}**`;
  if (obj.italic || obj.em) text = `*${text}*`;
  if (obj.strikethrough || obj.strike) text = `~~${text}~~`;

  const href = typeof obj.href === 'string' ? obj.href : typeof obj.url === 'string' ? obj.url : undefined;
  if (href && obj.type === 'link') {
    return `[${text || href}](${href})`;
  }
  return text;
}

function tableToMarkdown(rows: unknown[]): string {
  const normalizedRows = rows.map((row) => {
    if (Array.isArray(row)) {
      return row.map((cell) => inlineChildrenToMarkdown(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim());
    }
    const rObj = row as GenericObj;
    const cells = Array.isArray(rObj.cells) ? rObj.cells : [];
    return cells.map((cell) => inlineChildrenToMarkdown(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim());
  });
  if (normalizedRows.length === 0) return '';
  const colCount = Math.max(...normalizedRows.map((r) => r.length), 1);
  const pad = (r: string[]) => Array.from({ length: colCount }, (_, i) => r[i] ?? '');
  const header = pad(normalizedRows[0]);
  const separator = Array.from({ length: colCount }, () => '---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...normalizedRows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)
  ];
  return lines.join('\n');
}

function blockToMarkdown(block: unknown): string {
  if (!block || typeof block !== 'object') return String(block ?? '');
  const b = block as GenericObj;
  const type = String(b.type ?? b.nodeType ?? 'paragraph').toLowerCase();

  if (type === 'heading' || /^h[1-6]$/.test(type)) {
    const level =
      typeof b.level === 'number'
        ? Math.min(Math.max(b.level, 1), 6)
        : type.startsWith('h')
          ? Number(type.slice(1))
          : 1;
    const content = inlineChildrenToMarkdown(b.children ?? b.text ?? '');
    return `${'#'.repeat(level)} ${content.trim()}`;
  }

  if (type === 'code' || type === 'code_block' || type === 'mermaid' || type === 'plantuml') {
    const lang = String(b.language ?? b.lang ?? (type === 'mermaid' || type === 'plantuml' ? type : '')).trim();
    const code = typeof b.text === 'string' ? b.text : typeof b.code === 'string' ? b.code : inlineChildrenToMarkdown(b.children ?? '');
    return `\`\`\`${lang}\n${code}\n\`\`\``;
  }

  if (type === 'list' || type === 'bulleted_list' || type === 'numbered_list') {
    const ordered = Boolean(b.ordered) || type === 'numbered_list';
    const items = Array.isArray(b.items) ? b.items : Array.isArray(b.children) ? b.children : [];
    return items
      .map((item, idx) => {
        const it = (item && typeof item === 'object' ? item : { text: String(item) }) as GenericObj;
        const prefix = ordered
          ? `${idx + 1}. `
          : typeof it.checked === 'boolean'
            ? `- [${it.checked ? 'x' : ' '}] `
            : '- ';
        return `${prefix}${inlineChildrenToMarkdown(it.children ?? it.text ?? it).trim()}`;
      })
      .join('\n');
  }

  if (type === 'todo' || type === 'task' || type === 'check_list_item') {
    const mark = b.checked ? 'x' : ' ';
    return `- [${mark}] ${inlineChildrenToMarkdown(b.children ?? b.text ?? '').trim()}`;
  }

  if (type === 'blockquote' || type === 'quote') {
    const inner = inlineChildrenToMarkdown(b.children ?? b.text ?? '');
    return inner
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  }

  if (type === 'table') {
    const rows = Array.isArray(b.rows) ? b.rows : Array.isArray(b.children) ? b.children : [];
    return tableToMarkdown(rows);
  }

  if (type === 'image' || type === 'attachment') {
    const url = String(b.url ?? b.src ?? b.fileUUID ?? '');
    const alt = String(b.alt ?? b.name ?? b.title ?? 'attachment');
    return `![${alt}](${url})`;
  }

  if (type === 'divider' || type === 'hr') {
    return '---';
  }

  return inlineChildrenToMarkdown(b.children ?? b.text ?? '').trim();
}

function createHtmlTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
  });
  td.addRule('fencedCodeWithLang', {
    filter: (node) => node.nodeName === 'PRE' && node.firstChild?.nodeName === 'CODE',
    replacement: (_content, node) => {
      const codeEl = node.firstChild as unknown as { className?: string; textContent?: string | null } | null;
      const cls = codeEl?.className ?? '';
      const langMatch = cls.match(/language-([^\s]+)/);
      const lang = langMatch?.[1] ?? '';
      const text = codeEl?.textContent ?? '';
      return `\n\`\`\`${lang}\n${text.replace(/\n$/, '')}\n\`\`\`\n`;
    }
  });
  return td;
}

export function wikiContentToMarkdown(rawContent: unknown): string {
  if (rawContent === null || rawContent === undefined) return '';

  let parsed: unknown = rawContent;
  if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = rawContent;
      }
    }
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as GenericObj;
    if (Array.isArray(obj.blocks)) {
      return obj.blocks.map(blockToMarkdown).filter(Boolean).join('\n\n').trim();
    }
    if (Array.isArray(parsed)) {
      return parsed.map(blockToMarkdown).filter(Boolean).join('\n\n').trim();
    }
    if (typeof obj.content === 'string') {
      return wikiContentToMarkdown(obj.content);
    }
  }

  const text = String(parsed);
  if (/<[a-z][\s\S]*>/i.test(text)) {
    return createHtmlTurndown().turndown(text).trim();
  }
  return text.trim();
}
