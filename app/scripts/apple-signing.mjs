#!/usr/bin/env node
/**
 * Non-interactive iOS signing for Picket, driven entirely by the App Store Connect API.
 *
 * EAS CLI can refresh an ad hoc provisioning profile without a human, but it will not
 * create the distribution certificate in --non-interactive mode. Apple's API can, so this
 * script owns the whole chain and hands EAS a credentials.json ("credentialsSource": "local"):
 *
 *   1. iOS Distribution certificate  (reused while valid; private key kept in AWS Secrets Manager)
 *   2. bundle id registration
 *   3. device registration            (UDIDs from `eas device:list --json` and/or $UDIDS)
 *   4. ad hoc (or App Store) provisioning profile, recreated when devices/cert change
 *   5. ios/certs/dist.p12 + ios/certs/profile.mobileprovision + credentials.json
 *
 * Usage:  node scripts/apple-signing.mjs ensure [--type adhoc|appstore]
 *         node scripts/apple-signing.mjs self-test        (no network, no AWS)
 *
 * Env:    ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8 (contents of the .p8)
 *         BUNDLE_ID (default: expo.ios.bundleIdentifier from app.json), APP_NAME (default: expo.name)
 *         SIGNING_SECRET_ID (default: picket/apple-signing)   AWS Secrets Manager id for state
 *         DEVICES_JSON (path to `eas device:list --json` output), UDIDS (comma-separated)
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ASC = 'https://api.appstoreconnect.apple.com/v1';
const PROFILE_TYPES = { adhoc: 'IOS_APP_ADHOC', appstore: 'IOS_APP_STORE' };

// ----------------------------------------------------------------------------- helpers

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const log = (...a) => console.error('[apple-signing]', ...a);

/** Accept the .p8 as pasted: raw PEM, PEM with literal "\n" sequences, or base64 of the file. */
export function normalizeP8(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return s;
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  if (!s.includes('BEGIN')) {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) s = decoded;
  }
  return s.endsWith('\n') ? s : `${s}\n`;
}

export function makeJwt({ keyId, issuerId, p8, now = Date.now() }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  // Apple rejects tokens valid for more than 20 minutes; 15 keeps clock skew harmless.
  const payload = b64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' }));
  const data = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(data), { key: createPrivateKey(normalizeP8(p8)), dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(signature)}`;
}

function openssl(args, input) {
  return execFileSync('openssl', args, { input, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** RSA-2048 key + CSR, the form Apple's certificate endpoint wants. */
export function makeKeyAndCsr(commonName) {
  const dir = mkdtempSync(join(tmpdir(), 'picket-csr-'));
  const keyPath = join(dir, 'key.pem');
  const csrPath = join(dir, 'csr.pem');
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', csrPath, '-subj', `/CN=${commonName}`]);
  return { keyPem: readFileSync(keyPath, 'utf8'), csrPem: readFileSync(csrPath, 'utf8') };
}

/** Bundle PEM key + DER cert into a PKCS#12 that macOS / EAS can import. */
export function makeP12({ keyPem, certDerBase64, password }) {
  const dir = mkdtempSync(join(tmpdir(), 'picket-p12-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const p12Path = join(dir, 'dist.p12');
  writeFileSync(keyPath, keyPem);
  const certPem = openssl(['x509', '-inform', 'DER', '-outform', 'PEM'], Buffer.from(certDerBase64, 'base64'));
  writeFileSync(certPath, certPem);
  const base = ['pkcs12', '-export', '-inkey', keyPath, '-in', certPath, '-out', p12Path, '-passout', `pass:${password}`];
  try {
    // OpenSSL 3 defaults to AES-256 inside the PKCS#12; the legacy ciphers import everywhere.
    openssl([...base, '-legacy']);
  } catch {
    openssl(base);
  }
  return readFileSync(p12Path);
}

export function certInfo(certDerBase64) {
  const text = openssl(['x509', '-inform', 'DER', '-noout', '-serial', '-enddate', '-subject'], Buffer.from(certDerBase64, 'base64')).toString();
  const get = (k) => text.split('\n').find((l) => l.startsWith(k))?.slice(k.length + 1).trim();
  return { serial: get('serial'), notAfter: get('notAfter'), subject: get('subject') };
}

// ----------------------------------------------------------------------------- App Store Connect

class Asc {
  constructor(auth) {
    this.auth = auth;
  }
  async call(method, path, body) {
    const res = await fetch(path.startsWith('http') ? path : `${ASC}${path}`, {
      method,
      headers: { Authorization: `Bearer ${makeJwt(this.auth)}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = JSON.parse(text).errors.map((e) => `${e.title}: ${e.detail}`).join('; ');
      } catch {
        /* raw */
      }
      throw new Error(`App Store Connect ${method} ${path} -> ${res.status}: ${detail}`);
    }
    return text ? JSON.parse(text) : undefined;
  }
  async list(path) {
    const out = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}limit=200`;
    while (next) {
      const page = await this.call('GET', next);
      out.push(...page.data);
      next = page.links?.next;
    }
    return out;
  }
}

// ----------------------------------------------------------------------------- state in Secrets Manager

function aws(args) {
  return execFileSync('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

export function loadState(secretId) {
  try {
    const out = JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', secretId]));
    return out.SecretString ? JSON.parse(out.SecretString) : {};
  } catch (err) {
    if (String(err.stderr ?? err).includes('ResourceNotFoundException')) return null;
    throw err;
  }
}

export function saveState(secretId, state, exists) {
  const payload = JSON.stringify(state);
  if (exists) aws(['secretsmanager', 'put-secret-value', '--secret-id', secretId, '--secret-string', payload]);
  else aws(['secretsmanager', 'create-secret', '--name', secretId, '--description', 'Picket: iOS signing key, certificate and profile', '--secret-string', payload]);
}

// ----------------------------------------------------------------------------- devices input

export function collectUdids({ devicesJsonPath, udidsCsv }) {
  const found = new Map();
  if (devicesJsonPath && existsSync(devicesJsonPath)) {
    const raw = JSON.parse(readFileSync(devicesJsonPath, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.devices ?? raw.data ?? [];
    for (const d of list) {
      const udid = d.identifier ?? d.udid;
      if (udid) found.set(udid.toUpperCase(), d.name || 'iPhone');
    }
  }
  for (const u of (udidsCsv ?? '').split(',').map((s) => s.trim()).filter(Boolean)) found.set(u.toUpperCase(), 'iPhone');
  return found;
}

// ----------------------------------------------------------------------------- main flow

async function ensure({ type }) {
  const env = (k, d) => process.env[k] ?? d;
  const appJson = existsSync('app.json') ? JSON.parse(readFileSync('app.json', 'utf8')).expo : {};
  const bundleId = env('BUNDLE_ID', appJson.ios?.bundleIdentifier);
  const appName = env('APP_NAME', appJson.name ?? 'Picket');
  const secretId = env('SIGNING_SECRET_ID', 'picket/apple-signing');
  const auth = { keyId: env('ASC_KEY_ID'), issuerId: env('ASC_ISSUER_ID'), p8: env('ASC_API_KEY_P8') };
  for (const [k, v] of Object.entries({ ASC_KEY_ID: auth.keyId, ASC_ISSUER_ID: auth.issuerId, ASC_API_KEY_P8: auth.p8, BUNDLE_ID: bundleId })) {
    if (!v) throw new Error(`missing ${k}`);
  }
  const profileType = PROFILE_TYPES[type];
  const asc = new Asc(auth);
  const report = { bundleId, type };

  const loaded = loadState(secretId);
  const state = loaded ?? {};
  const stateExists = loaded !== null;

  // 1. distribution certificate -------------------------------------------------------
  const certs = await asc.list('/certificates?filter[certificateType]=IOS_DISTRIBUTION,DISTRIBUTION');
  let cert = certs.find((c) => c.id === state.certificateId);
  if (cert && new Date(cert.attributes.expirationDate) < new Date(Date.now() + 7 * 86400e3)) {
    log('stored certificate expires within a week; replacing');
    cert = undefined;
  }
  if (!cert || !state.keyPem) {
    log('creating a new iOS Distribution certificate');
    const { keyPem, csrPem } = makeKeyAndCsr(appName);
    try {
      const created = await asc.call('POST', '/certificates', {
        data: { type: 'certificates', attributes: { certificateType: 'IOS_DISTRIBUTION', csrContent: csrPem } },
      });
      cert = created.data;
    } catch (err) {
      throw new Error(
        `${err.message}\nApple allows two iOS Distribution certificates per team. If that limit is the problem, revoke one you no longer use at https://developer.apple.com/account/resources/certificates/list and rerun.`,
      );
    }
    state.keyPem = keyPem;
    state.certificateId = cert.id;
    state.certificateContent = cert.attributes.certificateContent;
    state.p12Password = randomBytes(18).toString('base64url');
    state.profileId = undefined; // old profile points at the old cert
    report.certificateCreated = true;
  } else {
    state.certificateContent ??= cert.attributes.certificateContent;
  }
  report.certificate = { id: cert.id, ...certInfo(state.certificateContent) };

  // 2. bundle id ------------------------------------------------------------------------
  let [bundle] = await asc.list(`/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}`);
  if (!bundle) {
    log(`registering bundle id ${bundleId}`);
    bundle = (await asc.call('POST', '/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: bundleId, name: appName, platform: 'IOS' } } })).data;
    report.bundleIdCreated = true;
  }

  // 3. devices (ad hoc only) --------------------------------------------------------------
  let deviceIds = [];
  if (profileType === 'IOS_APP_ADHOC') {
    const wanted = collectUdids({ devicesJsonPath: env('DEVICES_JSON'), udidsCsv: env('UDIDS') });
    if (wanted.size === 0) {
      throw new Error('No devices. Run the register-device action and enroll your iPhone (or set UDIDS) before an ad hoc build.');
    }
    const existing = await asc.list('/devices?filter[platform]=IOS');
    const byUdid = new Map(existing.map((d) => [d.attributes.udid.toUpperCase(), d]));
    for (const [udid, name] of wanted) {
      let d = byUdid.get(udid);
      if (!d) {
        log(`registering device ${udid}`);
        d = (await asc.call('POST', '/devices', { data: { type: 'devices', attributes: { name, platform: 'IOS', udid } } })).data;
        report.devicesRegistered = (report.devicesRegistered ?? 0) + 1;
      }
      if (d.attributes.status !== 'ENABLED') log(`device ${udid} is ${d.attributes.status}; skipping`);
      else deviceIds.push(d.id);
    }
    if (deviceIds.length === 0) throw new Error('None of the requested devices is enabled on the Apple Developer portal.');
    deviceIds.sort();
  }
  report.devices = deviceIds.length;

  // 4. provisioning profile -------------------------------------------------------------
  const profileName = `${appName} ${type === 'adhoc' ? 'Ad Hoc' : 'App Store'}`;
  const sameDevices = JSON.stringify(state.profileDeviceIds ?? []) === JSON.stringify(deviceIds);
  let profile;
  if (state.profileId && state.profileType === profileType && state.profileCertificateId === cert.id && sameDevices) {
    try {
      const got = await asc.call('GET', `/profiles/${state.profileId}`);
      if (got.data.attributes.profileState === 'ACTIVE' && new Date(got.data.attributes.expirationDate) > new Date(Date.now() + 7 * 86400e3)) profile = got.data;
    } catch {
      /* gone: recreate */
    }
  }
  if (!profile) {
    // Remove stale profiles with our name so the portal doesn't fill up with dead ones.
    for (const old of await asc.list(`/profiles?filter[name]=${encodeURIComponent(profileName)}`)) {
      log(`deleting old profile ${old.id}`);
      await asc.call('DELETE', `/profiles/${old.id}`);
    }
    log(`creating ${profileType} profile "${profileName}" for ${deviceIds.length} device(s)`);
    profile = (
      await asc.call('POST', '/profiles', {
        data: {
          type: 'profiles',
          attributes: { name: profileName, profileType },
          relationships: {
            bundleId: { data: { type: 'bundleIds', id: bundle.id } },
            certificates: { data: [{ type: 'certificates', id: cert.id }] },
            ...(deviceIds.length ? { devices: { data: deviceIds.map((id) => ({ type: 'devices', id })) } } : {}),
          },
        },
      })
    ).data;
    state.profileId = profile.id;
    state.profileType = profileType;
    state.profileCertificateId = cert.id;
    state.profileDeviceIds = deviceIds;
    state.profileContent = profile.attributes.profileContent;
    report.profileCreated = true;
  }
  report.profile = { id: profile.id, name: profileName, expires: profile.attributes.expirationDate };

  saveState(secretId, state, stateExists);

  // 5. files for EAS ---------------------------------------------------------------------
  mkdirSync('ios/certs', { recursive: true });
  writeFileSync('ios/certs/dist.p12', makeP12({ keyPem: state.keyPem, certDerBase64: state.certificateContent, password: state.p12Password }));
  writeFileSync('ios/certs/profile.mobileprovision', Buffer.from(state.profileContent, 'base64'));
  writeFileSync(
    'credentials.json',
    JSON.stringify(
      { ios: { provisioningProfilePath: 'ios/certs/profile.mobileprovision', distributionCertificate: { path: 'ios/certs/dist.p12', password: state.p12Password } } },
      null,
      2,
    ),
  );
  return report;
}

function selfTest() {
  // JWT over a throwaway P-256 key
  const ecKey = openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']).toString();
  const pkcs8 = openssl(['pkcs8', '-topk8', '-nocrypt'], ecKey).toString();
  const token = makeJwt({ keyId: 'KEY1', issuerId: 'issuer', p8: pkcs8 });
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'ES256' || header.kid !== 'KEY1' || payload.aud !== 'appstoreconnect-v1' || Buffer.from(s, 'base64url').length !== 64) {
    throw new Error('jwt self-test failed');
  }
  // key + CSR + self-signed cert + p12 round trip
  const { keyPem, csrPem } = makeKeyAndCsr('Picket self-test');
  if (!csrPem.includes('CERTIFICATE REQUEST')) throw new Error('csr self-test failed');
  const dir = mkdtempSync(join(tmpdir(), 'picket-selftest-'));
  writeFileSync(join(dir, 'key.pem'), keyPem);
  writeFileSync(join(dir, 'csr.pem'), csrPem);
  const certDer = openssl(['x509', '-req', '-in', join(dir, 'csr.pem'), '-signkey', join(dir, 'key.pem'), '-days', '1', '-outform', 'DER']);
  const p12 = makeP12({ keyPem, certDerBase64: certDer.toString('base64'), password: 'pw' });
  writeFileSync(join(dir, 'dist.p12'), p12);
  let info;
  try {
    info = openssl(['pkcs12', '-in', join(dir, 'dist.p12'), '-info', '-nokeys', '-passin', 'pass:pw', '-legacy']).toString();
  } catch {
    info = openssl(['pkcs12', '-in', join(dir, 'dist.p12'), '-info', '-nokeys', '-passin', 'pass:pw']).toString();
  }
  if (!info.includes('BEGIN CERTIFICATE')) throw new Error('p12 self-test failed');
  const ci = certInfo(certDer.toString('base64'));
  if (!ci.serial || !ci.notAfter) throw new Error('certInfo self-test failed');
  const escaped = pkcs8.replace(/\n/g, '\\n');
  if (normalizeP8(escaped) !== pkcs8 && normalizeP8(escaped).trim() !== pkcs8.trim()) throw new Error('normalizeP8 escaped self-test failed');
  if (!normalizeP8(Buffer.from(pkcs8).toString('base64')).includes('BEGIN')) throw new Error('normalizeP8 base64 self-test failed');
  const udids = collectUdids({ udidsCsv: 'abc-1, def-2' });
  if (udids.size !== 2 || !udids.has('ABC-1')) throw new Error('collectUdids self-test failed');
  console.log(JSON.stringify({ ok: true, jwtHeader: header, cert: ci }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'self-test') {
  selfTest();
} else if (cmd === 'ensure') {
  const typeIdx = rest.indexOf('--type');
  const type = typeIdx >= 0 ? rest[typeIdx + 1] : 'adhoc';
  if (!PROFILE_TYPES[type]) throw new Error(`--type must be adhoc or appstore`);
  ensure({ type }).then(
    (report) => console.log(JSON.stringify(report, null, 2)),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
} else {
  console.error('usage: apple-signing.mjs ensure [--type adhoc|appstore] | self-test');
  process.exit(2);
}
