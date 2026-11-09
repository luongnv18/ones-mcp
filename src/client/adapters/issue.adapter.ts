import { wikiContentToMarkdown } from '../../converters/wiki-to-markdown.js';
import { OnesApiError } from '../errors.js';
import type { OnesHttpClient } from '../http-client.js';
import type { OnesComment, OnesIssueDetail, OnesIssueSummary } from './types.js';

type AnyObj = Record<string, unknown>;

export class IssueAdapter {
  constructor(private readonly http: OnesHttpClient) {}

  async searchIssues(options: {
    teamUUID: string;
    projectUUID?: string;
    query?: string;
    status?: string;
    assigneeUUID?: string;
    sprintUUID?: string;
    issueType?: string;
    limit?: number;
    offset?: number;
  }): Promise<OnesIssueSummary[]> {
    const filter: AnyObj = {};
    if (options.projectUUID) filter.project_in = [options.projectUUID];
    if (options.assigneeUUID) filter.assign_in = [options.assigneeUUID];
    if (options.sprintUUID) filter.sprint_in = [options.sprintUUID];
    if (options.status) filter.status_name_match = options.status;
    if (options.issueType) filter.issue_type_name_match = options.issueType;
    if (options.query) filter.search = { keyword: options.query };

    const limit = Math.min(options.limit ?? 20, 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const gql = `
      query SearchTasks($filter: Filter, $pagination: Pagination) {
        tasks(filter: $filter, pagination: $pagination) {
          uuid
          number
          name
          status { name }
          issueType { name }
          priority { value }
          assign { uuid name }
          project { uuid }
        }
      }
    `;

    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/items/graphql`,
      {
        method: 'POST',
        isReadOnlyQuery: true,
        body: {
          query: gql,
          variables: {
            filter,
            pagination: {
              limit,
              offset
            }
          }
        }
      }
    );

    const tasks = ((data.data as AnyObj | undefined)?.tasks ?? data.tasks ?? []) as AnyObj[];
    return tasks.map((t) => {
      const uuid = String(t.uuid ?? '');
      const projectUUID = (t.project as AnyObj | undefined)?.uuid
        ? String((t.project as AnyObj).uuid)
        : options.projectUUID;
      return {
        issueUUID: uuid,
        number: typeof t.number === 'number' ? t.number : undefined,
        summary: String(t.name ?? t.summary ?? ''),
        status: (t.status as AnyObj | undefined)?.name ? String((t.status as AnyObj).name) : undefined,
        issueType: (t.issueType as AnyObj | undefined)?.name
          ? String((t.issueType as AnyObj).name)
          : undefined,
        priority: (t.priority as AnyObj | undefined)?.value
          ? String((t.priority as AnyObj).value)
          : undefined,
        assigneeName: (t.assign as AnyObj | undefined)?.name
          ? String((t.assign as AnyObj).name)
          : undefined,
        assigneeUUID: (t.assign as AnyObj | undefined)?.uuid
          ? String((t.assign as AnyObj).uuid)
          : undefined,
        projectUUID,
        url: `${this.http.getBaseUrl()}/project/#/team/${options.teamUUID}/project/${projectUUID ?? 'unknown'}/issue/${uuid}`
      };
    });
  }

  async getIssue(options: {
    teamUUID: string;
    issueUUID: string;
  }): Promise<OnesIssueDetail> {
    const [task, transitions, comments] = await Promise.all([
      this.http.requestJson<AnyObj>(
        `/project/api/project/team/${options.teamUUID}/task/${options.issueUUID}/info`
      ),
      this.listTransitions(options.teamUUID, options.issueUUID).catch(() => []),
      this.listComments({ teamUUID: options.teamUUID, issueUUID: options.issueUUID }).catch(() => [])
    ]);

    const projectUUID = task.project_uuid ? String(task.project_uuid) : undefined;
    return {
      issueUUID: String(task.uuid ?? options.issueUUID),
      number: typeof task.number === 'number' ? task.number : undefined,
      summary: String(task.summary ?? task.name ?? ''),
      status: task.status_name ? String(task.status_name) : undefined,
      issueType: task.issue_type_name ? String(task.issue_type_name) : undefined,
      priority: task.priority_name ? String(task.priority_name) : undefined,
      assigneeName: task.assign_name ? String(task.assign_name) : undefined,
      assigneeUUID: task.assign ? String(task.assign) : undefined,
      projectUUID,
      sprintName: task.sprint_name ? String(task.sprint_name) : undefined,
      descriptionMarkdown: wikiContentToMarkdown(task.desc_rich ?? task.desc ?? ''),
      customFields: (task.field_values as Record<string, unknown>) ?? {},
      transitions,
      comments,
      url: `${this.http.getBaseUrl()}/project/#/team/${options.teamUUID}/project/${projectUUID ?? 'unknown'}/issue/${options.issueUUID}`
    };
  }

  async listTransitions(
    teamUUID: string,
    issueUUID: string
  ): Promise<Array<{ uuid: string; name: string; targetStatus: string }>> {
    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${teamUUID}/task/${issueUUID}/transitions`
    );
    const list = (Array.isArray(data.transitions) ? data.transitions : []) as AnyObj[];
    return list.map((tr) => ({
      uuid: String(tr.uuid ?? ''),
      name: String(tr.name ?? ''),
      targetStatus: String(tr.end_status_name ?? tr.target_status_name ?? tr.name ?? '')
    }));
  }

  async createIssue(options: {
    teamUUID: string;
    projectUUID: string;
    issueType: string;
    summary: string;
    descriptionMarkdown?: string;
    assigneeUUID?: string;
    priority?: string;
    sprintUUID?: string;
    parentIssueUUID?: string;
    customFields?: Record<string, unknown>;
  }): Promise<{ issueUUID: string; url: string }> {
    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/tasks/add`,
      {
        method: 'POST',
        body: {
          tasks: [
            {
              project_uuid: options.projectUUID,
              issue_type_uuid: options.issueType,
              summary: options.summary,
              desc_rich: options.descriptionMarkdown,
              assign: options.assigneeUUID,
              priority: options.priority,
              sprint_uuid: options.sprintUUID,
              parent_uuid: options.parentIssueUUID,
              field_values: options.customFields
            }
          ]
        }
      }
    );
    const created = (Array.isArray(data.tasks) ? data.tasks[0] : data) as AnyObj;
    const issueUUID = String(created?.uuid ?? '');
    return {
      issueUUID,
      url: `${this.http.getBaseUrl()}/project/#/team/${options.teamUUID}/project/${options.projectUUID}/issue/${issueUUID}`
    };
  }

  async updateIssue(options: {
    teamUUID: string;
    issueUUID: string;
    summary?: string;
    descriptionMarkdown?: string;
    assigneeUUID?: string;
    priority?: string;
    sprintUUID?: string;
    customFields?: Record<string, unknown>;
  }): Promise<{ issueUUID: string }> {
    await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/tasks/update`,
      {
        method: 'POST',
        body: {
          tasks: [
            {
              uuid: options.issueUUID,
              ...(options.summary !== undefined ? { summary: options.summary } : {}),
              ...(options.descriptionMarkdown !== undefined
                ? { desc_rich: options.descriptionMarkdown }
                : {}),
              ...(options.assigneeUUID !== undefined ? { assign: options.assigneeUUID } : {}),
              ...(options.priority !== undefined ? { priority: options.priority } : {}),
              ...(options.sprintUUID !== undefined ? { sprint_uuid: options.sprintUUID } : {}),
              ...(options.customFields !== undefined ? { field_values: options.customFields } : {})
            }
          ]
        }
      }
    );
    return { issueUUID: options.issueUUID };
  }

  async transitionIssue(options: {
    teamUUID: string;
    issueUUID: string;
    targetStatus: string;
  }): Promise<{ issueUUID: string; transitionUUID: string; targetStatus: string }> {
    const transitions = await this.listTransitions(options.teamUUID, options.issueUUID);
    const needle = options.targetStatus.trim().toLowerCase();
    const matched = transitions.find(
      (t) =>
        t.uuid === options.targetStatus ||
        t.targetStatus.toLowerCase() === needle ||
        t.name.toLowerCase() === needle
    );

    if (!matched) {
      throw new OnesApiError(
        'VALIDATION_ERROR',
        `No valid workflow transition matches "${options.targetStatus}". Available: ${transitions.map((t) => `${t.targetStatus} (${t.uuid})`).join(', ') || 'none'}`
      );
    }

    await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/tasks/${options.issueUUID}/transitions`,
      {
        method: 'POST',
        body: { transition_uuid: matched.uuid }
      }
    );
    return {
      issueUUID: options.issueUUID,
      transitionUUID: matched.uuid,
      targetStatus: matched.targetStatus
    };
  }

  async listComments(options: {
    teamUUID: string;
    issueUUID: string;
    limit?: number;
    offset?: number;
  }): Promise<OnesComment[]> {
    const limit = Math.min(options.limit ?? 20, 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/task/${options.issueUUID}/messages`,
      { query: { limit, offset } }
    );
    const list = (Array.isArray(data.messages) ? data.messages : Array.isArray(data.comments) ? data.comments : []) as AnyObj[];
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
    issueUUID: string;
    content: string;
    replyToCommentUUID?: string;
  }): Promise<{ commentUUID: string }> {
    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/task/${options.issueUUID}/messages/add`,
      {
        method: 'POST',
        body: {
          text: options.content,
          ...(options.replyToCommentUUID ? { reply_uuid: options.replyToCommentUUID } : {})
        }
      }
    );
    return { commentUUID: String(data.uuid ?? data.id ?? '') };
  }

  async updateComment(options: {
    teamUUID: string;
    issueUUID: string;
    commentUUID: string;
    content: string;
  }): Promise<{ commentUUID: string }> {
    await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/task/${options.issueUUID}/message/${options.commentUUID}/update`,
      {
        method: 'POST',
        body: { text: options.content }
      }
    );
    return { commentUUID: options.commentUUID };
  }
}
