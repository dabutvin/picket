import { describe, expect, it } from 'vitest';
import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { createAuthorizer, extractBearer, tokensMatch } from '../src/authorizer.js';

describe('extractBearer', () => {
  it('handles scheme case and whitespace', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer('bearer   abc ')).toBe('abc');
    expect(extractBearer('Basic abc')).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer('Bearer')).toBeUndefined();
  });
});

describe('tokensMatch', () => {
  it('is exact', () => {
    expect(tokensMatch('secret', 'secret')).toBe(true);
    expect(tokensMatch('secret1', 'secret')).toBe(false);
    expect(tokensMatch('Secret', 'secret')).toBe(false);
    expect(tokensMatch(undefined, 'secret')).toBe(false);
  });
});

describe('authorizer', () => {
  const auth = createAuthorizer(async () => 'tok');
  const ev = (authorization?: string) =>
    ({ headers: authorization ? { authorization } : {} }) as unknown as APIGatewayRequestAuthorizerEventV2;

  it('authorizes the right token only', async () => {
    expect(await auth(ev('Bearer tok'))).toEqual({ isAuthorized: true });
    expect(await auth(ev('Bearer nope'))).toEqual({ isAuthorized: false });
    expect(await auth(ev())).toEqual({ isAuthorized: false });
  });
});
