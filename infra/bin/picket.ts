#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PicketStack } from '../lib/picket-stack';

const app = new cdk.App();

/**
 * Adobe Developer Console settings. The defaults are the project's "OAuth Native App"
 * credential with Lightroom Services (public identifiers, no secret). Override with
 * `cdk deploy -c lightroomClientId=...` or LIGHTROOM_* variables in the shell.
 * The redirect URI is fixed by Adobe (adobe+<hash>://adobeid/<clientId>) and its
 * scheme must also be listed under `expo.scheme` in app/app.json.
 */
const ctx = (key: string, env: string): string | undefined => (app.node.tryGetContext(key) as string | undefined) ?? process.env[env];
const lightroom = {
  clientId: ctx('lightroomClientId', 'LIGHTROOM_CLIENT_ID') ?? '5143c127087c4e06ac773b76c4d05f61',
  redirectUri: ctx('lightroomRedirectUri', 'LIGHTROOM_REDIRECT_URI') ?? 'adobe+94690ff144227aa43751adfb4cb46fc1432adb0c://adobeid/5143c127087c4e06ac773b76c4d05f61',
  scopes: (ctx('lightroomScopes', 'LIGHTROOM_SCOPES') ?? 'openid,AdobeID,lr_partner_apis,lr_partner_rendition_apis,offline_access')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  albumName: ctx('lightroomAlbumName', 'LIGHTROOM_ALBUM_NAME') ?? 'Picket',
  rawContentType: ctx('lightroomRawContentType', 'LIGHTROOM_RAW_CONTENT_TYPE'),
};

/**
 * DNS, set by the deploy workflow:
 *   external DNS (Netlify, ...):  -c domainName=picket.photos [-c apiCertificateArn=arn:aws:acm:...]  (records added by hand)
 *   Route 53:                     -c domainName=... -c hostedZoneId=Z... -c dnsDelegated=true|false
 * Without a domainName, synth/deploy produce an IP-only receiver and the default API URL.
 */
const domainName = ctx('domainName', 'DOMAIN_NAME');
const hostedZoneId = ctx('hostedZoneId', 'HOSTED_ZONE_ID');
const apiCertificateArn = ctx('apiCertificateArn', 'API_CERTIFICATE_ARN');
const dns = domainName
  ? {
      domainName,
      hostedZoneId: hostedZoneId || undefined,
      delegated: hostedZoneId ? String(ctx('dnsDelegated', 'DNS_DELEGATED') ?? 'false') === 'true' : undefined,
      apiCertificateArn: apiCertificateArn || undefined,
    }
  : undefined;

/** `-c receiver=false` deploys everything except the EC2 receiver (e.g. while a new AWS account is still blocked from EC2). */
const receiver = String(ctx('receiver', 'PICKET_RECEIVER') ?? 'true') !== 'false';

new PicketStack(app, 'Picket', {
  lightroom,
  dns,
  receiver,
  // Region/account come from the CLI profile (`cdk deploy --profile ...`).
  // Pin them here if you want `cdk synth` to produce an environment-specific template.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Picket: a7C II -> FTPS receiver -> S3 -> previews -> swipe API',
  tags: { project: 'picket' },
});
