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
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Receiver } from './receiver';
import { Construct } from 'constructs';

import type { LightroomSettings } from './lightroom';

export interface ApiProps {
  bucket: s3.IBucket;
  table: dynamodb.ITable;
  lightroom: LightroomSettings;
  /** Secret holding the user's Lightroom tokens (owned by the Lightroom construct). */
  lightroomConnection: secretsmanager.ISecret;
  /**
   * Serve the API at https://<hostName>. Route 53 mode: a certificate is created and validated in `zone`
   * and an alias record added. External-DNS mode: pass an ISSUED `certificateArn`; the CNAME is added by hand.
   */
  dns?: { hostName: string; zone?: route53.IHostedZone; certificateArn?: string };
  /** The FTPS receiver the app manages (settings, password rotation, start/stop). */
  receiver: Receiver;
}

const API_DIR = path.join(__dirname, '..', '..', 'services', 'api');

/**
 * HTTP API -> one Lambda for the three routes the app uses, guarded by a
 * bearer-token Lambda authorizer. Single user; Cognito is a later upgrade.
 */
export class Api extends Construct {
  readonly url: string;
  readonly token: secretsmanager.Secret;
  /** One-time app pairing codes (see services/api/src/pairing.ts). */
  readonly pairing: secretsmanager.Secret;
  /** Regional domain name of the custom domain, for an external CNAME. */
  readonly domainTarget?: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    this.token = new secretsmanager.Secret(this, 'Token', {
      description: 'Picket: bearer token the app sends to the API',
      generateSecretString: { excludePunctuation: true, includeSpace: false, passwordLength: 40 },
    });

    this.pairing = new secretsmanager.Secret(this, 'Pairing', {
      description: 'Picket: short-lived one-time code the app exchanges for the API token',
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
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
      timeout: cdk.Duration.seconds(29), // a password rotation waits briefly for the receiver to reload
      environment: {
        PHOTOS_TABLE: props.table.tableName,
        PHOTOS_BUCKET: props.bucket.bucketName,
        STATUS_INDEX: 'byStatus',
        LIGHTROOM_INDEX: 'byLightroomStatus',
        LIGHTROOM_SECRET_ARN: props.lightroomConnection.secretArn,
        LIGHTROOM_CLIENT_ID: props.lightroom.clientId,
        LIGHTROOM_SCOPES: props.lightroom.scopes.join(','),
        LIGHTROOM_REDIRECT_URI: props.lightroom.redirectUri,
        LIGHTROOM_ALBUM_NAME: props.lightroom.albumName,
        RECEIVER_HOST: props.receiver.hostName,
        RECEIVER_FTP_USER: props.receiver.ftpUser,
        RECEIVER_PASV_MIN: String(props.receiver.passivePorts.min),
        RECEIVER_PASV_MAX: String(props.receiver.passivePorts.max),
        RECEIVER_PASSWORD_SECRET_ARN: props.receiver.ftpPassword.secretArn,
        RECEIVER_INSTANCE_ID: props.receiver.instance.instanceId,
        PAIRING_SECRET_ARN: this.pairing.secretArn,
        TOKEN_SECRET_ARN: this.token.secretArn,
      },
      description: 'Picket: photos API',
    });
    this.pairing.grantRead(apiFn);
    this.pairing.grantWrite(apiFn);
    this.token.grantRead(apiFn);
    // Camera settings are managed from the app: read/rotate the FTP password, reload it on the
    // receiver over SSM, start/stop the instance.
    props.receiver.ftpPassword.grantRead(apiFn);
    props.receiver.ftpPassword.grantWrite(apiFn);
    const instanceArn = cdk.Stack.of(this).formatArn({ service: 'ec2', resource: 'instance', resourceName: props.receiver.instance.instanceId });
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [instanceArn, cdk.Stack.of(this).formatArn({ service: 'ssm', region: '*', account: '', resource: 'document', resourceName: 'AWS-RunShellScript' })],
      }),
    );
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation', 'ec2:DescribeInstances'], resources: ['*'] }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:StartInstances', 'ec2:StopInstances'], resources: [instanceArn] }));
    props.table.grantReadWriteData(apiFn);
    // Presigned preview/thumb URLs only. The API must never be able to hand out a RAW (ADR-006).
    props.bucket.grantRead(apiFn, 'previews/*');
    props.bucket.grantRead(apiFn, 'thumbs/*');
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
    // Pairing is the one route without the bearer token: it exchanges a one-time code for it.
    http.addRoutes({ path: '/pair', methods: [apigw.HttpMethod.POST], integration, authorizer: new apigw.HttpNoneAuthorizer() });
    http.addRoutes({ path: '/photos', methods: [apigw.HttpMethod.GET], integration });
    http.addRoutes({ path: '/photos/{id}/decision', methods: [apigw.HttpMethod.POST], integration });
    http.addRoutes({ path: '/photos/{id}/lightroom', methods: [apigw.HttpMethod.POST], integration });
    http.addRoutes({ path: '/stats', methods: [apigw.HttpMethod.GET], integration });
    http.addRoutes({ path: '/lightroom', methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.DELETE], integration });
    http.addRoutes({ path: '/lightroom/refresh', methods: [apigw.HttpMethod.POST], integration });
    http.addRoutes({ path: '/receiver', methods: [apigw.HttpMethod.GET], integration });
    http.addRoutes({ path: '/receiver/password', methods: [apigw.HttpMethod.POST], integration });
    http.addRoutes({ path: '/receiver/power', methods: [apigw.HttpMethod.POST], integration });

    this.url = http.apiEndpoint;

    if (props.dns) {
      const certificate = props.dns.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'Certificate', props.dns.certificateArn)
        : new acm.Certificate(this, 'Certificate', {
            domainName: props.dns.hostName,
            validation: acm.CertificateValidation.fromDns(props.dns.zone),
          });
      const domain = new apigw.DomainName(this, 'Domain', { domainName: props.dns.hostName, certificate });
      new apigw.ApiMapping(this, 'Mapping', { api: http, domainName: domain });
      if (props.dns.zone) {
        new route53.ARecord(this, 'DnsRecord', {
          zone: props.dns.zone,
          recordName: props.dns.hostName,
          target: route53.RecordTarget.fromAlias(new targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId)),
        });
      }
      this.domainTarget = domain.regionalDomainName;
      this.url = `https://${props.dns.hostName}`;
    }
  }
}
