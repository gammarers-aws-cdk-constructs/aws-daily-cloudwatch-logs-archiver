import { SecureLogBucket } from '@gammarers/aws-secure-log-bucket';
import { Duration, RemovalPolicy, Stack, TimeZone } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import { Construct } from 'constructs';
import { LogArchiveFunction } from '../funcs/log-archive-function';

/**
 * Tag filter used to select CloudWatch Log groups for archiving.
 * Log groups matching the given tag key and any of the values will be archived.
 */
export interface TargetResourceTagProperty {
  /** Tag key to filter log groups (e.g. "Environment", "Project"). */
  readonly key: string;
  /** Tag values to match (log groups with any of these values are included). */
  readonly values: string[];
}

/**
 * Props for creating a DailyCloudWatchLogsArchive construct.
 */
export interface DailyCloudWatchLogsArchiverProps {
  /** Tag filter to identify which log groups to archive daily. */
  readonly targetResourceTag: TargetResourceTagProperty;
}

/**
 * CDK construct that sets up daily archiving of CloudWatch Logs to S3.
 * Creates an S3 bucket, a durable Lambda function, and an EventBridge Scheduler
 * that invokes the function daily to export tagged log groups to the bucket.
 */
export class DailyCloudWatchLogsArchiver extends Construct {
  /**
   * Creates a daily CloudWatch Logs archive solution.
   *
   * @param scope - Parent construct (e.g. Stack).
   * @param id - Construct ID.
   * @param props - Configuration for target log groups (tag key/values) and optional overrides.
   */
  constructor(scope: Construct, id: string, props: DailyCloudWatchLogsArchiverProps) {
    super(scope, id);

    // 👇 Get current region
    const region = Stack.of(this).region;

    // 👇 Create Backup S3 Bucket
    const logArchiveBucket = new SecureLogBucket(this, 'LogArchiveBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    logArchiveBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.ServicePrincipal(`logs.${region}.amazonaws.com`),
      ],
      actions: [
        's3:GetBucketAcl',
      ],
      resources: [
        logArchiveBucket.bucketArn,
      ],
    }));
    logArchiveBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.ServicePrincipal(`logs.${region}.amazonaws.com`),
      ],
      actions: [
        's3:PutObject',
      ],
      resources: [
        `${logArchiveBucket.bucketArn}/*`,
      ],
      conditions: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
        },
      },
    }));

    // 👇 Create Lambda Function
    const logArchiveFunction = new LogArchiveFunction(this, 'LogArchiveFunction', {
      description: 'A function to archive logs s3 bucket from CloudWatch Logs.',
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(15),
      memorySize: 512,
      retryAttempts: 2,
      durableConfig: {
        executionTimeout: Duration.hours(2),
        retentionPeriod: Duration.days(1),
      },
      environment: {
        BUCKET_NAME: logArchiveBucket.bucketName,
      },
      role: new iam.Role(this, 'LambdaExecutionRole', {
        description: 'daily CloudWatch Logs archive lambda exec role.',
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
        ],
      }),
      logGroup: new logs.LogGroup(this, 'LambdaFunctionLogGroup', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.INFO,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
    });
    logArchiveFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'LogArchiveBucketAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetBucketAcl',
        's3:PutObject',
      ],
      resources: [
        logArchiveBucket.bucketArn,
        logArchiveBucket.bucketArn + '/*',
      ],
    }));
    logArchiveFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ResourceGroupsTaggingGetResources',
      effect: iam.Effect.ALLOW,
      actions: ['tag:GetResources'],
      resources: ['*'],
    }));
    logArchiveFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsExport',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateExportTask',
        'logs:DescribeExportTasks',
      ],
      resources: ['*'],
    }));

    // https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started-iac.html
    const logArchiveFunctionAlias = new lambda.Alias(this, 'LogArchiveFunctionAlias', {
      aliasName: 'live',
      version: logArchiveFunction.currentVersion,
    });

    // Schedule (Durable Functions: Lambda performs tag lookup, export, and polling in one run)
    new scheduler.Schedule(this, 'LogArchiveSchedule', {
      description: 'daily CloudWatch Logs archive schedule',
      enabled: true,
      schedule: scheduler.ScheduleExpression.cron({
        minute: '1',
        hour: '13',
        timeZone: TimeZone.ETC_UTC,
      }),
      target: new targets.LambdaInvoke(logArchiveFunctionAlias, {
        input: scheduler.ScheduleTargetInput.fromObject({
          tagKey: props.targetResourceTag.key,
          tagValues: props.targetResourceTag.values,
        }),
      }),
    });
  }
}