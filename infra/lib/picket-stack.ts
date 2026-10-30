import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Storage } from './storage';
import { Receiver } from './receiver';
import { Processing } from './processing';
import { Api } from './api';
import { Lightroom, type LightroomSettings } from './lightroom';

export interface PicketStackProps extends cdk.StackProps {
  lightroom: LightroomSettings;
}

/**
 * Everything Picket needs, in one stack. Constructs are split by stage so each
 * one reads like the matching section of docs/ARCHITECTURE.md.
 */
export class PicketStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PicketStackProps) {
    super(scope, id, props);

    const storage = new Storage(this, 'Storage');

    const receiver = new Receiver(this, 'Receiver', {
      bucket: storage.bucket,
      rawPrefix: storage.rawPrefix,
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

    const api = new Api(this, 'Api', {
      bucket: storage.bucket,
      table: storage.table,
      lightroom: props.lightroom,
      lightroomConnection: lightroom.connection,
    });

    new cdk.CfnOutput(this, 'Bucket', { value: storage.bucket.bucketName });
    new cdk.CfnOutput(this, 'Table', { value: storage.table.tableName });
    new cdk.CfnOutput(this, 'ReceiverIp', {
      value: receiver.publicIp,
      description: 'Host Name to enter on the camera (FTP Transfer > Server Setting)',
    });
    new cdk.CfnOutput(this, 'FtpUser', { value: receiver.ftpUser });
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
