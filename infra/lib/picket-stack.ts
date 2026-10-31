import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Storage } from './storage';
import { Receiver } from './receiver';
import { Processing } from './processing';
import { Api } from './api';
import { Lightroom, type LightroomSettings } from './lightroom';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface DnsSettings {
  /** Apex domain, e.g. picket.photos. */
  domainName: string;
  /** Existing Route 53 hosted zone for the domain (looked up by the deploy workflow, so synth needs no AWS access). */
  hostedZoneId: string;
  /** False until the registrar points at the zone's name servers: skips the API certificate, which would otherwise block the deploy. */
  delegated: boolean;
}

export interface PicketStackProps extends cdk.StackProps {
  lightroom: LightroomSettings;
  dns?: DnsSettings;
}

/**
 * Everything Picket needs, in one stack. Constructs are split by stage so each
 * one reads like the matching section of docs/ARCHITECTURE.md.
 */
export class PicketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PicketStackProps) {
    super(scope, id, props);

    const storage = new Storage(this, 'Storage');

    const zone = props.dns
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.dns.hostedZoneId, zoneName: props.dns.domainName })
      : undefined;

    const receiver = new Receiver(this, 'Receiver', {
      bucket: storage.bucket,
      rawPrefix: storage.rawPrefix,
      dns: zone && props.dns ? { zone, hostName: `ftp.${props.dns.domainName}` } : undefined,
    });

    // Internal state of app/scripts/apple-signing.mjs (iOS key, certificate, profile). Not user-facing.
    new secretsmanager.Secret(this, 'AppleSigningState', {
      secretName: 'picket/apple-signing',
      description: 'Picket: iOS signing key, certificate and profile, written by app/scripts/apple-signing.mjs',
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
    });

    new Processing(this, 'Processing', {
      bucket: storage.bucket,
      table: storage.table,
      rawPrefix: storage.rawPrefix,
    });

    const lightroom = new Lightroom(this, 'Lightroom', {
      bucket: storage.bucket,
      table: storage.table,
      settings: props.lightroom,
    });

    new cdk.CfnOutput(this, 'UploaderLogGroup', { value: lightroom.uploader.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'UploadQueueUrl', { value: lightroom.queue.queueUrl });

    const api = new Api(this, 'Api', {
      bucket: storage.bucket,
      table: storage.table,
      lightroom: props.lightroom,
      lightroomConnection: lightroom.connection,
      dns: zone && props.dns?.delegated ? { zone, hostName: `api.${props.dns.domainName}` } : undefined,
      receiver,
    });

    new cdk.CfnOutput(this, 'Bucket', { value: storage.bucket.bucketName });
    new cdk.CfnOutput(this, 'Table', { value: storage.table.tableName });
    new cdk.CfnOutput(this, 'ReceiverIp', { value: receiver.publicIp });
    new cdk.CfnOutput(this, 'FtpHost', {
      value: receiver.hostName,
      description: 'Host Name to enter on the camera (FTP Transfer > Server Setting)',
    });
    new cdk.CfnOutput(this, 'Domain', { value: props.dns ? `${props.dns.domainName} (zone ${props.dns.hostedZoneId}, delegated: ${props.dns.delegated})` : '(none)' });
    new cdk.CfnOutput(this, 'FtpUser', { value: receiver.ftpUser });
    new cdk.CfnOutput(this, 'ReceiverInstanceId', { value: receiver.instance.instanceId });
    new cdk.CfnOutput(this, 'FtpPasswordSecret', {
      value: receiver.ftpPassword.secretName,
      description: 'aws secretsmanager get-secret-value --secret-id <this>',
    });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'ApiTokenSecret', {
      value: api.token.secretName,
      description: 'Bearer token for the app. Paste into the app Settings screen.',
    });
    new cdk.CfnOutput(this, 'LightroomClientId', {
      value: props.lightroom.clientId,
      description: 'Adobe Developer Console OAuth Native App client id (public)',
    });
    new cdk.CfnOutput(this, 'LightroomRedirectUri', {
      value: props.lightroom.redirectUri,
      description: 'Must equal the redirect URI Adobe shows on the Native App credential; the app registers its scheme',
    });
  }
}
