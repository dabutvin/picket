import { Platform } from 'react-native';
import type { Api } from './api';
import type { Photo, PhotoStatus } from './types';

/**
 * Every photo in a tab, kept in memory and on disk, synced from the API in the background.
 *
 * Skipped and Sent grow into the thousands, and the API lists at most 100 per call, so a tab
 * that loaded on demand would open empty, page in as you scrolled, and show "60+". Instead:
 *
 * - **Open from the cache.** A tab renders the last list it had, at once: from memory while
 *   the app runs, from a JSON file across launches.
 * - **Sync behind it.** Then every page is fetched in turn (100 at a time). While that runs the
 *   list is the fresh pages followed by the cached tail past them, so nothing disappears and
 *   reappears. When it finishes the server's list replaces the cache and is saved.
 * - **Warm up early.** `warm()` runs these syncs a few seconds after launch, so a tab has its
 *   list before it is ever opened.
 * - **Patch locally.** A pick, skip or send moves the photo between the cached lists right away
 *   (`applyDecision`, `applyPhoto`), so tabs agree with each other without waiting for a sync.
 *
 * The thumbnails themselves are cached by expo-image under a stable key (`imageKey`), which
 * matters because the API signs a new URL on every list call.
 */

const PAGE = 100;
/** A complete list younger than this opens without a sync. */
const FRESH_MS = 60_000;
const SAVE_DELAY_MS = 1500;
const FILE_VERSION = 1;

export interface Snapshot {
  items: Photo[];
  /** Every page has been fetched (or this came from a saved complete list). */
  complete: boolean;
  /** When the server last confirmed the whole list; 0 = never, or marked stale. */
  syncedAt: number;
  syncing: boolean;
}

const mem = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<Photo[]>>();
const listeners = new Map<string, Set<(s: Snapshot) => void>>();
const hydrating = new Map<string, Promise<void>>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const keyOf = (api: Api, status: PhotoStatus) => `${api.cacheId}|${status}`;
const statusOf = (key: string) => key.slice(key.lastIndexOf('|') + 1) as PhotoStatus;
const idOf = (key: string) => key.slice(0, key.lastIndexOf('|'));
const persistable = (cacheId: string) => Platform.OS !== 'web' && cacheId !== 'demo';
const byCapture = (a: Photo, b: Photo) => a.capturedAt.localeCompare(b.capturedAt);

/** Stable cache key for a photo's thumbnail or preview: survives URL re-signing, changes when a frame is re-sent. */
export const imageKey = (photo: Photo, kind: 'thumb' | 'preview') =>
  `${kind === 'thumb' ? photo.thumbKey : photo.previewKey}@${photo.processedAt ?? photo.uploadedAt}`;

function emit(key: string, snap: Snapshot) {
  mem.set(key, snap);
  listeners.get(key)?.forEach((l) => l(snap));
}

export function peek(api: Api, status: PhotoStatus): Snapshot | undefined {
  return mem.get(keyOf(api, status));
}

export function subscribe(api: Api, status: PhotoStatus, fn: (s: Snapshot) => void): () => void {
  const key = keyOf(api, status);
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

async function cacheFile(cacheId: string, status: PhotoStatus) {
  const { Directory, File, Paths } = await import('expo-file-system');
  const dir = new Directory(Paths.document, 'picket-cache');
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, `${cacheId.replace(/[^A-Za-z0-9]+/g, '_')}-${status}.json`);
}

/** Load the saved list for a tab into memory, once per launch. Missing or unreadable files are ignored. */
export function hydrate(api: Api, status: PhotoStatus): Promise<void> {
  const key = keyOf(api, status);
  if (mem.has(key) || !persistable(api.cacheId)) return Promise.resolve();
  let p = hydrating.get(key);
  if (!p) {
    p = (async () => {
      try {
        const file = await cacheFile(api.cacheId, status);
        if (!file.exists) return;
        const saved = JSON.parse(await file.text()) as { v: number; syncedAt: number; items: Photo[] };
        // Something newer may have landed while the file was read (a sync, a local patch).
        if (saved.v !== FILE_VERSION || mem.has(key)) return;
        // Saved without preview URLs (see scheduleSave); the detail view shows the thumbnail until a sync refills them.
        const items = saved.items.map((p) => ({ ...p, previewUrl: p.previewUrl ?? '' }));
        emit(key, { items, complete: true, syncedAt: saved.syncedAt, syncing: false });
      } catch {
        /* a bad cache is just no cache */
      }
    })();
    hydrating.set(key, p);
  }
  return p;
}

function scheduleSave(key: string) {
  if (!persistable(idOf(key))) return;
  const prev = saveTimers.get(key);
  if (prev) clearTimeout(prev);
  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key);
      const snap = mem.get(key);
      if (!snap?.complete) return; // only whole lists are worth saving
      void cacheFile(idOf(key), statusOf(key))
        // Signed URLs are over a kilobyte each and expire within the hour; keep only the thumbnail's,
        // which still works as an expo-image cache lookup (imageKey) once it has expired.
        .then((file) => {
          const items = snap.items.map(({ previewUrl: _drop, ...rest }) => rest);
          return file.write(JSON.stringify({ v: FILE_VERSION, syncedAt: snap.syncedAt, items }));
        })
        .catch(() => undefined);
    }, SAVE_DELAY_MS),
  );
}

/** Does this tab need a sync? (No list yet, an incomplete one, or older than FRESH_MS.) */
export function isStale(api: Api, status: PhotoStatus): boolean {
  const s = peek(api, status);
  return !s || !s.complete || Date.now() - s.syncedAt > FRESH_MS;
}

/**
 * Fetch every page of a tab and replace the cache with the result. Concurrent calls for the
 * same tab share one run. Emits progress after each page.
 */
export function sync(api: Api, status: PhotoStatus): Promise<Photo[]> {
  const key = keyOf(api, status);
  const running = inflight.get(key);
  if (running) return running;

  const run = (async () => {
    const before = mem.get(key);
    const cached = before?.items ?? [];
    emit(key, { items: cached, complete: before?.complete ?? false, syncedAt: before?.syncedAt ?? 0, syncing: true });
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
          emit(key, { items: fresh.concat(tail), complete: false, syncedAt: before?.syncedAt ?? 0, syncing: true });
        }
      } while (cursor);
    } catch (e) {
      const now = mem.get(key);
      if (now) emit(key, { ...now, syncing: false });
      throw e;
    }

    if (status === 'pick') movedToSent(api, cached, fresh);
    emit(key, { items: fresh, complete: true, syncedAt: Date.now(), syncing: false });
    scheduleSave(key);
    return fresh;
  })().finally(() => inflight.delete(key));

  inflight.set(key, run);
  return run;
}

/**
 * Picks that were on their way to Lightroom and are gone from a fresh Picks list were sent:
 * put them on Sent now, and have Sent re-sync the next time it opens.
 */
function movedToSent(api: Api, before: Photo[], after: Photo[]) {
  const still = new Set(after.map((p) => p.photoId));
  const sent = before
    .filter((p) => !still.has(p.photoId) && (p.lightroom?.status === 'queued' || p.lightroom?.status === 'uploading'))
    .map((p): Photo => ({ ...p, status: 'sent', lightroomStatus: 'done', lightroom: { ...p.lightroom!, status: 'done' } }));
  const key = keyOf(api, 'sent');
  const snap = mem.get(key);
  if (!snap) return;
  const ids = new Set(sent.map((p) => p.photoId));
  emit(key, { ...snap, items: [...snap.items.filter((p) => !ids.has(p.photoId)), ...sent].sort(byCapture), syncedAt: 0 });
}

/** Change one tab's cached list in place (the grid's optimistic edits). */
export function patch(api: Api, status: PhotoStatus, fn: (items: Photo[]) => Photo[]): void {
  const key = keyOf(api, status);
  const snap = mem.get(key) ?? { items: [], complete: false, syncedAt: 0, syncing: false };
  emit(key, { ...snap, items: fn(snap.items) });
  scheduleSave(key);
}

/** A photo was moved to `status`: add it to that tab's cached list and remove it from every other. */
export function applyDecision(photo: Photo): void {
  for (const [key, snap] of mem) {
    const has = snap.items.some((p) => p.photoId === photo.photoId);
    const here = statusOf(key) === photo.status;
    if (!has && !here) continue;
    const rest = snap.items.filter((p) => p.photoId !== photo.photoId);
    const items = here ? [...rest, photo].sort(byCapture) : rest;
    emit(key, { ...snap, items });
    scheduleSave(key);
  }
}

/** The server returned a fresher copy of a photo (a send queued it): replace it wherever it is cached. */
export function applyPhoto(photo: Photo): void {
  for (const [key, snap] of mem) {
    if (!snap.items.some((p) => p.photoId === photo.photoId)) continue;
    emit(key, { ...snap, items: snap.items.map((p) => (p.photoId === photo.photoId ? photo : p)) });
  }
}

/**
 * Load and sync the grid tabs in the background, one at a time, so they are ready before they
 * are opened. Skipped and Sent are the big ones; Picks is small and synced when it opens anyway.
 */
export async function warm(api: Api, statuses: PhotoStatus[] = ['reject', 'sent', 'pick']): Promise<void> {
  for (const status of statuses) {
    await hydrate(api, status);
    if (isStale(api, status)) await sync(api, status).catch(() => undefined);
  }
}

/** Forget every cached list (sign out). */
export async function clearAll(): Promise<void> {
  mem.clear();
  if (Platform.OS === 'web') return;
  try {
    const { Directory, Paths } = await import('expo-file-system');
    const dir = new Directory(Paths.document, 'picket-cache');
    if (dir.exists) dir.delete();
  } catch {
    /* nothing to clear */
  }
}
