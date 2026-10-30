import { describe, expect, it } from 'vitest';
import { createMemoryConnectionStore, ensureAccessToken } from '../src/connection.js';
import { connection, fakeFetch } from './helpers.js';

describe('ensureAccessToken', () => {
  it('uses the cached token when it has more than 5 minutes left', async () => {
    const store = createMemoryConnectionStore(connection());
    const { fn, calls } = fakeFetch({});
    const r = await ensureAccessToken(store, (await store.load())!, fn, 'cid');
    expect(r.accessToken).toBe('at');
    expect(calls).toHaveLength(0);
  });

  it('refreshes and persists a rotated refresh token when near expiry', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const store = createMemoryConnectionStore(connection({ expiresAt: soon }));
    const { fn } = fakeFetch({
      'POST /ims/token/v3': () => new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 86399 })),
    });
    const r = await ensureAccessToken(store, (await store.load())!, fn, 'cid');
    expect(r.accessToken).toBe('at2');
    expect(await store.load()).toMatchObject({ accessToken: 'at2', refreshToken: 'rt2', catalogId: 'cat1' });
  });
});
