import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import type { LightroomSettings } from './lightroom';

export interface ApiProps {
  bucket: s3.IBucket;
  table: dynamodb.ITable;
  lightroom: LightroomSettings;
  /** Secret holding the user's Lightroom tokens (owned by the Lightroom construct). */
  lightroomConnection: secretsmanager.ISecret;
}

const API_DIR = path.join(__dirname, '..', '..', 'services', 'api');

/**
 * HTTP API -> one Lambda for the three routes the app uses, guarded by a
 * bearer-token Lambda authorizer. Single user; Cognito is a later upgrade.
 */
export class Api extends Construct {
  readonly url: string;
  readonly token: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    this.token = new secretsmanager.Secret(this, 'Token', {
      description: 'Picket: bearer token the app sends to the API',
      generateSecretString: { excludePunctuation: true, includeSpace: false, passwordLength: 40 },
    });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      depsLockFilePath: path.join(API_DIR, 'package-lock.json'),
      projectRoot: API_DIR,
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: 'node22' },
    };

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

    const authorizerFn = new NodejsFunction(this, 'AuthorizerFn', {
      ...common,
      logGroup: logGroup('AuthorizerFn'),
      entry: path.join(API_DIR, 'src', 'authorizer.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      environment: { TOKEN_SECRET_ARN: this.token.secretArn },
      description: 'Picket: bearer token check',
    });
    this.token.grantRead(authorizerFn);

    const apiFn = new NodejsFunction(this, 'ApiFn', {
      ...common,
      logGroup: logGroup('ApiFn'),
      entry: path.join(API_DIR, 'src', 'handler.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      environment: {
        PHOTOS_TABLE: props.table.tableName,
        PHOTOS_BUCKET: props.bucket.bucketName,
        STATUS_INDEX: 'byStatus',
        LIGHTROOM_INDEX: 'byLightroomStatus',
        LIGHTROOM_SECRET_ARN: props.lightroomConnection.secretArn,
        LIGHTROOM_CLIENT_ID: props.lightroom.clientId,
        LIGHTROOM_SCOPES: props.lightroom.scopes.join(','),
        LIGHTROOM_ALBUM_NAME: props.lightroom.albumName,
      },
      description: 'Picket: photos API',
    });
    props.table.grantReadWriteData(apiFn);
    props.bucket.grantRead(apiFn);
    props.lightroomConnection.grantRead(apiFn);
    props.lightroomConnection.grantWrite(apiFn);

    const authorizer = new HttpLambdaAuthorizer('Bearer', authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    const http = new apigw.HttpApi(this, 'Http', {
      apiName: 'picket',
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.DELETE, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    http.addRoutes({ path: '/photos', methods: [apigw.HttpMethod.GET], integration });
    http.addRoutes({ path: '/photos/{id}/decision', methods: [apigw.HttpMethod.POST], integration });
    http.addRoutes({ path: '/photos/{id}/raw-url', methods: [apigw.HttpMethod.GET], integration });
    http.addRoutes({ path: '/photos/{id}/lightroom', methods: [apigw.HttpMethod.POST], integration });
    http.addRoutes({ path: '/stats', methods: [apigw.HttpMethod.GET], integration });
    http.addRoutes({ path: '/lightroom', methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.DELETE], integration });
    http.addRoutes({ path: '/lightroom/refresh', methods: [apigw.HttpMethod.POST], integration });

    this.url = http.apiEndpoint;
  }
}
