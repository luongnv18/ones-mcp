import { OnesApiError } from './errors.js';

export interface ParsedOnesRef {
  baseUrl?: string;
  teamUUID?: string;
  spaceUUID?: string;
  pageUUID?: string;
  projectUUID?: string;
  issueUUID?: string;
  issueNumber?: number;
  rawId?: string;
}

export function parseOnesReference(
  input: string,
  kind?: 'wiki' | 'project' | 'issue' | 'space'
): ParsedOnesRef {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new OnesApiError('VALIDATION_ERROR', 'Reference cannot be empty.');
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      throw new OnesApiError('VALIDATION_ERROR', `Invalid ONES URL: ${trimmed}`);
    }

    const fullPath = `${parsedUrl.pathname}${parsedUrl.hash}`.split('?')[0];
    const teamMatch = fullPath.match(/\/team\/([^/#]+)/);
    const spaceMatch = fullPath.match(/\/space\/([^/#]+)/);
    const pageMatch = fullPath.match(/\/(?:online_page|page)\/([^/#]+)/);
    const projectMatch = fullPath.match(/\/project\/([^/#]+)/);
    const issueMatch = fullPath.match(/\/(?:issue|task)\/([^/#]+)/);

    const result: ParsedOnesRef = {
      baseUrl: parsedUrl.origin
    };
    if (teamMatch?.[1]) result.teamUUID = teamMatch[1];
    if (spaceMatch?.[1]) result.spaceUUID = spaceMatch[1];
    if (pageMatch?.[1]) result.pageUUID = pageMatch[1];
    if (projectMatch?.[1]) result.projectUUID = projectMatch[1];
    if (issueMatch?.[1]) result.issueUUID = issueMatch[1];

    if (
      !result.teamUUID &&
      !result.spaceUUID &&
      !result.pageUUID &&
      !result.projectUUID &&
      !result.issueUUID
    ) {
      throw new OnesApiError(
        'VALIDATION_ERROR',
        `Could not recognize team/space/page/project/issue UUID from URL: ${trimmed}`
      );
    }
    return result;
  }

  if (/\s/.test(trimmed)) {
    throw new OnesApiError('VALIDATION_ERROR', `Invalid ONES identifier: ${trimmed}`);
  }

  const numberMatch = trimmed.match(/^#?(\d+)$/);
  if (numberMatch && kind === 'issue') {
    return { issueNumber: Number(numberMatch[1]), rawId: trimmed };
  }

  const out: ParsedOnesRef = { rawId: trimmed };
  if (kind === 'wiki') out.pageUUID = trimmed;
  else if (kind === 'space') out.spaceUUID = trimmed;
  else if (kind === 'project') out.projectUUID = trimmed;
  else if (kind === 'issue') out.issueUUID = trimmed;
  return out;
}
