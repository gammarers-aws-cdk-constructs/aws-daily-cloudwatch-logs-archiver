import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DailyCloudWatchLogsArchiveStack } from '../src';

describe('DailyCloudWatchLogsArchiveStack Testing', () => {
  const app = new App();

  const stack = new DailyCloudWatchLogsArchiveStack(app, 'DailyCloudWatchLogsArchiveStack', {
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
    targetResourceTag: {
      key: 'DailyLogExport',
      values: ['Yes'],
    },
  });

  const template = Template.fromStack(stack);

  describe('Bucket Testing', () => {

    it('should have bucket encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: Match.objectEquals({
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        }),
      });
    });

    it('should have bucket resource policy', () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: Match.arrayWith([
            Match.objectEquals({
              Effect: 'Allow',
              Action: 's3:GetBucketAcl',
              Principal: {
                Service: 'logs.us-east-1.amazonaws.com',
              },
              Resource: {
                'Fn::GetAtt': [
                  Match.stringLikeRegexp('LogArchiveBucket.*'),
                  'Arn',
                ],
              },
            }),
            Match.objectEquals({
              Effect: 'Allow',
              Action: 's3:PutObject',
              Principal: {
                Service: 'logs.us-east-1.amazonaws.com',
              },
              Resource: {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        Match.stringLikeRegexp('LogArchiveBucket.*'),
                        'Arn',
                      ],
                    },
                    '/*',
                  ],
                ],
              },
              Condition: {
                StringEquals: {
                  's3:x-amz-acl': 'bucket-owner-full-control',
                },
              },
            }),
          ]),
        },
      });
    });

  });

  describe('Lambda Testing', () => {

    it('should have lambda execution role with basic and durable execution policies', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        Description: 'daily CloudWatch Logs archive lambda exec role.',
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: 'sts:AssumeRole',
            }),
          ]),
        },
      });
    });

    it('should have lambda role policy for log archive bucket access', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'LogArchiveBucketAccess',
              Effect: 'Allow',
              Action: ['s3:GetBucketAcl', 's3:PutObject'],
              Resource: Match.anyValue(),
            }),
          ]),
        },
        Roles: Match.arrayWith([
          { Ref: Match.stringLikeRegexp('LambdaExecutionRole.*') },
        ]),
      });
    });

    it('should have lambda function with durable config and archive settings', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        Description: 'A function to archive logs s3 bucket from CloudWatch Logs.',
        Timeout: 900,
        MemorySize: 512,
        Code: {
          S3Bucket: Match.anyValue(),
          S3Key: Match.stringLikeRegexp('.*.zip'),
        },
        Environment: {
          Variables: {
            AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
            BUCKET_NAME: { Ref: Match.stringLikeRegexp('LogArchiveBucket.*') },
          },
        },
        Role: {
          'Fn::GetAtt': [Match.stringLikeRegexp('LambdaExecutionRole.*'), 'Arn'],
        },
        DurableConfig: {
          ExecutionTimeout: 7200,
          RetentionPeriodInDays: 1,
        },
      });
    });

    it('should have lambda alias for scheduler target', () => {
      template.hasResourceProperties('AWS::Lambda::Alias', {
        Name: 'live',
        FunctionVersion: Match.anyValue(),
      });
    });
  });

  describe('Schedule Testing', () => {

    it('should have scheduler role for lambda target', () => {
      template.hasResourceProperties('AWS::IAM::Role', Match.objectLike({
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Principal: { Service: 'scheduler.amazonaws.com' },
              Action: 'sts:AssumeRole',
            }),
          ]),
        },
      }));
    });

    it('should have scheduler policy to invoke lambda alias', () => {
      template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 'lambda:InvokeFunction',
              Resource: { Ref: Match.stringLikeRegexp('LogArchiveFunctionAlias.*') },
            }),
          ]),
        },
      }));
    });

    it('should have schedule that invokes lambda alias with tag key and values', () => {
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        Description: 'daily CloudWatch Logs archive schedule',
        State: 'ENABLED',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ScheduleExpressionTimezone: 'Etc/UTC',
        ScheduleExpression: 'cron(1 13 * * ? *)',
        Target: Match.objectLike({
          Arn: { Ref: Match.stringLikeRegexp('LogArchiveFunctionAlias.*') },
          Input: '{"tagKey":"DailyLogExport","tagValues":["Yes"]}',
          RoleArn: Match.anyValue(),
          RetryPolicy: Match.anyValue(),
        }),
      });
      template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    });
  });

  describe('Snapshot Testing', () => {
    it('should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot('archiver');
    });
  });
});
