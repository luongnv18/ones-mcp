import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { readDocumentBuffer } from '../src/converters/document-reader.js';
import { OnesApiError } from '../src/client/errors.js';

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (~crc) >>> 0;
}

function buildStoredZip(files: Array<{ name: string; content: string | Buffer }>): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const crc = crc32(dataBuf);
    const size = dataBuf.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // stored (no compression)
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, dataBuf);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0, 8);
    cdHeader.writeUInt16LE(0, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(size, 20);
    cdHeader.writeUInt32LE(size, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(offset, 42);

    cdChunks.push(cdHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + size;
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(cdChunks);
  const cdSize = cdBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

function createMinimalPdf(text = 'Hello ONES PDF'): Buffer {
  const stream = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
  const streamLen = Buffer.byteLength(stream);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  function addObj(num: number, content: string) {
    offsets[num] = Buffer.byteLength(pdf);
    pdf += `${num} 0 obj\n${content}\nendobj\n`;
  }

  addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  addObj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  addObj(4, `<< /Length ${streamLen} >>\nstream\n${stream}\nendstream`);
  addObj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

function createMinimalDocx(text = 'Hello ONES DOCX'): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const docXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>' +
    text +
    '</w:t></w:r></w:p></w:body></w:document>';

  return buildStoredZip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rels },
    { name: 'word/document.xml', content: docXml }
  ]);
}

describe('readDocumentBuffer', () => {
  it('reads UTF-8 text/markdown files and truncates when exceeding maxChars', async () => {
    const res = await readDocumentBuffer({
      buffer: Buffer.from('# Hello\n' + 'A'.repeat(100), 'utf8'),
      fileName: 'notes.md',
      maxChars: 20
    });
    expect(res.kind).toBe('text');
    if (res.kind === 'text') {
      expect(res.text).toHaveLength(20);
      expect(res.truncated).toBe(true);
      expect(res.totalChars).toBe(108);
      expect(res.mimeType).toBe('text/plain');
    }
  });

  it('reads SVG files as text instead of binary image payload', async () => {
    const svgContent = '<svg><text>Logo</text></svg>';
    const res = await readDocumentBuffer({
      buffer: Buffer.from(svgContent, 'utf8'),
      fileName: 'logo.svg',
      contentType: 'image/svg+xml'
    });
    expect(res.kind).toBe('text');
    if (res.kind === 'text') {
      expect(res.text).toBe(svgContent);
      expect(res.mimeType).toBe('image/svg+xml');
      expect(res.truncated).toBe(false);
    }
  });

  it('extracts Excel (.xlsx) worksheets into Markdown tables', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sprint');
    ws.addRow(['Key', 'Owner']);
    ws.addRow(['ISS-1', 'Alice']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await readDocumentBuffer({
      buffer: buf,
      fileName: 'sprint.xlsx'
    });
    expect(res.kind).toBe('text');
    if (res.kind === 'text') {
      expect(res.text).toContain('## Sheet: Sprint');
      expect(res.text).toContain('| Key | Owner |');
      expect(res.text).toContain('| ISS-1 | Alice |');
      expect(res.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  });

  it('returns MCP image payload for PNG/JPG images', async () => {
    const rawPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const imgPng = await readDocumentBuffer({
      buffer: rawPng,
      fileName: 'diagram.png',
      contentType: 'image/png'
    });
    expect(imgPng.kind).toBe('image');
    if (imgPng.kind === 'image') {
      expect(imgPng.mimeType).toBe('image/png');
      expect(imgPng.base64).toBe(rawPng.toString('base64'));
    }

    const rawJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const imgJpg = await readDocumentBuffer({
      buffer: rawJpg,
      fileName: 'photo.jpg'
    });
    expect(imgJpg.kind).toBe('image');
    if (imgJpg.kind === 'image') {
      expect(imgJpg.mimeType).toBe('image/jpeg');
      expect(imgJpg.base64).toBe(rawJpg.toString('base64'));
    }
  });

  it('extracts PDF documents using unpdf and applies maxChars', async () => {
    const pdfBuf = createMinimalPdf('Hello ONES PDF');
    const res = await readDocumentBuffer({
      buffer: pdfBuf,
      fileName: 'document.pdf',
      contentType: 'application/pdf'
    });
    expect(res.kind).toBe('text');
    if (res.kind === 'text') {
      expect(res.text).toContain('Hello ONES PDF');
      expect(res.mimeType).toBe('application/pdf');
      expect(res.truncated).toBe(false);
    }
  });

  it('extracts Word (.docx) documents using mammoth', async () => {
    const docxBuf = createMinimalDocx('Hello ONES DOCX');
    const res = await readDocumentBuffer({
      buffer: docxBuf,
      fileName: 'specification.docx'
    });
    expect(res.kind).toBe('text');
    if (res.kind === 'text') {
      expect(res.text).toBe('Hello ONES DOCX');
      expect(res.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(res.truncated).toBe(false);
    }
  });

  it('enforces maxBytes limit and rejects oversized files with VALIDATION_ERROR', async () => {
    const largeBuf = Buffer.alloc(1024, 0x41);
    await expect(
      readDocumentBuffer({
        buffer: largeBuf,
        fileName: 'huge.txt',
        maxBytes: 512
      })
    ).rejects.toSatisfy((err) => {
      expect(err).toBeInstanceOf(OnesApiError);
      expect((err as OnesApiError).code).toBe('VALIDATION_ERROR');
      expect((err as OnesApiError).message).toContain('exceeds limit (512 bytes)');
      return true;
    });
  });

  it('rejects unsupported binary formats with UNSUPPORTED_FILE', async () => {
    await expect(
      readDocumentBuffer({
        buffer: Buffer.from([0x00, 0x01, 0x02]),
        fileName: 'archive.bin',
        contentType: 'application/octet-stream'
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' } satisfies Partial<OnesApiError>);
  });

  it('unwraps ExcelJS formula and rich-text cells into clean Markdown with zero [object Object]', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Summary');
    sheet.addRow(['Metric', 'Formula Value', 'Rich Text Link']);
    sheet.addRow([
      'Revenue',
      { formula: 'SUM(100, 200)', result: 300 },
      {
        richText: [
          { text: 'Quarterly ' },
          { text: 'Report', font: { bold: true, color: { argb: 'FF0000FF' } } }
        ]
      }
    ]);
    sheet.addRow([
      'Profit',
      { formula: 'A2*0.2' },
      { text: 'Documentation', hyperlink: 'https://ones.ai' }
    ]);

    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    const res = await readDocumentBuffer({
      buffer: Buffer.from(buffer),
      fileName: 'financials.xlsx'
    });

    expect(res.kind).toBe('text');
    if (res.kind === 'text') {
      expect(res.text).not.toContain('[object Object]');
      expect(res.text).toContain('## Sheet: Summary');
      expect(res.text).toContain('Revenue');
      expect(res.text).toContain('300');
      expect(res.text).toContain('Quarterly Report');
      expect(res.text).toContain('A2*0.2');
      expect(res.text).toContain('Documentation');
    }
  });
});
