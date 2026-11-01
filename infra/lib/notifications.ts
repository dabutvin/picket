import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface NotificationsProps {
  bucket: s3.IBucket;
  table: dynamodb.ITable;
  /** The iOS bundle id: the APNs topic every push is addressed to. */
  bundleId: string;
}

const API_DIR = path.join(__dirname, '..', '..', 'services', 'api');

/**
 * "N new photos to review" pushes (ADR-010). Phones register their APNs token through the API
 * into the Notify table; a scheduled Lambda announces each burst of uploads once it goes quiet.
 * The APNs auth key is a secret the deploy workflow fills from the APNS_KEY_P8 / APNS_KEY_ID
 * repository secrets; until then the notifier runs and sends nothing.
 */
export class Notifications extends Construct {
  readonly table: dynamodb.Table;
  readonly apnsKey: secretsmanager.Secret;
  readonly notifier: NodejsFunction;

  constructor(scope: Construct, id: string, props: NotificationsProps) {
    super(scope, id);

    // pk = "devices" / sk = "device#<token>" for each phone; pk = sk = "state" for the watermark.
    this.table = new dynamodb.Table(this, 'NotifyTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // phones re-register on every launch
    });

    this.apnsKey = new secretsmanager.Secret(this, 'ApnsKey', {
      description: 'Picket: APNs auth key {keyId, teamId, p8} for new-photo notifications (written by the deploy workflow)',
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
    });

    this.notifier = new NodejsFunction(this, 'Notifier', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      depsLockFilePath: path.join(API_DIR, 'package-lock.json'),
      projectRoot: API_DIR,
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: 'node22' },
      entry: path.join(API_DIR, 'src', 'notifier.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        PHOTOS_TABLE: props.table.tableName,
        PHOTOS_BUCKET: props.bucket.bucketName,
        STATUS_INDEX: 'byStatus',
        NOTIFY_TABLE: this.table.tableName,
        APNS_SECRET_ARN: this.apnsKey.secretArn,
        APNS_TOPIC: props.bundleId,
      },
      logGroup: new logs.LogGroup(this, 'NotifierLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      description: 'Picket: push "new photos to review" once an upload burst goes quiet',
    });
    props.table.grantReadData(this.notifier);
    this.table.grantReadWriteData(this.notifier);
    this.apnsKey.grantRead(this.notifier);

    // A burst counts as over after 3 quiet minutes, so a 5-minute tick means 3–8 minutes after the last photo.
    new events.Rule(this, 'Every5Minutes', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(this.notifier, { retryAttempts: 0 })],
      description: 'Picket: check for newly synced photos to announce',
    });
  }
}
