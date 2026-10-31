import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PASSWORD_RULE, createReceiverService, generatePassword } from '../src/receiver.js';
import { body, deps, ev, fakeCloud, receiverCfg } from './helpers.js';

describe('generatePassword', () => {
  it('is camera-friendly', () => {
    const p = generatePassword();
    expect(p).toHaveLength(16);
    expect(PASSWORD_RULE.test(p)).toBe(true);
    expect(p).not.toMatch(/[0OIl1]/);
  });
});

describe('receiver routes', () => {
  it('GET /receiver returns everything the camera menu needs, including the password', async () => {
    const r = await createApp(deps())(ev('GET /receiver'));
    expect(r.statusCode).toBe(200);
    expect(body(r)).toEqual({
      host: 'ftp.picket.photos',
      port: 21,
      user: 'camera',
      password: 'OldPass123',
      secureProtocol: true,
      passiveMode: true,
      passivePorts: '30000-30009',
      instanceState: 'running',
    });
  });

  it('POST /receiver/password generates, stores and reloads when running', async () => {
    const { cloud, s } = fakeCloud();
    const app = createApp(deps({ receiver: createReceiverService(receiverCfg, cloud) }));
    const r = await app(ev('POST /receiver/password', { body: '{}' }));
    expect(r.statusCode).toBe(200);
    const b = body(r);
    expect(b.password).not.toBe('OldPass123');
    expect(PASSWORD_RULE.test(b.password)).toBe(true);
    expect(s.password).toBe(b.password);
    expect(s.reloads).toBe(1);
    expect(b.passwordReload).toBe('applied');
  });

  it('POST /receiver/password accepts a chosen password and skips the reload when stopped', async () => {
    const { cloud, s } = fakeCloud({ password: 'x', state: 'stopped' });
    const app = createApp(deps({ receiver: createReceiverService(receiverCfg, cloud) }));
    const r = await app(ev('POST /receiver/password', { body: JSON.stringify({ password: 'Sunny2026' }) }));
    expect(body(r)).toMatchObject({ password: 'Sunny2026', passwordReload: 'applied' });
    expect(s.reloads).toBe(0);
  });

  it('POST /receiver/password rejects bad passwords', async () => {
    const app = createApp(deps());
    expect((await app(ev('POST /receiver/password', { body: JSON.stringify({ password: 'short' }) }))).statusCode).toBe(400);
    expect((await app(ev('POST /receiver/password', { body: JSON.stringify({ password: 'has space 123' }) }))).statusCode).toBe(400);
    expect((await app(ev('POST /receiver/password', { body: 'nope' }))).statusCode).toBe(400);
  });

  it('POST /receiver/power starts and stops', async () => {
    const { cloud } = fakeCloud();
    const app = createApp(deps({ receiver: createReceiverService(receiverCfg, cloud) }));
    expect(body(await app(ev('POST /receiver/power', { body: '{"action":"stop"}' }))).instanceState).toBe('stopping');
    expect(body(await app(ev('POST /receiver/power', { body: '{"action":"start"}' }))).instanceState).toBe('pending');
    expect((await app(ev('POST /receiver/power', { body: '{"action":"reboot"}' }))).statusCode).toBe(400);
  });
});
