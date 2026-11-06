import { Hono } from 'hono';
import { z } from 'zod';
import {
  dashboardOverviewQuerySchema,
  dashboardAutomationsQuerySchema,
  type DashboardTaskRow,
  dashboardCostsQuerySchema,
  dashboardInsightsQuerySchema,
  dashboardFeedQuerySchema,
  dashboardTasksQuerySchema,
} from '@open-mercato/cezar-contract';
import { DashboardReader } from '../workspace/dashboard.ts';
import type { CostVisibility } from '../workspace/dashboard-costs.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';

/** Redact at response time, never in the immutable snapshot shared by other readers. */
function visibleTask(row: DashboardTaskRow, policy: CostVisibility): DashboardTaskRow {
  const { costUsd, ...rest } = row;
  return { ...rest, ...(policy.cost && costUsd !== undefined ? { costUsd } : {}) };
}

/** Keep the family chained: this return value is part of AppType and the typed client. */
export function dashboardRoutes(
  reader: DashboardReader,
  visibility: () => CostVisibility = () => ({ tokens: true, cost: true }),
  automationsEnabled: () => boolean = () => true,
  workspaceActionsEnabled: () => boolean = () => true,
) {
  return new Hono()
    .get(
      '/workspace/dashboard/automations',
      queryZodValidator(dashboardAutomationsQuerySchema),
      async (c) => {
        if (!automationsEnabled()) return c.json({ error: 'Automations are disabled' }, 409);
        try {
          const result = await reader.automations(c.req.valid('query').projectId);
          return result ? c.json(result) : c.json({ error: 'Project not found' }, 404);
        } catch {
          return c.json({ error: 'Could not read project automations' }, 503);
        }
      },
    )
    .get('/workspace/dashboard', async (c) => {
      const snapshot = await reader.snapshot();
      const policy = visibility();
      return c.json({
        ...snapshot,
        questions: {
          ...snapshot.questions,
          rows: snapshot.questions.rows.map((row) => visibleTask(row, policy)),
        },
        reviews: {
          ...snapshot.reviews,
          rows: snapshot.reviews.rows.map((row) => visibleTask(row, policy)),
        },
      });
    })
    .get('/workspace/dashboard/workspaces', async (c) => c.json(await reader.workspaceLifecycle()))
    .post(
      '/workspace/dashboard/workspaces/action',
      jsonZodValidator(z.object({
        projectId: z.string().min(1).max(200),
        issue: z.string().regex(/^#?\d+$/),
        action: z.enum(['recover', 'validate', 'prune', 'resume']),
        force: z.boolean().optional(),
        confirm: z.literal(true),
      })),
      async (c) => {
        if (!workspaceActionsEnabled()) return c.json({ error: 'Workspace lifecycle actions require the local checkout host.' }, 403);
        const request = c.req.valid('json');
        try {
          const result = await reader.workspaceLifecycleAction(request.projectId, request.issue, request.action, request.force ?? false);
          return c.json({ result, projects: await reader.workspaceLifecycle() });
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
        }
      },
    )
    .get(
      '/workspace/dashboard/overview',
      queryZodValidator(dashboardOverviewQuerySchema),
      async (c) => {
        const result = await reader.overview(c.req.valid('query'));
        return result
          ? c.json(result)
          : c.json(
              {
                error: 'Dashboard changed; refresh the list' as const,
                code: 'snapshot-expired' as const,
              },
              409,
            );
      },
    )
    .get(
      '/workspace/dashboard/tasks',
      queryZodValidator(dashboardTasksQuerySchema),
      async (c) => {
        const q = c.req.valid('query');
        const result = await reader.tasks(q.snapshotId, q.group, q.offset, q.limit);
        const policy = visibility();
        return result
          ? c.json({
              ...result,
              page: { ...result.page, rows: result.page.rows.map((row) => visibleTask(row, policy)) },
            })
          : c.json(
              {
                error: 'Dashboard changed; refresh the list' as const,
                code: 'snapshot-expired' as const,
              },
              409,
            );
      },
    )
    .get(
      '/workspace/dashboard/costs',
      queryZodValidator(dashboardCostsQuerySchema),
      async (c) => {
        const result = await reader.costs(c.req.valid('query'), visibility);
        return result
          ? c.json(result)
          : c.json(
              {
                error: 'Dashboard changed; refresh the list' as const,
                code: 'snapshot-expired' as const,
              },
              409,
            );
      },
    )
    .get(
      '/workspace/dashboard/insights',
      queryZodValidator(dashboardInsightsQuerySchema),
      async (c) => c.json(await reader.insights(c.req.valid('query'), visibility)),
    )
    .get('/workspace/dashboard/telemetry', async (c) => c.json(await reader.telemetry()))
    .get('/workspace/dashboard/feed', queryZodValidator(dashboardFeedQuerySchema), async (c) => {
      const feed = await reader.feed(c.req.valid('query').filter, c.req.raw.signal);
      const policy = visibility();
      return c.json({
        ...feed,
        rows: feed.rows.map((row) =>
          row.kind === 'task-result' ? { ...row, run: visibleTask(row.run, policy) } : row,
        ),
      });
    });
}
