import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ProcessingProps {
  bucket: s3.Bucket;
  table: dynamodb.ITable;
  rawPrefix: string;
}

const PREVIEW_DIR = path.join(__dirname, '..', '..', 'services', 'preview');

/**
 * S3 raw/ ObjectCreated -> Python Lambda that pulls the embedded JPEG out of
 * the ARW, writes previews/ and thumbs/, and upserts the Photos item.
 */
export class Processing extends Construct {
  readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: ProcessingProps) {
    super(scope, id);

    this.fn = new lambda.Function(this, 'PreviewExtractor', {
      logGroup: new logs.LogGroup(this, 'PreviewExtractorLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.main',
      code: lambda.Code.fromAsset(PREVIEW_DIR, {
        exclude: ['tests', '__pycache__', '.venv', 'dist', '*.md'],
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          // Preferred path: run services/preview/build.sh on this machine (needs python3 + pip).
          // Falls back to the Docker image above if that fails.
          local: {
            tryBundle(outputDir: string): boolean {
              const r = spawnSync('bash', [path.join(PREVIEW_DIR, 'build.sh'), outputDir], { stdio: 'inherit' });
              return r.status === 0;
            },
          },
          command: ['bash', '-c', 'bash build.sh /asset-output'],
          platform: 'linux/arm64',
        },
      }),
      memorySize: 1536,
      timeout: cdk.Duration.seconds(60),
      environment: {
        PHOTOS_TABLE: props.table.tableName,
        PREVIEW_PREFIX: 'previews/',
        THUMB_PREFIX: 'thumbs/',
        PREVIEW_LONG_EDGE: '2048',
        THUMB_LONG_EDGE: '400',
      },
      description: 'Picket: ARW -> embedded JPEG previews + DynamoDB record',
    });

    props.bucket.grantRead(this.fn, `${props.rawPrefix}*`);
    props.bucket.grantPut(this.fn, 'previews/*');
    props.bucket.grantPut(this.fn, 'thumbs/*');
    props.table.grantReadWriteData(this.fn);

    props.bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.fn),
      { prefix: props.rawPrefix },
    );
  }
}
