import fs from 'node:fs';
import path from 'node:path';
import { readDocumentBuffer, type DocumentReadResult } from '../../converters/document-reader.js';
import { OnesApiError } from '../errors.js';
import type { OnesHttpClient } from '../http-client.js';
import type { OnesAttachment } from './types.js';

type AnyObj = Record<string, unknown>;

export class AttachmentAdapter {
  constructor(
    private readonly http: OnesHttpClient,
    private readonly maxReadBytes = 15 * 1024 * 1024
  ) {}

  async listAttachments(options: {
    teamUUID: string;
    targetType: 'issue' | 'wiki';
    targetUUID: string;
  }): Promise<OnesAttachment[]> {
    const endpoint =
      options.targetType === 'wiki'
        ? `/wiki/api/wiki/team/${options.teamUUID}/page/${options.targetUUID}/attachments`
        : `/project/api/project/team/${options.teamUUID}/task/${options.targetUUID}/attachments`;

    const data = await this.http.requestJson<AnyObj>(endpoint);
    const list = (Array.isArray(data.files) ? data.files : Array.isArray(data.attachments) ? data.attachments : []) as AnyObj[];

    return list.map((f) => {
      const attachmentUUID = String(f.uuid ?? f.id ?? '');
      const fallbackUrl =
        options.targetType === 'wiki'
          ? `/wiki/api/wiki/team/${options.teamUUID}/file/${attachmentUUID}`
          : `/project/api/project/team/${options.teamUUID}/res/attachment/${attachmentUUID}`;
      return {
        attachmentUUID,
        name: String(f.name ?? f.title ?? attachmentUUID),
        mimeType: f.mime_type ? String(f.mime_type) : undefined,
        size: typeof f.size === 'number' ? f.size : undefined,
        downloadUrl: f.url ? String(f.url) : fallbackUrl
      };
    });
  }

  private resolveDownloadPath(options: {
    teamUUID: string;
    attachmentUUID?: string;
    fileUrl?: string;
    targetType?: 'issue' | 'wiki';
  }): string {
    if (options.fileUrl) return options.fileUrl;
    if (!options.attachmentUUID) {
      throw new OnesApiError('VALIDATION_ERROR', 'Provide either attachmentUUID or fileUrl.');
    }
    return options.targetType === 'wiki'
      ? `/wiki/api/wiki/team/${options.teamUUID}/file/${options.attachmentUUID}`
      : `/project/api/project/team/${options.teamUUID}/res/attachment/${options.attachmentUUID}`;
  }

  async readAttachment(options: {
    teamUUID: string;
    attachmentUUID?: string;
    fileUrl?: string;
    targetType?: 'issue' | 'wiki';
    maxChars?: number;
  }): Promise<DocumentReadResult & { fileName?: string }> {
    const url = this.resolveDownloadPath(options);
    const bin = await this.http.requestBinary(url, { maxBytes: this.maxReadBytes });
    const result = await readDocumentBuffer({
      buffer: bin.buffer,
      fileName: bin.fileName ?? options.attachmentUUID,
      contentType: bin.contentType,
      maxBytes: this.maxReadBytes,
      maxChars: options.maxChars
    });
    return { ...result, fileName: bin.fileName };
  }

  async downloadAttachment(options: {
    teamUUID: string;
    attachmentUUID?: string;
    fileUrl?: string;
    targetType?: 'issue' | 'wiki';
    outputPath: string;
  }): Promise<{ savedPath: string; bytes: number }> {
    const url = this.resolveDownloadPath(options);
    const bin = await this.http.requestBinary(url, { maxBytes: 100 * 1024 * 1024 });
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, bin.buffer);
    return { savedPath: options.outputPath, bytes: bin.buffer.byteLength };
  }

  async uploadAttachment(options: {
    teamUUID: string;
    targetType: 'issue' | 'wiki';
    targetUUID: string;
    filePath: string;
  }): Promise<{ attachmentUUID: string; name: string }> {
    if (!fs.existsSync(options.filePath)) {
      throw new OnesApiError('VALIDATION_ERROR', `Local file not found: ${options.filePath}`);
    }
    const bytes = fs.readFileSync(options.filePath);
    const name = path.basename(options.filePath);
    const form = new FormData();
    // Controller Ruling 4: Use new Blob([new Uint8Array(bytes)]) for strict TS 5.9 compatibility
    form.append('file', new Blob([new Uint8Array(bytes)]), name);

    const endpoint =
      options.targetType === 'wiki'
        ? `/wiki/api/wiki/team/${options.teamUUID}/page/${options.targetUUID}/attachments/add`
        : `/project/api/project/team/${options.teamUUID}/task/${options.targetUUID}/attachments/add`;

    const data = await this.http.uploadMultipart<AnyObj>(endpoint, form);
    return {
      attachmentUUID: String(data.uuid ?? data.id ?? ''),
      name: String(data.name ?? name)
    };
  }
}
