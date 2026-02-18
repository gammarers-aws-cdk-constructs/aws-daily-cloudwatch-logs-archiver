import { awscdk, javascript, github } from 'projen';
const project = new awscdk.AwsCdkConstructLibrary({
  author: 'yicr',
  authorAddress: 'yicr@users.noreply.github.com',
  cdkVersion: '2.232.0',
  typescriptVersion: '5.9.x',
  jsiiVersion: '5.9.x',
  defaultReleaseBranch: 'main',
  name: 'aws-daily-cloudwatch-logs-archiver',
  projenrcTs: true,
  repositoryUrl: 'https://github.com/gammarers-aws-cdk-constructs/aws-daily-cloudwatch-logs-archiver.git',
  description: 'AWS CloudWatch Logs daily archive to s3 bucket',
  keywords: ['aws', 'cdk', 'aws-cdk', 'scheduler', 's3', 'bucket', 'archive', 'lambda'],
  majorVersion: 3,
  deps: [
    '@gammarers/aws-secure-log-bucket@^2.1.19',
  ],
  devDeps: [
    '@aws/durable-execution-sdk-js@^1',
    '@aws-sdk/client-cloudwatch-logs@^3',
    '@aws-sdk/client-resource-groups-tagging-api@^3',
    '@types/aws-lambda@^8',
    '@gammarers/jest-aws-cdk-asset-filename-renamer@~0.5.8',
    'aws-sdk-client-mock@^3',
    'aws-sdk-client-mock-jest@^3',
  ],
  jestOptions: {
    jestConfig: {
      snapshotSerializers: ['@gammarers/jest-aws-cdk-asset-filename-renamer'],
    },
    extraCliOptions: ['--silent'],
  },
  tsconfigDev: {
    compilerOptions: {
      strict: true,
    },
  },
  lambdaOptions: {
    // target node.js runtime
    runtime: awscdk.LambdaRuntime.NODEJS_22_X,
    bundlingOptions: {
      // list of node modules to exclude from the bundle
      externals: ['@aws-sdk/*'],
      sourcemap: true,
    },
  },
  releaseToNpm: true,
  npmTrustedPublishing: true,
  npmAccess: javascript.NpmAccess.PUBLIC,
  minNodeVersion: '20.0.0',
  workflowNodeVersion: '24.x',
  depsUpgradeOptions: {
    workflowOptions: {
      labels: ['auto-approve', 'auto-merge'],
      schedule: javascript.UpgradeDependenciesSchedule.NEVER,
    },
  },
  githubOptions: {
    projenCredentials: github.GithubCredentials.fromApp({
      permissions: {
        pullRequests: github.workflows.AppPermission.WRITE,
        contents: github.workflows.AppPermission.WRITE,
      },
    }),
  },
  autoApproveOptions: {
    allowedUsernames: [
      'gammarers-projen-upgrade-bot[bot]',
      'yicr',
    ],
  },
  // publishToPypi: {
  //   distName: 'gammarers.aws-daily-cloud-watch-logs-archive-stack',
  //   module: 'gammarers.aws_daily_cloud_watch_logs_archive_stack',
  // },
  // publishToNuget: {
  //   dotNetNamespace: 'Gammarers.CDK.AWS',
  //   packageId: 'Gammarers.CDK.AWS.DailyCloudWatchLogsArchiveStack',
  // },
});
project.synth();