import {
  DurableExecutionClient,
  DurableExecutionInvocationInput,
  DurableExecutionInvocationInputWithClient,
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
import { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { handler } from '../../src/funcs/log-archive.lambda';

/**
 * Scheduler / durable input shape matching EventBridge Scheduler target payload
 * (see `daily-cloudwatch-logs-archiver` ScheduleTargetInput).
 */
type LogArchiveScheduleEvent = {
  Params: {
    TagKey: string;
    TagValues: string[];
  };
};

/** API を呼ばないモック。ユニットテストで Durable Execution のハングを防ぐ */
const createMockDurableClient = (): DurableExecutionClient => ({
  getExecutionState: async () => ({ Operations: [] }),
  checkpoint: async () => ({
    CheckpointToken: 'mock-token',
    NewExecutionState: { Operations: [] },
  }),
});

/** Durable Execution が受け取る形式でテスト用の invocation input を組み立てる */
const createInvocationInput = (userEvent: LogArchiveScheduleEvent): DurableExecutionInvocationInputWithClient => {
  const base: DurableExecutionInvocationInput = {
    DurableExecutionArn: 'arn:aws:durable-execution:test',
    CheckpointToken: 'test-token',
    InitialExecutionState: {
      Operations: [
        { ExecutionDetails: { InputPayload: JSON.stringify(userEvent) } },
      ] as DurableExecutionInvocationInput['InitialExecutionState']['Operations'],
    },
  };
  return new DurableExecutionInvocationInputWithClient(base, createMockDurableClient());
};

describe('Lambda Function Handler testing', () => {
  const cwLogsMock = mockClient(CloudWatchLogsClient);
  const taggingMock = mockClient(ResourceGroupsTaggingAPIClient);

  beforeEach(() => {
    cwLogsMock.reset();
    taggingMock.reset();
  });

  describe('Tag-based schedule input (Params.TagKey / Params.TagValues)', () => {
    // Durable Execution の checkpoint が Lambda API を呼ぶため、テストハーネスなしではハングする
    it.skip('should resolve log groups by tag, call CreateExportTask, and return ExportedCount', async () => {
      taggingMock.on(GetResourcesCommand).resolves({
        $metadata: { httpStatusCode: 200 },
        ResourceTagMappingList: [
          {
            ResourceARN: 'arn:aws:logs:us-east-1:123456789012:log-group:example/log-group',
          },
        ],
      });

      cwLogsMock
        .on(CreateExportTaskCommand)
        .resolves({
          $metadata: { httpStatusCode: 200 },
          taskId: 'cda45419-90ea-4db5-9833-aade86253e66',
        })
        .on(DescribeExportTasksCommand)
        .resolves({
          $metadata: { httpStatusCode: 200 },
          exportTasks: [{ status: { code: 'COMPLETED' } }],
        });

      const payload: LogArchiveScheduleEvent = {
        Params: {
          TagKey: 'DailyLogExport',
          TagValues: ['Yes'],
        },
      };

      process.env = {
        BUCKET_NAME: 'example-log-archive-bucket',
      };

      const result = await handler(createInvocationInput(payload), {} as Context);

      expect(result).toMatchObject({ Status: 'SUCCEEDED' });
      expect(JSON.parse((result as { Result?: string }).Result ?? '{}')).toStrictEqual({ ExportedCount: 1 });
    });
  });

  describe('Environment variable validation', () => {
    it('should return FAILED when BUCKET_NAME is not set', async () => {
      const payload: LogArchiveScheduleEvent = {
        Params: {
          TagKey: 'DailyLogExport',
          TagValues: ['Yes'],
        },
      };

      process.env = {};

      const result = await handler(createInvocationInput(payload), {} as Context);

      expect(result).toMatchObject({ Status: 'FAILED' });
      expect((result as { Error?: { ErrorMessage?: string } }).Error?.ErrorMessage).toContain('BUCKET_NAME');
    });
  });

  describe('Input validation', () => {
    it('should return FAILED when Params.TagKey or Params.TagValues is missing', async () => {
      const payload = {} as LogArchiveScheduleEvent;

      process.env = {
        BUCKET_NAME: 'example-log-archive-bucket',
      };

      const result = await handler(createInvocationInput(payload), {} as Context);

      expect(result).toMatchObject({ Status: 'FAILED' });
      expect((result as { Error?: { ErrorMessage?: string } }).Error?.ErrorMessage).toContain('Params.TagKey');
    });
  });
});
