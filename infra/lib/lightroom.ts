import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DynamoEventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface LightroomSettings {
  /** Adobe Developer Console "OAuth Native App" client id with Lightroom Services. Public, not a secret. */
  clientId: string;
  /** IMS scopes the app requests. */
  scopes: string[];
  /** Adobe fixes this for Native App credentials: adobe+<hash>://adobeid/<clientId>. */
  redirectUri: string;
  /** Name of the project album picks land in. */
  albumName: string;
  /** Override the Content-Type for master uploads if Lightroom answers 415. */
  rawContentType?: string;
}

export interface LightroomProps {
  bucket: s3.IBucket;
  table: dynamodb.Table;
  settings: LightroomSettings;
}

const API_DIR = path.join(__dirname, '..', '..', 'services', 'api');

/**
 * Picks → Lightroom cloud. The Photos table stream feeds a tiny router that
 * enqueues newly queued picks; the uploader drains the queue one file at a time,
 * pulling the RAW from S3 and PUTting it into the user's catalog. The user's
 * OAuth tokens live in one Secrets Manager secret written by the API.
 */
export class Lightroom extends Construct {
  readonly connection: secretsmanager.Secret;
  readonly queue: sqs.Queue;
  readonly deadLetter: sqs.Queue;
  readonly uploader: NodejsFunction;
  readonly router: NodejsFunction;

  constructor(scope: Construct, id: string, props: LightroomProps) {
    super(scope, id);

    this.connection = new secretsmanager.Secret(this, 'Connection', {
      description: 'Picket: Lightroom OAuth tokens + catalog/album ids (written by the API on connect)',
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
    });

    this.deadLetter = new sqs.Queue(this, 'UploadDlq', { retentionPeriod: cdk.Duration.days(14) });
    this.queue = new sqs.Queue(this, 'UploadQueue', {
      visibilityTimeout: cdk.Duration.minutes(16), // > 6 × uploader timeout, per AWS guidance
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: this.deadLetter, maxReceiveCount: 6 },
    });

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      depsLockFilePath: path.join(API_DIR, 'package-lock.json'),
      projectRoot: API_DIR,
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: 'node22' },
    };

    this.router = new NodejsFunction(this, 'Router', {
      ...common,
      entry: path.join(API_DIR, 'src', 'router.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: { UPLOAD_QUEUE_URL: this.queue.queueUrl },
      logGroup: logGroup('Router'),
      description: 'Picket: Photos stream -> upload queue',
    });
    this.queue.grantSendMessages(this.router);
    this.router.addEventSource(
      new DynamoEventSource(props.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        bisectBatchOnError: true,
        retryAttempts: 3,
        // Only rows that are (or just became) queued; everything else never invokes the function.
        filters: [lambda.FilterCriteria.filter({ dynamodb: { NewImage: { lightroomStatus: { S: ['queued'] } } } })],
      }),
    );

    this.uploader = new NodejsFunction(this, 'Uploader', {
      ...common,
      entry: path.join(API_DIR, 'src', 'uploader.ts'),
      handler: 'handler',
      memorySize: 1024, // a 70 MB ARW is held in memory for the SHA-256 and the PUT
      ephemeralStorageSize: cdk.Size.mebibytes(512),
      timeout: cdk.Duration.minutes(2),
      // Serial uploads: kind to Adobe's 429s and keeps one user's uploads in order.
      reservedConcurrentExecutions: 1,
      environment: {
        PHOTOS_TABLE: props.table.tableName,
        PHOTOS_BUCKET: props.bucket.bucketName,
        LIGHTROOM_SECRET_ARN: this.connection.secretArn,
        LIGHTROOM_CLIENT_ID: props.settings.clientId,
        LIGHTROOM_SCOPES: props.settings.scopes.join(','),
        LIGHTROOM_ALBUM_NAME: props.settings.albumName,
        ...(props.settings.rawContentType ? { LIGHTROOM_RAW_CONTENT_TYPE: props.settings.rawContentType } : {}),
      },
      logGroup: logGroup('Uploader'),
      description: 'Picket: S3 RAW -> Lightroom catalog',
    });
    props.table.grantReadWriteData(this.uploader);
    props.bucket.grantRead(this.uploader, 'raw/*');
    this.connection.grantRead(this.uploader);
    this.connection.grantWrite(this.uploader); // rotated refresh tokens, album id
    this.uploader.addEventSource(
      new SqsEventSource(this.queue, { batchSize: 1, reportBatchItemFailures: true }),
    );

    new cdk.CfnOutput(this, 'UploadDlqUrl', { value: this.deadLetter.queueUrl, description: 'Picks that failed 6 times' });
  }
}
