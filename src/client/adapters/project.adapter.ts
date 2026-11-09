import type { OnesHttpClient } from '../http-client.js';
import type { OnesProject, OnesProjectMetadata } from './types.js';

type AnyObj = Record<string, unknown>;

export class ProjectAdapter {
  constructor(private readonly http: OnesHttpClient) {}

  async listProjects(options: {
    teamUUID: string;
    query?: string;
    limit?: number;
    offset?: number;
  }): Promise<OnesProject[]> {
    const limit = Math.min(options.limit ?? 20, 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/projects`,
      { query: { keyword: options.query, limit, offset } }
    );
    const list = (Array.isArray(data.projects) ? data.projects : Array.isArray(data.list) ? data.list : []) as AnyObj[];
    return list.map((p) => ({
      projectUUID: String(p.uuid ?? p.id ?? ''),
      name: String(p.name ?? ''),
      key: p.key ? String(p.key) : undefined,
      status: p.status ? String(p.status) : undefined
    }));
  }

  async getProjectMetadata(options: {
    teamUUID: string;
    projectUUID: string;
  }): Promise<OnesProjectMetadata> {
    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/project/${options.projectUUID}/stamp`
    );

    const mapSimple = (arr: unknown): Array<{ uuid: string; name: string }> =>
      (Array.isArray(arr) ? arr : []).map((x) => {
        const obj = x as AnyObj;
        return { uuid: String(obj.uuid ?? obj.id ?? ''), name: String(obj.name ?? '') };
      });

    const issueTypes = mapSimple(data.issue_types);
    const statuses = (Array.isArray(data.task_statuses) ? data.task_statuses : []).map((s) => {
      const obj = s as AnyObj;
      return {
        uuid: String(obj.uuid ?? ''),
        name: String(obj.name ?? ''),
        category: obj.category ? String(obj.category) : undefined
      };
    });
    const priorities = mapSimple(data.priorities);
    const sprints = (Array.isArray(data.sprints) ? data.sprints : []).map((s) => {
      const obj = s as AnyObj;
      return {
        uuid: String(obj.uuid ?? ''),
        name: String(obj.name ?? ''),
        status: obj.status ? String(obj.status) : undefined
      };
    });
    const members = (Array.isArray(data.members) ? data.members : []).map((m) => {
      const obj = m as AnyObj;
      return {
        uuid: String(obj.uuid ?? ''),
        name: String(obj.name ?? ''),
        email: obj.email ? String(obj.email) : undefined
      };
    });
    const customFields = (Array.isArray(data.fields) ? data.fields : []).map((f) => {
      const obj = f as AnyObj;
      return {
        uuid: String(obj.uuid ?? ''),
        name: String(obj.name ?? ''),
        type: obj.type ? String(obj.type) : undefined
      };
    });

    return {
      projectUUID: options.projectUUID,
      issueTypes,
      statuses,
      priorities,
      sprints,
      members,
      customFields
    };
  }
}
