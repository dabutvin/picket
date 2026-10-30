import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * One bucket, three prefixes (raw/, previews/, thumbs/) and one table.
 * See docs/DECISIONS.md ADR-005.
 */
export class Storage extends Construct {
  readonly bucket: s3.Bucket;
  readonly table: dynamodb.Table;
  readonly rawPrefix = 'raw/';
  readonly previewPrefix = 'previews/';
  readonly thumbPrefix = 'thumbs/';

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Photos', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      // Photos are the product. Never let a `cdk destroy` take them with it.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'raw-to-intelligent-tiering',
          prefix: this.rawPrefix,
          transitions: [
            { storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: cdk.Duration.days(0) },
          ],
        },
        { id: 'abort-incomplete-multipart', abortIncompleteMultipartUploadAfter: cdk.Duration.days(2) },
      ],
      cors: [
        {
          // Lets the Expo web build load presigned previews directly.
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
    });

    this.table = new dynamodb.Table(this, 'PhotosTable', {
      partitionKey: { name: 'photoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Picks flow to the Lightroom uploader through this stream (see lib/lightroom.ts).
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // The only query the app makes: next N photos with a given status, oldest first.
    this.table.addGlobalSecondaryIndex({
      indexName: 'byStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'capturedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Sparse index: only rows that have been queued for Lightroom carry lightroomStatus.
    this.table.addGlobalSecondaryIndex({
      indexName: 'byLightroomStatus',
      partitionKey: { name: 'lightroomStatus', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'decidedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
  }
}
