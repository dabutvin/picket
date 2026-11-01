import { Platform } from 'react-native';
import { ApiError, type Api } from './api';
import type { Photo, PhotoStatus } from './types';

/**
 * Every photo in a grid tab (Picks, Sent, Skipped), kept in memory and on disk, and kept current
 * from the API's change feed.
 *
 * Photos never change in place and are never deleted; what changes is which tab a photo is in
 * (a decision), its Lightroom state, and rarely its previews (a re-sent frame). So:
 *
 * - **Load each tab once.** The first time a tab is needed (on this phone, or after a cache
 *   reset) all its photos are fetched, 100 at a time.
 * - **Then only apply changes.** The API's `/photos/changes?since=` returns every row written
 *   after a time, in any tab. Each one is moved into the tab its status says. One request, a few
 *   rows, however big the tabs are. Each call asks from a couple of minutes before the last
 *   answer, because the index trails a write by a moment; applying a row twice is harmless.
 * - **Open from the cache, refresh behind it.** A tab renders its last list on the first frame
 *   (memory while the app runs, a JSON file across launches), then `refresh()` applies changes.
 *   It runs a few seconds after launch, when the app comes back to the foreground, when a tab
 *   opens, every 2.5 s while a send is in flight, and on pull-to-refresh (which reloads in full).
 * - **No signed URLs on disk.** They are over a kilobyte each and expire within the hour.
 *   Thumbnails load through expo-image's disk cache under a stable key (`imageKey`), so a
 *   thumbnail seen once needs no URL again. One that is not cached and has no live URL fails to
 *   load; its `onError` calls `needUrls()`, which signs fresh URLs for a batch of photos at once.
 * - **Patch locally.** This phone's own decisions move the photo between the cached lists at
 *   once (`applyDecision`, `applyPhoto`); the feed confirms them later.
 */

const PAGE = 100;
/** Ask the feed from this long before the last answer: the byChange index can trail a write. */
const OVERLAP_MS = 2 * 60_000;
/** A tab open within this long of the last refresh does not start another. */
const MIN_REFRESH_MS = 3000;
const SAVE_DELAY_MS = 1500;
const URL_BATCH_MS = 60;
/** Don't ask again for a photo whose fresh URL also failed (a missing object) within this long. */
const URL_RETRY_MS = 60_000;
const FILE_VERSION = 2;
const GRID_TABS: PhotoStatus[] = ['reject', 'sent', 'pick'];

export interface Snapshot {
  items: Photo[];
  /** The whole tab has been loaded (or came from a saved complete list). */
  complete: boolean;
  /** A full load is running. */
  syncing: boolean;
}

interface Meta {
  /** The feed's last `until`; null until a first full load has anchored it. */
  since: string | null;
  refreshedAt: number;
}

const mem = new Map<string, Snapshot>();
const meta = new Map<string, Meta>();
const listeners = new Map<string, Set<(s: Snapshot) => void>>();
const hydrating = new Map<string, Promise<void>>();
const fullLoads = new Map<string, Promise<void>>();
const refreshes = new Map<string, Promise<void>>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const keyOf = (cacheId: string, status: PhotoStatus) => `${cacheId}|${status}`;
const idOf = (key: string) => key.slice(0, key.lastIndexOf('|'));
const statusOf = (key: string) => key.slice(key.lastIndexOf('|') + 1) as PhotoStatus;
const persistable = (cacheId: string) => Platform.OS !== 'web' && cacheId !== 'demo';
const byCapture = (a: Photo, b: Photo) => a.capturedAt.localeCompare(b.capturedAt);
const tabsOf = (cacheId: string) => [...mem.keys()].filter((k) => idOf(k) === cacheId);

/** Stable cache key for a photo's thumbnail or preview: survives URL re-signing, changes when a frame is re-sent. */
export const imageKey = (photo: Photo, kind: 'thumb' | 'preview') =>
  `${kind === 'thumb' ? photo.thumbKey : photo.previewKey}@${photo.processedAt ?? photo.uploadedAt}`;

/**
 * Stands in for a signed URL that was not saved. Never resolves (".invalid" is reserved), so a
 * thumbnail missing from the image cache fails at once and its onError asks for a real one.
 */
const unsigned = (key: string) => `https://picket.invalid/${key}`;

function emit(key: string, snap: Snapshot) {
  mem.set(key, snap);
  listeners.get(key)?.forEach((l) => l(snap));
}

export function peek(api: Api, status: PhotoStatus): Snapshot | undefined {
  return mem.get(keyOf(api.cacheId, status));
}

export function subscribe(api: Api, status: PhotoStatus, fn: (s: Snapshot) => void): () => void {
  const key = keyOf(api.cacheId, status);
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

// ---------------------------------------------------------------- disk

async function cacheFile(cacheId: string, name: string) {
  const { Directory, File, Paths } = await import('expo-file-system');
  const dir = new Directory(Paths.document, 'picket-cache');
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, `${cacheId.replace(/[^A-Za-z0-9]+/g, '_')}-${name}.json`);
}

async function readJson<T>(cacheId: string, name: string): Promise<T | null> {
  try {
    const file = await cacheFile(cacheId, name);
    return file.exists ? (JSON.parse(await file.text()) as T) : null;
  } catch {
    return null; // a bad cache is just no cache
  }
}

function writeJson(cacheId: string, name: string, data: unknown) {
  void cacheFile(cacheId, name)
    .then((file) => file.write(JSON.stringify(data)))
    .catch(() => undefined);
}

function scheduleSave(key: string) {
  const cacheId = idOf(key);
  if (!persistable(cacheId)) return;
  const prev = saveTimers.get(key);
  if (prev) clearTimeout(prev);
  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key);
      const snap = mem.get(key);
      if (!snap?.complete) return; // only whole lists are worth saving
      // Metadata only: signed URLs are big and short-lived (see `unsigned`).
      const items = snap.items.map(({ thumbUrl: _t, previewUrl: _p, ...rest }) => rest);
      writeJson(cacheId, statusOf(key), { v: FILE_VERSION, items });
    }, SAVE_DELAY_MS),
  );
}

function saveMeta(cacheId: string) {
  const m = meta.get(cacheId);
  if (m && persistable(cacheId)) writeJson(cacheId, 'meta', { v: FILE_VERSION, since: m.since });
}

// (saveMeta with since = null makes the next launch drop the saved lists and reload them in full.)

/** Load the saved lists (and the feed position) into memory, once per launch. */
export function hydrate(api: Api): Promise<void> {
  const cacheId = api.cacheId;
  if (!persistable(cacheId)) {
    if (!meta.has(cacheId)) meta.set(cacheId, { since: null, refreshedAt: 0 });
    return Promise.resolve();
  }
  let p = hydrating.get(cacheId);
  if (!p) {
    p = (async () => {
      const savedMeta = await readJson<{ v: number; since: string | null }>(cacheId, 'meta');
      if (!meta.has(cacheId)) meta.set(cacheId, { since: savedMeta?.v === FILE_VERSION ? savedMeta.since : null, refreshedAt: 0 });
      await Promise.all(
        GRID_TABS.map(async (status) => {
          const key = keyOf(cacheId, status);
          const saved = await readJson<{ v: number; items: Omit<Photo, 'thumbUrl' | 'previewUrl'>[] }>(cacheId, status);
          // Something newer may have landed while the file was read (a full load, a local patch).
          if (saved?.v !== FILE_VERSION || mem.has(key)) return;
          const items = saved.items.map((p): Photo => ({ ...p, thumbUrl: unsigned(p.thumbKey), previewUrl: unsigned(p.previewKey) }));
          emit(key, { items, complete: true, syncing: false });
        }),
      );
      // Lists without a feed position cannot be brought up to date incrementally: drop them.
      if (!meta.get(cacheId)!.since) for (const k of tabsOf(cacheId)) if (mem.get(k)!.complete) mem.delete(k);
    })();
    hydrating.set(cacheId, p);
  }
  return p;
}

// ---------------------------------------------------------------- loading

/** Fetch every page of one tab and make it that tab's list. Concurrent calls share one run. */
function fullLoad(api: Api, status: PhotoStatus): Promise<void> {
  const key = keyOf(api.cacheId, status);
  const running = fullLoads.get(key);
  if (running) return running;
  const run = (async () => {
    const before = mem.get(key);
    const cached = before?.items ?? [];
    emit(key, { items: cached, complete: before?.complete ?? false, syncing: true });
    let fresh: Photo[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await api.list(status, PAGE, cursor);
        fresh = fresh.concat(page.items);
        cursor = page.cursor;
        if (cursor) {
          // Fresh pages, then whatever the cache had past them: the best guess until the rest arrives.
          const ids = new Set(fresh.map((p) => p.photoId));
          const frontier = fresh[fresh.length - 1]?.capturedAt ?? '';
          const tail = cached.filter((p) => p.capturedAt >= frontier && !ids.has(p.photoId));
          emit(key, { items: fresh.concat(tail), complete: false, syncing: true });
        }
      } while (cursor);
    } catch (e) {
      const now = mem.get(key);
      if (now) emit(key, { ...now, syncing: false });
      throw e;
    }
    emit(key, { items: fresh, complete: true, syncing: false });
    scheduleSave(key);
  })().finally(() => fullLoads.delete(key));
  fullLoads.set(key, run);
  return run;
}

/** Put a row the server returned where its status says, in every cached tab of this backend. */
function applyServerPhoto(cacheId: string, photo: Photo) {
  for (const key of tabsOf(cacheId)) {
    const snap = mem.get(key)!;
    const here = statusOf(key) === photo.status;
    const at = snap.items.findIndex((p) => p.photoId === photo.photoId);
    if (at < 0 && !here) continue;
    let items: Photo[];
    if (!here) items = snap.items.filter((p) => p.photoId !== photo.photoId);
    else if (at >= 0) items = snap.items.map((p, i) => (i === at ? photo : p));
    else items = [...snap.items, photo].sort(byCapture);
    emit(key, { ...snap, items });
    scheduleSave(key);
  }
}

/**
 * Bring the cached tabs up to date. The first time (no feed position yet) this anchors the feed
 * and loads `statuses` in full; after that it loads any of `statuses` not cached yet, then
 * applies the change feed to every cached tab. `full` reloads `statuses` in full first
 * (pull-to-refresh). Concurrent calls share one run.
 */
export function refresh(api: Api, statuses: PhotoStatus[] = GRID_TABS, opts: { full?: boolean } = {}): Promise<void> {
  const cacheId = api.cacheId;
  const running = refreshes.get(cacheId);
  if (running && !opts.full) return running;
  const run = (async () => {
    await hydrate(api);
    const m = meta.get(cacheId)!;
    m.refreshedAt = Date.now();

    if (!m.since) {
      // Anchor first: anything written while the full loads run is picked up by the next feed call.
      let anchor: string | null = null;
      try {
        anchor = (await api.changes()).until;
      } catch (e) {
        if (!noFeed(e)) throw e; // an API without the feed (not deployed yet, rolled back): load in full every time
      }
      for (const status of statuses) await fullLoad(api, status);
      if (anchor) {
        m.since = anchor;
        saveMeta(cacheId);
      }
      return;
    }

    for (const status of statuses) {
      if (opts.full || !mem.get(keyOf(cacheId, status))?.complete) await fullLoad(api, status);
    }

    const since = new Date(Date.parse(m.since) - OVERLAP_MS).toISOString();
    let until: string | null = null;
    let cursor: string | undefined;
    try {
      do {
        const page = await api.changes(since, cursor);
        until ??= page.until;
        for (const photo of page.items) applyServerPhoto(cacheId, photo);
        cursor = page.cursor;
      } while (cursor);
    } catch (e) {
      if (!noFeed(e)) throw e; // offline and the like: keep the cache, try again next time
      m.since = null; // the feed is gone: back to full loads until it returns
      saveMeta(cacheId);
      for (const status of statuses) await fullLoad(api, status);
      return;
    }
    m.since = until;
    saveMeta(cacheId);
  })().finally(() => {
    if (refreshes.get(cacheId) === run) refreshes.delete(cacheId);
  });
  refreshes.set(cacheId, run);
  return run;
}

/** The API has no change feed (404: older than ADR-009). */
const noFeed = (e: unknown) => e instanceof ApiError && e.status === 404;

/** refresh(), unless one ran in the last few seconds (tab switches in quick succession). */
export function refreshSoon(api: Api, statuses: PhotoStatus[]): Promise<void> {
  const m = meta.get(api.cacheId);
  const loaded = statuses.every((s) => mem.get(keyOf(api.cacheId, s))?.complete);
  if (m?.since && loaded && Date.now() - m.refreshedAt < MIN_REFRESH_MS) return Promise.resolve();
  return refresh(api, statuses);
}

/** Background warm-up after launch and on returning to the foreground. */
export function warm(api: Api): Promise<void> {
  return refresh(api).catch(() => undefined);
}

// ---------------------------------------------------------------- signed URLs on demand

const urlQueue = new Map<string, Set<string>>();
const urlTimers = new Map<string, ReturnType<typeof setTimeout>>();
const urlAskedAt = new Map<string, number>();

/** A thumbnail or preview failed to load: sign fresh URLs for it (batched with others). */
export function needUrls(api: Api, photo: Photo): void {
  const asked = urlAskedAt.get(photo.photoId);
  if (asked && Date.now() - asked < URL_RETRY_MS) return;
  urlAskedAt.set(photo.photoId, Date.now());
  const cacheId = api.cacheId;
  let q = urlQueue.get(cacheId);
  if (!q) urlQueue.set(cacheId, (q = new Set()));
  q.add(photo.photoId);
  if (urlTimers.has(cacheId)) return;
  urlTimers.set(
    cacheId,
    setTimeout(() => {
      urlTimers.delete(cacheId);
      const ids = [...(urlQueue.get(cacheId) ?? [])];
      urlQueue.delete(cacheId);
      for (let i = 0; i < ids.length; i += PAGE) {
        api.urls(ids.slice(i, i + PAGE)).then(
          ({ photos }) => {
            for (const key of tabsOf(cacheId)) {
              const snap = mem.get(key)!;
              if (!snap.items.some((p) => photos[p.photoId])) continue;
              emit(key, { ...snap, items: snap.items.map((p) => (photos[p.photoId] ? { ...p, ...photos[p.photoId] } : p)) });
            }
          },
          () => undefined,
        );
      }
    }, URL_BATCH_MS),
  );
}

// ---------------------------------------------------------------- local patches

/** Change one tab's cached list in place (the grid's optimistic edits). */
export function patch(api: Api, status: PhotoStatus, fn: (items: Photo[]) => Photo[]): void {
  const key = keyOf(api.cacheId, status);
  const snap = mem.get(key) ?? { items: [], complete: false, syncing: false };
  emit(key, { ...snap, items: fn(snap.items) });
  scheduleSave(key);
}

/** This phone moved a photo to `photo.status`: move it between every cached tab at once. */
export function applyDecision(photo: Photo): void {
  for (const cacheId of new Set([...mem.keys()].map(idOf))) applyServerPhoto(cacheId, photo);
}

/** The server returned a fresher copy of a photo (a send queued it): replace it wherever it is cached. */
export function applyPhoto(photo: Photo): void {
  for (const [key, snap] of mem) {
    if (!snap.items.some((p) => p.photoId === photo.photoId)) continue;
    emit(key, { ...snap, items: snap.items.map((p) => (p.photoId === photo.photoId ? photo : p)) });
  }
}

/** Forget every cached list and feed position (sign out). */
export async function clearAll(): Promise<void> {
  mem.clear();
  meta.clear();
  hydrating.clear();
  if (Platform.OS === 'web') return;
  try {
    const { Directory, Paths } = await import('expo-file-system');
    const dir = new Directory(Paths.document, 'picket-cache');
    if (dir.exists) dir.delete();
  } catch {
    /* nothing to clear */
  }
}
