import {
  type DurableContext,
  withDurableExecution,
} from '@aws/durable-execution-sdk-js';
import {
  CloudWatchLogsClient,
  CreateExportTaskCommand,
  DescribeExportTasksCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
} from '@aws-sdk/client-resource-groups-tagging-api';

/**
 * Error thrown when a required environment variable is not set.
 */
export class EnvironmentVariableError extends Error {
  /**
   * @param message - Error message describing the missing variable.
   */
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentVariableError';
  }
}

/**
 * Error thrown when the event input is invalid or missing required fields.
 */
export class InputVariableError extends Error {
  /**
   * @param message - Error message describing the input validation failure.
   */
  constructor(message: string) {
    super(message);
    this.name = 'InputVariableError';
  }
}

/**
 * Input from EventBridge Scheduler: specifies target log groups by tag key and values.
 */
export interface SchedulerEventInput {
  /** Tag key used to filter CloudWatch Log groups (e.g. "Environment"). */
  readonly tagKey: string;
  /** Tag values to match; log groups with any of these values are archived. */
  readonly tagValues: string[];
}

/**
 * Legacy single log group input (backward compatibility).
 */
export interface SingleLogGroupEventInput {
  /** Name of the single log group to export. */
  readonly TargetLogGroupName?: string;
}

/**
 * Union of supported event input types: tag-based (scheduler) or single log group name.
 */
export type EventInput = SchedulerEventInput | SingleLogGroupEventInput;

/**
 * Type guard: returns true if the event is scheduler-style input (tagKey + tagValues).
 * @param event - The event payload to check.
 * @returns True if event has tagKey and tagValues.
 */
const isSchedulerInput = (event: EventInput): event is SchedulerEventInput =>
  'tagKey' in event && 'tagValues' in event && Array.isArray((event as SchedulerEventInput).tagValues);

/**
 * Extracts the log group name from a CloudWatch Logs resource ARN.
 * Uses the same convention as Step Functions: split by ':', take index 6.
 * @param arn - The resource ARN (e.g. arn:aws:logs:region:account:log-group:name).
 * @returns The log group name, or the original arn if parsing fails.
 */
const getLogGroupNameFromArn = (arn: string): string => {
  const parts = arn.split(':');
  return parts[6] ?? arn;
};

/** Seconds to wait between polls when export task status is RUNNING. */
const RUNNING_WAIT_SECONDS = 10;

/** Seconds to wait when status is PENDING or before retrying. */
const PENDING_WAIT_SECONDS = 3;

/**
 * Creates a CloudWatch Logs export task for the given log group and polls until it completes.
 * Exports the previous calendar day's logs to the specified S3 bucket. Retries once on FAILED.
 *
 * @param ctx - Durable execution context for steps and waits.
 * @param stepName - Base name for step IDs (e.g. "export-0").
 * @param cwLogs - CloudWatch Logs client.
 * @param bucketName - S3 bucket destination for the export.
 * @param logGroupName - Name of the log group to export.
 * @param retried - Whether this invocation is already a retry (used to avoid infinite retry loop).
 * @returns Resolves when the export task completes (COMPLETED, CANCELLED, or PENDING_CANCEL).
 * @throws Error if CreateExportTask does not return a taskId or if the task fails after retry.
 */
const createExportLogGroup = async (
  ctx: DurableContext,
  stepName: string,
  cwLogs: CloudWatchLogsClient,
  bucketName: string,
  logGroupName: string,
  retried = false,
): Promise<void> => {
  const safeLogGroupName = logGroupName.replace(/\//g, '-').replace(/^-/, '').replace(/\./g, '--');
  const now = new Date();
  const targetFromTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime() - (1000 * 60 * 60 * 24);
  const targetToTime = targetFromTime + (1000 * 60 * 60 * 24) + 999;
  const targetDate = new Date(targetFromTime);
  const y = targetDate.getFullYear();
  const m = ('00' + (targetDate.getMonth() + 1)).slice(-2);
  const d = ('00' + (targetDate.getDate())).slice(-2);

  const createResult = await ctx.step(`${stepName}-create`, async () => {
    return cwLogs.send(new CreateExportTaskCommand({
      destination: bucketName,
      logGroupName,
      from: targetFromTime,
      to: targetToTime,
      destinationPrefix: `${safeLogGroupName}/${y}/${m}/${d}/`,
    }));
  });

  const taskId = createResult.taskId;
  if (!taskId) {
    throw new Error(`CreateExportTask did not return taskId for log group: ${logGroupName}`);
  }

  for (;;) {
    const { status } = await ctx.step(`${stepName}-describe`, async () => {
      const describe = await cwLogs.send(new DescribeExportTasksCommand({ taskId }));
      return { status: describe.exportTasks?.[0]?.status?.code ?? 'PENDING' };
    });

    if (status === 'COMPLETED' || status === 'CANCELLED' || status === 'PENDING_CANCEL') {
      return;
    }
    if (status === 'FAILED') {
      if (!retried) {
        await ctx.wait(`${stepName}-retry-wait`, { seconds: PENDING_WAIT_SECONDS });
        return createExportLogGroup(ctx, `${stepName}-retry`, cwLogs, bucketName, logGroupName, true);
      }
      throw new Error(`Export task ${taskId} failed for log group: ${logGroupName}`);
    }
    if (status === 'RUNNING') {
      await ctx.wait(`${stepName}-running-wait`, { seconds: RUNNING_WAIT_SECONDS });
      continue;
    }
    // PENDING or unknown
    await ctx.wait(`${stepName}-pending-wait`, { seconds: PENDING_WAIT_SECONDS });
  }
};

/**
 * Durable Lambda handler for archiving CloudWatch Logs to S3.
 * Accepts either scheduler input (tagKey + tagValues) to discover log groups by tag,
 * or legacy input (TargetLogGroupName) for a single log group.
 *
 * @param event - SchedulerEventInput (tag-based) or SingleLogGroupEventInput (single group).
 * @param context - Durable execution context (steps, map, logger).
 * @returns Object with ExportedCount: number of log groups successfully exported.
 * @throws EnvironmentVariableError if BUCKET_NAME is not set.
 * @throws InputVariableError if event is invalid or missing required fields.
 */
export const handler = withDurableExecution(async (event: EventInput, context: DurableContext): Promise<{ ExportedCount: number }> => {
  context.logger.info('Log archiver started', { hasTagKey: 'tagKey' in event });

  if (!process.env.BUCKET_NAME) {
    throw new EnvironmentVariableError('BUCKET_NAME environment variable not set.');
  }
  const bucketName = process.env.BUCKET_NAME;

  const cwLogs = new CloudWatchLogsClient({});
  let logGroupNames: string[];

  if (isSchedulerInput(event)) {
    if (!event.tagKey || event.tagValues.length === 0) {
      throw new InputVariableError('event must have tagKey and non-empty tagValues when using scheduler input.');
    }
    logGroupNames = await context.step('get-resources', async () => {
      const taggingClient = new ResourceGroupsTaggingAPIClient({});
      const arns: string[] = [];
      let paginationToken: string | undefined;
      do {
        const result = await taggingClient.send(new GetResourcesCommand({
          ResourceTypeFilters: ['logs:log-group'],
          TagFilters: [{ Key: event.tagKey, Values: event.tagValues }],
          PaginationToken: paginationToken,
        }));
        const list = result.ResourceTagMappingList ?? [];
        for (const m of list) {
          if (m.ResourceARN) arns.push(m.ResourceARN);
        }
        paginationToken = result.PaginationToken ?? undefined;
      } while (paginationToken);
      return arns.map(getLogGroupNameFromArn);
    });
    context.logger.info('Resolved log groups', { count: logGroupNames.length, tagKey: event.tagKey });
  } else {
    if (!event.TargetLogGroupName) {
      throw new InputVariableError('event input TargetLogGroupName (or tagKey/tagValues) not set.');
    }
    logGroupNames = [event.TargetLogGroupName];
  }

  const mapResult = await context.map(
    'export-log-groups',
    logGroupNames,
    async (ctx, logGroupName, index) => {
      await createExportLogGroup(
        ctx,
        `export-${index}`,
        cwLogs,
        bucketName,
        logGroupName,
      );
      return { logGroupName };
    },
    { maxConcurrency: 1 },
  );

  context.logger.info('Log archiver completed', { exportedCount: mapResult.successCount });
  return { ExportedCount: mapResult.successCount };
});
