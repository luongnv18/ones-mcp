import path from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { getDocumentProxy, extractText } from 'unpdf';
import { OnesApiError } from '../client/errors.js';

export type DocumentReadResult =
  | {
      kind: 'text';
      text: string;
      truncated: boolean;
      totalChars: number;
      mimeType: string;
    }
  | {
      kind: 'image';
      base64: string;
      mimeType: string;
    };

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.xml',
  '.log',
  '.html',
  '.htm',
  '.sql'
]);

const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

function applyCharLimit(
  rawText: string,
  mimeType: string,
  maxChars: number
): DocumentReadResult {
  const totalChars = rawText.length;
  const truncated = totalChars > maxChars;
  return {
    kind: 'text',
    text: truncated ? rawText.slice(0, maxChars) : rawText,
    truncated,
    totalChars,
    mimeType
  };
}

export function excelCellToString(cell: unknown): string {
  if (cell === null || cell === undefined) {
    return '';
  }
  if (
    typeof cell === 'string' ||
    typeof cell === 'number' ||
    typeof cell === 'boolean' ||
    typeof cell === 'bigint'
  ) {
    return String(cell);
  }
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? '' : cell.toISOString();
  }
  if (Array.isArray(cell)) {
    return cell.map(excelCellToString).join('');
  }
  if (typeof cell === 'object') {
    const obj = cell as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return obj.richText.map(excelCellToString).join('');
    }
    if ('result' in obj && obj.result !== undefined) {
      if (
        obj.result &&
        typeof obj.result === 'object' &&
        'error' in (obj.result as Record<string, unknown>)
      ) {
        return String((obj.result as Record<string, unknown>).error ?? '#ERROR');
      }
      return excelCellToString(obj.result);
    }
    if ('error' in obj && obj.error !== undefined) {
      return String(obj.error);
    }
    if ('text' in obj && obj.text !== undefined) {
      return excelCellToString(obj.text);
    }
    if ('formula' in obj && obj.formula !== undefined) {
      return String(obj.formula);
    }
  }
  return String(cell);
}

export async function readDocumentBuffer(options: {
  buffer: Buffer;
  fileName?: string;
  contentType?: string;
  maxBytes?: number;
  maxChars?: number;
}): Promise<DocumentReadResult> {
  const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
  const maxChars = options.maxChars ?? 50_000;

  if (options.buffer.byteLength > maxBytes) {
    throw new OnesApiError(
      'VALIDATION_ERROR',
      `Document size (${options.buffer.byteLength} bytes) exceeds limit (${maxBytes} bytes).`
    );
  }

  const ext = options.fileName ? path.extname(options.fileName).toLowerCase() : '';
  const mime = (options.contentType ?? '').split(';')[0].trim().toLowerCase();

  if (IMAGE_MIME_MAP[ext] || mime.startsWith('image/')) {
    const resolvedMime = IMAGE_MIME_MAP[ext] ?? mime;
    if (resolvedMime === 'image/svg+xml') {
      return applyCharLimit(options.buffer.toString('utf8'), resolvedMime, maxChars);
    }
    return {
      kind: 'image',
      base64: options.buffer.toString('base64'),
      mimeType: resolvedMime
    };
  }

  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
    return applyCharLimit(options.buffer.toString('utf8'), mime || 'text/plain', maxChars);
  }

  if (ext === '.pdf' || mime === 'application/pdf') {
    const doc = await getDocumentProxy(new Uint8Array(options.buffer), { verbosity: 0 });
    try {
      const { text } = await extractText(doc, { mergePages: true });
      const normalized = Array.isArray(text) ? text.join('\n\n') : String(text);
      return applyCharLimit(normalized.trim(), 'application/pdf', maxChars);
    } finally {
      await doc.cleanup?.();
    }
  }

  if (
    ext === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const result = await mammoth.extractRawText({ buffer: options.buffer });
    return applyCharLimit(
      result.value.trim(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      maxChars
    );
  }

  if (
    ext === '.xlsx' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(options.buffer as unknown as ArrayBuffer);
    const sections: string[] = [];
    workbook.eachSheet((sheet) => {
      const rows: string[][] = [];
      sheet.eachRow((row) => {
        const vals = (row.values as unknown[]).slice(1).map((cell) =>
          excelCellToString(cell)
            .replace(/\|/g, '\\|')
            .replace(/\n+/g, ' ')
            .trim()
        );
        rows.push(vals);
      });
      if (rows.length === 0) return;
      const colCount = Math.max(...rows.map((r) => r.length), 1);
      const pad = (r: string[]) => Array.from({ length: colCount }, (_, i) => r[i] ?? '');
      const header = pad(rows[0]);
      const sep = Array.from({ length: colCount }, () => '---');
      sections.push(
        [
          `## Sheet: ${sheet.name}`,
          `| ${header.join(' | ')} |`,
          `| ${sep.join(' | ')} |`,
          ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)
        ].join('\n')
      );
    });
    return applyCharLimit(
      sections.join('\n\n'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      maxChars
    );
  }

  throw new OnesApiError(
    'UNSUPPORTED_FILE',
    `Unsupported document type (${options.fileName ?? mime ?? 'unknown'}). Use ones_attachment_download to save it locally.`
  );
}
