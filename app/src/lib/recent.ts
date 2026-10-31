import type { Photo, PhotoStatus } from './types';

/**
 * Decisions made in this session, overlaid on every list the API returns for the next while.
 *
 * Two things make a fresh list stale right after a decision: the request may still be in flight
 * when the next tab mounts, and the `byStatus` index the API lists from is eventually consistent.
 * Either way a pick made a second ago could be missing from Picks (or still showing in Review).
 * Remembering what we just did, and trusting it over the server for a short time, hides both.
 * A decision is forgotten as soon as a server list shows the photo where we put it; after
 * that the server is authoritative, which is what lets a sent photo leave Picks.
 */

const TTL_MS = 90_000;
const recent = new Map<string, { photo: Photo; at: number }>();

/** The user moved a photo to `status` (swipe, skip, pick again, undo). */
export function noteDecision(photo: Photo, status: PhotoStatus): void {
  recent.set(photo.photoId, { photo: { ...photo, status, decidedAt: new Date().toISOString() }, at: Date.now() });
}

/** The server returned a fresher photo (a send queued it); remember it as-is. */
export function notePhoto(photo: Photo): void {
  recent.set(photo.photoId, { photo, at: Date.now() });
}

const newer = (a: Photo, b: Photo) => (a.lightroom?.updatedAt ?? '') > (b.lightroom?.updatedAt ?? '');

/** The list for `status` as the API returned it, corrected by what this session knows. */
export function withRecent(status: PhotoStatus, items: Photo[]): Photo[] {
  const now = Date.now();
  for (const [id, r] of recent) if (now - r.at > TTL_MS) recent.delete(id);
  if (recent.size === 0) return items;

  const byId = new Map(items.map((p) => [p.photoId, p]));
  for (const [id, { photo }] of recent) {
    const server = byId.get(id);
    if (photo.status !== status) {
      if (server) byId.delete(id); // moved away from this tab a moment ago; the server still lists it
      continue;
    }
    if (!server) {
      byId.set(id, photo); // the server has not caught up with the decision yet
      continue;
    }
    // The server knows about it. From here on it is authoritative (it is what moves a sent
    // photo out of Picks), unless our copy carries a newer Lightroom state than it returned.
    if (newer(photo, server)) byId.set(id, photo);
    else recent.delete(id);
  }
  return [...byId.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
