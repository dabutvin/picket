#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PicketStack } from '../lib/picket-stack';

const app = new cdk.App();

new PicketStack(app, 'Picket', {
  // Region/account come from the CLI profile (`cdk deploy --profile ...`).
  // Pin them here if you want `cdk synth` to produce an environment-specific template.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Picket: a7C II -> FTPS receiver -> S3 -> previews -> swipe API',
  tags: { project: 'picket' },
});
