export interface WikiSpace {
  spaceUUID: string;
  name: string;
  description?: string;
}

export interface WikiPageNode {
  pageUUID: string;
  spaceUUID?: string;
  parentPageUUID?: string;
  title: string;
  nodeType: 'online_page' | 'file' | 'unknown';
  fileUrl?: string;
  hasChildren: boolean;
  children: WikiPageNode[];
}

export interface WikiPageContentResult {
  pageUUID: string;
  spaceUUID?: string;
  title: string;
  nodeType: 'online_page' | 'file';
  locked?: boolean;
  url: string;
  markdown?: string;
  raw?: unknown;
  children: Array<{ pageUUID: string; title: string; nodeType: string; hasChildren: boolean }>;
  childPages?: Array<{ pageUUID: string; title: string; depth: number; markdown: string }>;
  truncated?: boolean;
  remainingPages?: Array<{ pageUUID: string; title: string }>;
}

export interface OnesComment {
  commentUUID: string;
  authorName?: string;
  authorUUID?: string;
  createdAt?: number;
  text: string;
}

export interface OnesProject {
  projectUUID: string;
  name: string;
  key?: string;
  status?: string;
}

export interface OnesProjectMetadata {
  projectUUID: string;
  issueTypes: Array<{ uuid: string; name: string }>;
  statuses: Array<{ uuid: string; name: string; category?: string }>;
  priorities: Array<{ uuid: string; name: string }>;
  sprints: Array<{ uuid: string; name: string; status?: string }>;
  members: Array<{ uuid: string; name: string; email?: string }>;
  customFields: Array<{ uuid: string; name: string; type?: string }>;
}

export interface OnesIssueSummary {
  issueUUID: string;
  number?: number;
  summary: string;
  status?: string;
  issueType?: string;
  priority?: string;
  assigneeName?: string;
  assigneeUUID?: string;
  projectUUID?: string;
  url: string;
}

export interface OnesIssueDetail extends OnesIssueSummary {
  descriptionMarkdown: string;
  sprintName?: string;
  customFields: Record<string, unknown>;
  transitions: Array<{ uuid: string; name: string; targetStatus: string }>;
  comments: OnesComment[];
}

export interface OnesWorklog {
  worklogUUID: string;
  hours: number;
  startTime?: number;
  description?: string;
  ownerName?: string;
}

export interface OnesAttachment {
  attachmentUUID: string;
  name: string;
  mimeType?: string;
  size?: number;
  downloadUrl: string;
}
