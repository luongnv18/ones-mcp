import { OnesApiError } from '../errors.js';
import type { OnesHttpClient } from '../http-client.js';
import type { OnesWorklog } from './types.js';

type AnyObj = Record<string, unknown>;

export class WorklogAdapter {
  constructor(private readonly http: OnesHttpClient) {}

  async listWorklogs(options: { teamUUID: string; issueUUID: string }): Promise<OnesWorklog[]> {
    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/task/${options.issueUUID}/manhours`
    );
    const list = (Array.isArray(data.manhours) ? data.manhours : Array.isArray(data.worklogs) ? data.worklogs : []) as AnyObj[];
    return list.map((w) => ({
      worklogUUID: String(w.uuid ?? ''),
      hours: typeof w.hours === 'number' ? w.hours / 3600 : 0,
      startTime: typeof w.start_time === 'number' ? w.start_time : undefined,
      description: w.description ? String(w.description) : undefined,
      ownerName: (w.owner as AnyObj | undefined)?.name ? String((w.owner as AnyObj).name) : undefined
    }));
  }

  async addWorklog(options: {
    teamUUID: string;
    issueUUID: string;
    hours: number;
    startDate?: string;
    description?: string;
  }): Promise<{ worklogUUID: string }> {
    const seconds = Math.round(options.hours * 3600);
    let startTime = Math.floor(Date.now() / 1000);

    // Controller Ruling 3: Validate startDate to prevent NaN timestamps
    if (options.startDate) {
      const ms = new Date(options.startDate).getTime();
      if (Number.isNaN(ms)) {
        throw new OnesApiError(
          'VALIDATION_ERROR',
          `Invalid startDate: "${options.startDate}". Expected a valid ISO date string.`
        );
      }
      startTime = Math.floor(ms / 1000);
    }

    const data = await this.http.requestJson<AnyObj>(
      `/project/api/project/team/${options.teamUUID}/task/${options.issueUUID}/manhours/add`,
      {
        method: 'POST',
        body: {
          hours: seconds,
          start_time: startTime,
          description: options.description ?? ''
        }
      }
    );
    return { worklogUUID: String(data.uuid ?? '') };
  }
}
