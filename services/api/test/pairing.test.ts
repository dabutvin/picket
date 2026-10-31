import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMemoryPairingStore, normalizeCode, redeemPairingCode } from '../src/pairing.js';
import { body, deps, ev } from './helpers.js';

const future = () => new Date(Date.now() + 600_000).toISOString();
const past = () => new Date(Date.now() - 1).toISOString();

describe('normalizeCode', () => {
  it('ignores case and separators', () => {
    expect(normalizeCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizeCode(' ab cd 23 45 ')).toBe('ABCD2345');
  });
});

describe('redeemPairingCode', () => {
  it('returns the token once and burns the code', async () => {
    const store = createMemoryPairingStore({ code: 'ABCD2345', expiresAt: future() }, 'tok');
    expect(await redeemPairingCode(store, 'abcd-2345')).toEqual({ ok: true, token: 'tok' });
    expect(await redeemPairingCode(store, 'abcd-2345')).toEqual({ ok: false, reason: 'used' });
  });
  it('rejects wrong, missing and expired codes', async () => {
    expect(await redeemPairingCode(createMemoryPairingStore({ code: 'ABCD2345', expiresAt: future() }), 'ZZZZ9999')).toEqual({ ok: false, reason: 'invalid' });
    expect(await redeemPairingCode(createMemoryPairingStore(null), 'ABCD2345')).toEqual({ ok: false, reason: 'invalid' });
    expect(await redeemPairingCode(createMemoryPairingStore({ code: 'ABCD2345', expiresAt: past() }), 'ABCD2345')).toEqual({ ok: false, reason: 'expired' });
    expect(await redeemPairingCode(createMemoryPairingStore({ code: 'ABCD2345', expiresAt: future() }), '')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('POST /pair', () => {
  it('exchanges the code for the token, then refuses reuse', async () => {
    const app = createApp(deps());
    const r = await app(ev('POST /pair', { body: JSON.stringify({ code: 'abcd-2345' }) }));
    expect(r.statusCode).toBe(200);
    expect(body(r)).toEqual({ token: 'the-token' });
    expect((await app(ev('POST /pair', { body: JSON.stringify({ code: 'abcd-2345' }) }))).statusCode).toBe(410);
    expect((await app(ev('POST /pair', { body: JSON.stringify({ code: 'nope' }) }))).statusCode).toBe(401);
    expect((await app(ev('POST /pair', { body: '{}' }))).statusCode).toBe(400);
  });
});
