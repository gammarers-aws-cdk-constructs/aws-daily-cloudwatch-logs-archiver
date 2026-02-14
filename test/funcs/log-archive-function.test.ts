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
import { Context } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import {
  EventInput,
  handler,
} from '../../src/funcs/log-archive.lambda';

/** API を呼ばないモック。ユニットテストで Durable Execution のハングを防ぐ */
const createMockDurableClient = (): DurableExecutionClient => ({
  getExecutionState: async () => ({ Operations: [] }),
  checkpoint: async () => ({
    CheckpointToken: 'mock-token',
    NewExecutionState: { Operations: [] },
  }),
});

/** Durable Execution が受け取る形式でテスト用の invocation input を組み立てる */
const createInvocationInput = (userEvent: EventInput): DurableExecutionInvocationInputWithClient => {
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

  beforeEach(() => {
    cwLogsMock.reset();
  });

  describe('Single log group input (TargetLogGroupName)', () => {
    // Durable Execution の checkpoint が Lambda API を呼ぶため、テストハーネスなしではハングする
    it.skip('Should call CreateExportTask and return ExportedCount', async () => {
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

      const payload: EventInput = {
        TargetLogGroupName: 'example/log-group',
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
    it('Should return FAILED with EnvironmentVariableError when BUCKET_NAME is not set', async () => {
      const payload: EventInput = {
        TargetLogGroupName: 'example/log-group',
      };

      process.env = {};

      const result = await handler(createInvocationInput(payload), {} as Context);

      expect(result).toMatchObject({ Status: 'FAILED' });
      expect((result as { Error?: { ErrorMessage?: string } }).Error?.ErrorMessage).toContain('BUCKET_NAME');
    });
  });

  describe('Input validation', () => {
    it('Should return FAILED with InputVariableError when TargetLogGroupName is missing', async () => {
      const payload: EventInput = {};

      process.env = {
        BUCKET_NAME: 'example-log-archive-bucket',
      };

      const result = await handler(createInvocationInput(payload), {} as Context);

      expect(result).toMatchObject({ Status: 'FAILED' });
      expect((result as { Error?: { ErrorMessage?: string } }).Error?.ErrorMessage).toContain('TargetLogGroupName');
    });
  });
});
