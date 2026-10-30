import type { Photo, PhotoPage, PhotoStatus, RawUrl } from './types';
import type { Settings } from './settings';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Api {
  list(status: PhotoStatus, limit?: number, cursor?: string): Promise<PhotoPage>;
  decide(photoId: string, decision: PhotoStatus): Promise<Photo>;
  rawUrl(photoId: string): Promise<RawUrl>;
}

export function createApi({ apiUrl, token }: Settings): Api {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = ((await res.json()) as { error?: string }).error ?? message;
      } catch {
        /* keep statusText */
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as T;
  }

  return {
    list(status, limit = 30, cursor) {
      const q = new URLSearchParams({ status, limit: String(limit) });
      if (cursor) q.set('cursor', cursor);
      return call<PhotoPage>(`/photos?${q}`);
    },
    decide(photoId, decision) {
      return call<Photo>(`/photos/${encodeURIComponent(photoId)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
    },
    rawUrl(photoId) {
      return call<RawUrl>(`/photos/${encodeURIComponent(photoId)}/raw-url`);
    },
  };
}
