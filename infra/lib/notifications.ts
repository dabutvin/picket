import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { DynamoEventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
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
 * "Photos are syncing" / "Done: N new photos synced" pushes (ADR-010). Phones register their APNs
 * token through the API into the Notify table. The notifier runs on events only: new rows on the
 * Photos stream start or extend a burst, and a delay queue tells it when one has gone quiet.
 * The APNs auth key is a secret the deploy workflow fills from the APNS_KEY_P8 / APNS_KEY_ID
 * repository secrets; until then bursts are tracked and nothing is sent.
 */
export class Notifications extends Construct {
  readonly table: dynamodb.Table;
  readonly apnsKey: secretsmanager.Secret;
  readonly notifier: NodejsFunction;
  readonly quietQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: NotificationsProps) {
    super(scope, id);

    // pk = "devices" / sk = "device#<token>" for each phone; pk = sk = "burst" while photos are arriving.
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

    // Every batch of new photos queues a message delayed by the quiet time (DelaySeconds is set per
    // message by the notifier, from QUIET_MS); the one whose photo is still the newest closes the burst.
    this.quietQueue = new sqs.Queue(this, 'QuietQueue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(1),
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
        QUIET_QUEUE_URL: this.quietQueue.queueUrl,
      },
      logGroup: new logs.LogGroup(this, 'NotifierLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      description: 'Picket: push "syncing" on the first new photo and "done" once uploads go quiet',
    });
    props.table.grantReadData(this.notifier);
    this.table.grantReadWriteData(this.notifier);
    this.apnsKey.grantRead(this.notifier);

    this.quietQueue.grantSendMessages(this.notifier);

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
    this.notifier.addEventSource(new SqsEventSource(this.quietQueue, { batchSize: 10 }));
  }
}
