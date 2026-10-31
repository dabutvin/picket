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
  /**
   * Route 53 mode: an existing hosted zone for the domain (looked up by the deploy workflow).
   * Omit when DNS lives elsewhere (Netlify, ...): records are then added by hand from the deploy summary.
   */
  hostedZoneId?: string;
  /** Route 53 mode: false until the registrar points at the zone, which would otherwise block the deploy on certificate validation. */
  delegated?: boolean;
  /** External-DNS mode: an ISSUED ACM certificate for api.<domain>, requested by the deploy workflow. */
  apiCertificateArn?: string;
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

    const zone = props.dns?.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.dns.hostedZoneId, zoneName: props.dns.domainName })
      : undefined;

    const receiver = new Receiver(this, 'Receiver', {
      bucket: storage.bucket,
      rawPrefix: storage.rawPrefix,
      // With a domain, the receiver always answers to ftp.<domain>; the A record is ours only in Route 53 mode.
      dns: props.dns ? { zone, hostName: `ftp.${props.dns.domainName}` } : undefined,
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
      dns: props.dns
        ? zone && props.dns.delegated
          ? { zone, hostName: `api.${props.dns.domainName}` }
          : props.dns.apiCertificateArn
            ? { hostName: `api.${props.dns.domainName}`, certificateArn: props.dns.apiCertificateArn }
            : undefined
        : undefined,
      receiver,
    });

    new cdk.CfnOutput(this, 'Bucket', { value: storage.bucket.bucketName });
    new cdk.CfnOutput(this, 'Table', { value: storage.table.tableName });
    new cdk.CfnOutput(this, 'ReceiverIp', { value: receiver.publicIp });
    new cdk.CfnOutput(this, 'FtpHost', {
      value: receiver.hostName,
      description: 'Host Name to enter on the camera (FTP Transfer > Server Setting)',
    });
    new cdk.CfnOutput(this, 'Domain', {
      value: props.dns
        ? props.dns.hostedZoneId
          ? `${props.dns.domainName} (Route 53 zone ${props.dns.hostedZoneId}, delegated: ${props.dns.delegated})`
          : `${props.dns.domainName} (external DNS${props.dns.apiCertificateArn ? ', API certificate attached' : ', API certificate pending'})`
        : '(none)',
    });
    new cdk.CfnOutput(this, 'ApiDomainTarget', {
      value: api.domainTarget ?? '(no custom domain yet)',
      description: 'External DNS: create CNAME api.<domain> -> this value',
    });
    new cdk.CfnOutput(this, 'PairingSecret', { value: api.pairing.secretName, description: 'Workflows write one-time app pairing codes here' });
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
