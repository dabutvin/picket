#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PicketStack } from '../lib/picket-stack';

const app = new cdk.App();

/** Adobe settings: `cdk deploy -c lightroomClientId=...` or LIGHTROOM_CLIENT_ID in the shell. */
const ctx = (key: string, env: string): string | undefined => (app.node.tryGetContext(key) as string | undefined) ?? process.env[env];
const lightroom = {
  clientId: ctx('lightroomClientId', 'LIGHTROOM_CLIENT_ID') ?? '',
  scopes: (ctx('lightroomScopes', 'LIGHTROOM_SCOPES') ?? 'openid,AdobeID,lr_partner_apis,lr_partner_rendition_apis,offline_access')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  albumName: ctx('lightroomAlbumName', 'LIGHTROOM_ALBUM_NAME') ?? 'Picket',
  rawContentType: ctx('lightroomRawContentType', 'LIGHTROOM_RAW_CONTENT_TYPE'),
};
if (!lightroom.clientId) {
  console.warn('[picket] LIGHTROOM_CLIENT_ID not set: the stack deploys, but "Connect Lightroom" in the app will be disabled until it is.');
}

new PicketStack(app, 'Picket', {
  lightroom,
  // Region/account come from the CLI profile (`cdk deploy --profile ...`).
  // Pin them here if you want `cdk synth` to produce an environment-specific template.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Picket: a7C II -> FTPS receiver -> S3 -> previews -> swipe API',
  tags: { project: 'picket' },
});
