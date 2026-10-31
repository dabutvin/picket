import type { Api } from './api';
import type { LightroomInfo, LightroomStatusView, Photo, PhotoStatus, ReceiverSettings, Stats } from './types';

/**
 * An in-memory stand-in for the Picket API with sample photos, so the UI can be tried
 * (and screenshotted) without a camera, an AWS account or a Lightroom login. Sends to
 * Lightroom "complete" after a few seconds so the Picks → Sent flow can be watched.
 * Nothing here touches the network except the sample images themselves.
 */

const LATENCY_MS = 120;
const UPLOADING_AFTER_MS = 1500;
const DONE_AFTER_MS = 3500;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const LENSES = ['FE 35mm F1.8', 'FE 50mm F1.8', 'FE 28-60mm F4-5.6', 'FE 85mm F1.8'];
const SHUTTERS = ['1/250', '1/500', '1/125', '1/1000', '1/60', '1/2000'];
const APERTURES = ['f/1.8', 'f/2.8', 'f/4', 'f/5.6', 'f/8'];
const ISOS = ['100', '200', '400', '800', '1600'];

function samplePhoto(n: number, status: PhotoStatus, lightroom?: LightroomInfo): Photo {
  const portrait = n % 4 === 0;
  const [w, h] = portrait ? [1067, 1600] : [1600, 1067];
  const seed = `picket-${n}`;
  const minute = String((n * 7) % 60).padStart(2, '0');
  const hour = String(9 + Math.floor(n / 4)).padStart(2, '0');
  const day = n <= 4 ? '29' : n <= 12 ? '30' : '31';
  const capturedAt = `2026-10-${day}T${hour}:${minute}:${String((n * 13) % 60).padStart(2, '0')}`;
  return {
    photoId: `demo-${String(n).padStart(2, '0')}`,
    status,
    capturedAt,
    uploadedAt: `2026-10-${day}T${hour}:${minute}:30Z`,
    decidedAt: status === 'unreviewed' ? undefined : `2026-10-30T18:${minute}:00Z`,
    rawKey: `raw/2026/10/30/DSC0${3800 + n}.ARW`,
    fileName: `DSC0${3800 + n}.ARW`,
    previewKey: `previews/demo-${n}.jpg`,
    thumbKey: `thumbs/demo-${n}.jpg`,
    previewUrl: `https://picsum.photos/seed/${seed}/${w}/${h}`,
    thumbUrl: `https://picsum.photos/seed/${seed}/${Math.round(w / 4)}/${Math.round(h / 4)}`,
    width: w * 4,
    height: h * 4,
    bytes: 44_000_000 + n * 310_000,
    camera: 'ILCE-7CM2',
    lens: LENSES[n % LENSES.length],
    iso: ISOS[n % ISOS.length],
    shutter: SHUTTERS[n % SHUTTERS.length],
    aperture: APERTURES[n % APERTURES.length],
    lightroomStatus: lightroom?.status,
    lightroom,
  };
}

const at = (iso: string): LightroomInfo => ({ status: 'done', updatedAt: iso, assetId: 'a1b2c3', albumId: 'alb1', attempts: 1 });

function seedPhotos(): Photo[] {
  const photos: Photo[] = [];
  for (let n = 1; n <= 10; n++) photos.push(samplePhoto(n, 'unreviewed'));
  photos.push(samplePhoto(11, 'pick'));
  photos.push(samplePhoto(12, 'pick'));
  photos.push(
    samplePhoto(13, 'pick', {
      status: 'failed',
      updatedAt: '2026-10-30T18:40:00Z',
      attempts: 2,
      error: 'Adobe rejected the upload: 413 storage quota exceeded',
    }),
  );
  photos.push(samplePhoto(14, 'pick'));
  photos.push(samplePhoto(15, 'sent', at('2026-10-30T18:31:00Z')));
  photos.push(samplePhoto(16, 'sent', at('2026-10-30T18:32:00Z')));
  photos.push(samplePhoto(17, 'reject'));
  photos.push(samplePhoto(18, 'reject'));
  return photos;
}

export const DEMO_EMAIL = 'sample@example.com';

export function createDemoApi(): Api {
  const photos = new Map(seedPhotos().map((p) => [p.photoId, p]));
  let connected = true;
  let receiver: ReceiverSettings = {
    host: 'ftp.picket.photos',
    port: 21,
    user: 'camera',
    password: 'Sample1234',
    secureProtocol: true,
    passiveMode: true,
    passivePorts: '30000-30009',
    instanceState: 'running',
  };

  const now = () => new Date().toISOString();
  const update = (id: string, patch: Partial<Photo>): Photo => {
    const next = { ...photos.get(id)!, ...patch };
    photos.set(id, next);
    return next;
  };

  /** Queue a pick and let it "upload" in the background. */
  const queue = (id: string): Photo | undefined => {
    const p = photos.get(id);
    if (!p || p.status !== 'pick') return undefined;
    const lr = p.lightroom?.status;
    if (lr && lr !== 'queued' && lr !== 'failed') return undefined;
    const queued = update(id, { lightroomStatus: 'queued', lightroom: { ...p.lightroom, status: 'queued', updatedAt: now(), error: undefined } });
    setTimeout(() => {
      const cur = photos.get(id);
      if (cur?.status !== 'pick' || cur.lightroom?.status !== 'queued') return;
      update(id, { lightroomStatus: 'uploading', lightroom: { ...cur.lightroom, status: 'uploading', updatedAt: now(), attempts: (cur.lightroom.attempts ?? 0) + 1 } });
    }, UPLOADING_AFTER_MS);
    setTimeout(() => {
      const cur = photos.get(id);
      if (cur?.status !== 'pick' || cur.lightroom?.status !== 'uploading') return;
      update(id, { status: 'sent', lightroomStatus: 'done', lightroom: { ...cur.lightroom, status: 'done', updatedAt: now(), assetId: 'a1b2c3', albumId: 'alb1' } });
    }, DONE_AFTER_MS);
    return queued;
  };

  const lightroomView = (): LightroomStatusView => ({
    connected,
    email: connected ? DEMO_EMAIL : undefined,
    catalogId: connected ? 'cat-demo' : undefined,
    albumId: connected ? 'alb1' : undefined,
    albumName: 'Picket',
    storage: connected ? { used: 236_000_000_000, limit: 1_000_000_000_000 } : undefined,
    connectedAt: connected ? '2026-10-30T12:00:00Z' : undefined,
    oauth: { clientId: 'demo', scopes: ['openid'], redirectUri: 'adobe+demo://adobeid/demo', authorizeUrl: 'https://ims-na1.adobelogin.com/ims/authorize/v2', tokenUrl: 'https://ims-na1.adobelogin.com/ims/token/v3' },
  });

  return {
    async list(status, limit = 30, cursor) {
      await wait(LATENCY_MS);
      const all = [...photos.values()].filter((p) => p.status === status).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      const start = cursor ? Number(cursor) : 0;
      const items = all.slice(start, start + limit);
      return { items, cursor: start + limit < all.length ? String(start + limit) : undefined };
    },
    async decide(photoId, decision) {
      await wait(LATENCY_MS);
      if (!photos.has(photoId)) throw new Error('photo not found');
      return update(photoId, { status: decision, decidedAt: now() });
    },
    async sendOne(photoId) {
      await wait(LATENCY_MS);
      const p = queue(photoId);
      if (!p) throw new Error('photo not found, not a pick, or already on its way to Lightroom');
      return p;
    },
    async sendMany(req) {
      await wait(LATENCY_MS);
      const ids = req.all
        ? [...photos.values()].filter((p) => p.status === 'pick' && (!p.lightroomStatus || p.lightroomStatus === 'failed')).map((p) => p.photoId)
        : (req.photoIds ?? []);
      const result = { photos: [] as Photo[], skipped: [] as string[] };
      for (const id of ids) {
        const p = queue(id);
        if (p) result.photos.push(p);
        else result.skipped.push(id);
      }
      return result;
    },
    async stats() {
      await wait(LATENCY_MS);
      const s: Stats = {
        photos: { unreviewed: 0, pick: 0, reject: 0, sent: 0 },
        lightroom: { queued: 0, uploading: 0, done: 0, duplicate: 0, failed: 0 },
      };
      for (const p of photos.values()) {
        s.photos[p.status]++;
        if (p.lightroomStatus) s.lightroom[p.lightroomStatus]++;
      }
      return s;
    },
    async lightroom() {
      await wait(LATENCY_MS);
      return lightroomView();
    },
    async connectLightroom() {
      connected = true;
      return lightroomView();
    },
    async refreshLightroom() {
      await wait(LATENCY_MS);
      return lightroomView();
    },
    async disconnectLightroom() {
      connected = false;
      return lightroomView();
    },
    async receiver() {
      await wait(LATENCY_MS);
      return receiver;
    },
    async rotateReceiverPassword(password) {
      await wait(LATENCY_MS * 3);
      receiver = { ...receiver, password: password ?? Math.random().toString(36).slice(2, 12), passwordReload: 'applied' };
      return receiver;
    },
    async receiverPower(action) {
      await wait(LATENCY_MS);
      receiver = { ...receiver, instanceState: action === 'start' ? 'pending' : 'stopping' };
      setTimeout(() => {
        receiver = { ...receiver, instanceState: action === 'start' ? 'running' : 'stopped' };
      }, 2500);
      return receiver;
    },
  };
}
