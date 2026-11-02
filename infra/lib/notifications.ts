import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface NotificationsProps {
  bucket: s3.IBucket;
  /** The Photos table; its stream (INSERT only) is what says a photo synced. */
  table: dynamodb.Table;
  /** The iOS bundle id: the APNs topic every push is addressed to. */
  bundleId: string;
}

const API_DIR = path.join(__dirname, '..', '..', 'services', 'api');

/**
 * "New photos are syncing" pushes (ADR-010): one per phone when photos start arriving, then none
 * until the app has been opened. Phones register (and report opening the app) through the API
 * into the Notify table; the notifier runs on new rows of the Photos stream. The APNs auth key is
 * a secret the deploy workflow fills from the APNS_KEY_P8 / APNS_KEY_ID repository secrets; until
 * then nothing is sent.
 */
export class Notifications extends Construct {
  readonly table: dynamodb.Table;
  readonly apnsKey: secretsmanager.Secret;
  readonly notifier: NodejsFunction;

  constructor(scope: Construct, id: string, props: NotificationsProps) {
    super(scope, id);

    // pk = "devices" / sk = "device#<token>": one row per phone with openedAt / notifiedAt.
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
      description: 'Picket: push "new photos are syncing" to phones without an unread one',
    });
    props.table.grantReadData(this.notifier);
    this.table.grantReadWriteData(this.notifier);
    this.apnsKey.grantRead(this.notifier);

    // New photos only: the preview Lambda's upsert is an INSERT for a new frame, a MODIFY for a re-send.
    this.notifier.addEventSource(
      new DynamoEventSource(props.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 50,
        maxBatchingWindow: cdk.Duration.seconds(2),
        retryAttempts: 3,
        filters: [lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') })],
      }),
    );
  }
}
