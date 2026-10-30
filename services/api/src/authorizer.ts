import { timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerResult } from 'aws-lambda';

/** Pull "abc" out of "Bearer abc" (case-insensitive scheme). */
export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1];
}

export function tokensMatch(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuthorizer(loadToken: () => Promise<string>) {
  return async (event: APIGatewayRequestAuthorizerEventV2): Promise<APIGatewaySimpleAuthorizerResult> => {
    const header = event.headers?.authorization ?? event.headers?.Authorization;
    const expected = await loadToken();
    return { isAuthorized: tokensMatch(extractBearer(header), expected) };
  };
}

let cached: Promise<string> | undefined;
const loadFromSecretsManager = (): Promise<string> => {
  cached ??= new SecretsManagerClient({})
    .send(new GetSecretValueCommand({ SecretId: process.env.TOKEN_SECRET_ARN }))
    .then((r) => {
      if (!r.SecretString) throw new Error('token secret is empty');
      return r.SecretString;
    })
    .catch((err) => {
      cached = undefined; // retry on the next invocation
      throw err;
    });
  return cached;
};

export const handler = createAuthorizer(loadFromSecretsManager);
