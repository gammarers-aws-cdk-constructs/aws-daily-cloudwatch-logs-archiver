import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DailyCloudWatchLogsArchiver, type TargetResource } from '../constructs/daily-cloudwatch-logs-archiver';

/**
 * Props for the DailyCloudWatchLogsArchiveStack.
 * Extends StackProps with the tag filter for target log groups.
 */
export interface DailyCloudWatchLogsArchiveStackProps extends StackProps {
  /** Tag key and values used to select CloudWatch Log groups for daily archiving. */
  readonly targetResource: TargetResource;
}

/**
 * CDK Stack that deploys the daily CloudWatch Logs archive solution.
 * Contains a single DailyCloudWatchLogsArchive construct configured with the given tag filter.
 */
export class DailyCloudWatchLogsArchiveStack extends Stack {
  /**
   * Creates the stack and the daily archive construct.
   *
   * @param scope - Parent construct (e.g. App).
   * @param id - Stack ID.
   * @param props - Stack props including targetResource for log group selection.
   */
  constructor(scope: Construct, id: string, props: DailyCloudWatchLogsArchiveStackProps) {
    super(scope, id, props);

    new DailyCloudWatchLogsArchiver(this, 'DailyCloudWatchLogsArchiver', {
      targetResource: props.targetResource,
    });
  }
}
