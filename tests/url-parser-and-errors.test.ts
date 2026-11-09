import { describe, expect, it } from 'vitest';
import { OnesApiError, formatMcpError } from '../src/client/errors.js';
import { parseOnesReference } from '../src/client/url-parser.js';

describe('parseOnesReference', () => {
  it('parses full ONES Wiki page URL with hash route', () => {
    const parsed = parseOnesReference(
      'https://ones.example.com/wiki/#/team/Tm123456/space/Sp654321/page/Pg987654?tab=view'
    );
    expect(parsed).toEqual({
      baseUrl: 'https://ones.example.com',
      teamUUID: 'Tm123456',
      spaceUUID: 'Sp654321',
      pageUUID: 'Pg987654'
    });
  });

  it('parses ONES Wiki online_page URL and space URL', () => {
    const page = parseOnesReference('https://ones.example.com/wiki/#/team/T1/space/S1/online_page/P1');
    expect(page.pageUUID).toBe('P1');
    expect(page.spaceUUID).toBe('S1');

    const space = parseOnesReference('https://ones.example.com/wiki/#/team/T1/space/S1');
    expect(space.spaceUUID).toBe('S1');
    expect(space.pageUUID).toBeUndefined();
  });

  it('parses ONES Project & Issue URLs and issue key / raw UUID', () => {
    const issue = parseOnesReference(
      'https://ones.example.com/project/#/team/T1/project/PRJ1/issue/ISS1'
    );
    expect(issue).toEqual({
      baseUrl: 'https://ones.example.com',
      teamUUID: 'T1',
      projectUUID: 'PRJ1',
      issueUUID: 'ISS1'
    });

    const byNumber = parseOnesReference('#452', 'issue');
    expect(byNumber.issueNumber).toBe(452);

    const byUuid = parseOnesReference('AbCdEf12', 'wiki');
    expect(byUuid.pageUUID).toBe('AbCdEf12');
    expect(byUuid.rawId).toBe('AbCdEf12');

    const bySpace = parseOnesReference('Space123', 'space');
    expect(bySpace.spaceUUID).toBe('Space123');

    const byProject = parseOnesReference('Prj123', 'project');
    expect(byProject.projectUUID).toBe('Prj123');

    const taskUrl = parseOnesReference(
      'https://ones.example.com/project/#/team/T1/project/PRJ1/task/TSK1'
    );
    expect(taskUrl.issueUUID).toBe('TSK1');
  });

  it('throws OnesApiError VALIDATION_ERROR on empty input or invalid URL', () => {
    expect(() => parseOnesReference('   ')).toThrowError(OnesApiError);
    expect(() => parseOnesReference('not a valid url with spaces')).toThrowError(OnesApiError);
    expect(() => parseOnesReference('https://ones.example.com/about')).toThrowError(OnesApiError);
  });
});

describe('OnesApiError & formatMcpError', () => {
  it('formats AUTH_REQUIRED with login guidance', () => {
    const err = new OnesApiError('AUTH_REQUIRED', 'Session expired', { status: 401 });
    const mcp = formatMcpError(err);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toContain('AUTH_REQUIRED');
    expect(mcp.content[0].text).toContain('ones_login');
    expect(mcp.content[0].text).toContain('HTTP Status: 401');
  });

  it('formats OnesApiError with structured details and redacts secrets', () => {
    const err = new OnesApiError('API_ERROR', 'Request failed with Bearer secret-tok-999', {
      details: { header: 'Bearer top-secret-tok' }
    });
    const mcp = formatMcpError(err);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toContain('[API_ERROR]');
    expect(mcp.content[0].text).not.toContain('secret-tok-999');
    expect(mcp.content[0].text).not.toContain('top-secret-tok');
    expect(mcp.content[0].text).toContain('[REDACTED]');
  });

  it('handles non-Error objects gracefully in formatMcpError', () => {
    const mcp = formatMcpError('raw string error with Bearer token-123');
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0].text).toContain('[API_ERROR]');
    expect(mcp.content[0].text).not.toContain('token-123');
    expect(mcp.content[0].text).toContain('[REDACTED]');
  });

  it('redacts accidental Bearer secrets inside error messages', () => {
    const mcp = formatMcpError(new Error('Failed with Authorization: Bearer secret-jwt-123'));
    expect(mcp.content[0].text).not.toContain('secret-jwt-123');
    expect(mcp.content[0].text).toContain('[REDACTED]');
  });

  it('safely handles circular references and BigInt in details without throwing', () => {
    const circular: Record<string, unknown> = { note: 'recursive' };
    circular.self = circular;
    const errCircular = new OnesApiError('API_ERROR', 'Circular details error', {
      details: circular
    });
    const mcpCircular = formatMcpError(errCircular);
    expect(mcpCircular.isError).toBe(true);
    expect(mcpCircular.content[0].text).toContain('[API_ERROR] Circular details error');
    expect(mcpCircular.content[0].text).toContain('Details:');

    const errBigInt = new OnesApiError('API_ERROR', 'BigInt details error', {
      details: { count: 9007199254740991n }
    });
    const mcpBigInt = formatMcpError(errBigInt);
    expect(mcpBigInt.isError).toBe(true);
    expect(mcpBigInt.content[0].text).toContain('[API_ERROR] BigInt details error');
    expect(mcpBigInt.content[0].text).toContain('Details:');
  });
});
