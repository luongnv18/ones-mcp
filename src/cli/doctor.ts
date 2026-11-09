import { redactSecrets } from '../client/logger.js';
import type { ToolContext } from '../tools/helpers.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(ctx: ToolContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const session = ctx.refreshManager.getCurrentSession();

  if (!session) {
    return [
      {
        name: 'auth.session',
        ok: false,
        detail: 'Not logged in. Run `ones-mcp login` first.'
      }
    ];
  }

  const teamUUID = session.teamUUID ?? ctx.config.defaultTeamUUID;
  checks.push({
    name: 'auth.session',
    ok: Boolean(teamUUID),
    detail: teamUUID
      ? `Token loaded for ${session.baseUrl} (teamUUID=${teamUUID})`
      : 'Token loaded but teamUUID missing (set ONES_TEAM_UUID or navigate into a team during login).'
  });

  if (!teamUUID) return checks;

  let firstSpaceUUID: string | undefined;
  try {
    const spaces = await ctx.wiki.listSpaces({ teamUUID, limit: 5, offset: 0 });
    firstSpaceUUID = spaces[0]?.spaceUUID;
    checks.push({
      name: 'wiki.listSpaces',
      ok: true,
      detail: `Found ${spaces.length} Wiki space(s)`
    });
  } catch (err) {
    checks.push({
      name: 'wiki.listSpaces',
      ok: false,
      detail: redactSecrets(err instanceof Error ? err.message : String(err))
    });
  }

  if (firstSpaceUUID) {
    try {
      const tree = await ctx.wiki.getPageTree({ teamUUID, spaceUUID: firstSpaceUUID, maxDepth: 1 });
      checks.push({
        name: 'wiki.getPageTree',
        ok: true,
        detail: `Fetched ${tree.length} top-level page(s) in space ${firstSpaceUUID}`
      });
    } catch (err) {
      checks.push({
        name: 'wiki.getPageTree',
        ok: false,
        detail: redactSecrets(err instanceof Error ? err.message : String(err))
      });
    }
  }

  try {
    const projects = await ctx.project.listProjects({ teamUUID, limit: 5, offset: 0 });
    checks.push({
      name: 'project.listProjects',
      ok: true,
      detail: `Found ${projects.length} project(s)`
    });
  } catch (err) {
    checks.push({
      name: 'project.listProjects',
      ok: false,
      detail: redactSecrets(err instanceof Error ? err.message : String(err))
    });
  }

  try {
    const issues = await ctx.issue.searchIssues({ teamUUID, limit: 3, offset: 0 });
    checks.push({
      name: 'issue.searchIssues',
      ok: true,
      detail: `Query succeeded (${issues.length} sample issue(s))`
    });
  } catch (err) {
    checks.push({
      name: 'issue.searchIssues',
      ok: false,
      detail: redactSecrets(err instanceof Error ? err.message : String(err))
    });
  }

  return checks;
}
