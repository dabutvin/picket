import type {
  ConnectRequest,
  Decision,
  LightroomStatusView,
  Photo,
  PhotoPage,
  PhotoStatus,
  ReceiverPowerAction,
  ReceiverSettings,
  SendRequest,
  SendResult,
  Stats,
} from './types';
import type { Settings } from './settings';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Api {
  list(status: PhotoStatus, limit?: number, cursor?: string): Promise<PhotoPage>;
  decide(photoId: string, decision: Decision): Promise<Photo>;
  /** Send one pick to Lightroom, or retry / nudge one that failed or is stuck on queued. */
  sendOne(photoId: string): Promise<Photo>;
  /** Send a batch of picks (at most 100 ids per call), or every pick with `all: true`. */
  sendMany(req: SendRequest): Promise<SendResult>;
  stats(): Promise<Stats>;
  lightroom(): Promise<LightroomStatusView>;
  connectLightroom(req: ConnectRequest): Promise<LightroomStatusView>;
  refreshLightroom(): Promise<LightroomStatusView>;
  disconnectLightroom(): Promise<LightroomStatusView>;
  receiver(): Promise<ReceiverSettings>;
  rotateReceiverPassword(password?: string): Promise<ReceiverSettings>;
  receiverPower(action: ReceiverPowerAction): Promise<ReceiverSettings>;
}

/** Exchange a one-time pairing code (from the deploy / ops summary) for the API token. No auth. */
export async function pair(apiUrl: string, code: string): Promise<string> {
  const res = await fetch(`${apiUrl}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
  return ((await res.json()) as { token: string }).token;
}

export function createApi({ apiUrl, token }: Settings): Api {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      let message = res.statusText || `HTTP ${res.status}`;
      try {
        message = ((await res.json()) as { error?: string }).error ?? message;
      } catch {
        /* keep statusText */
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as T;
  }

  const post = <T>(path: string, body?: unknown) =>
    call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    list(status, limit = 30, cursor) {
      const q = new URLSearchParams({ status, limit: String(limit) });
      if (cursor) q.set('cursor', cursor);
      return call<PhotoPage>(`/photos?${q}`);
    },
    decide: (photoId, decision) => post<Photo>(`/photos/${encodeURIComponent(photoId)}/decision`, { decision }),
    sendOne: (photoId) => post<Photo>(`/photos/${encodeURIComponent(photoId)}/lightroom`),
    sendMany: (req) => post<SendResult>('/lightroom/send', req),
    stats: () => call<Stats>('/stats'),
    lightroom: () => call<LightroomStatusView>('/lightroom'),
    connectLightroom: (req) => post<LightroomStatusView>('/lightroom', req),
    refreshLightroom: () => post<LightroomStatusView>('/lightroom/refresh'),
    disconnectLightroom: () => call<LightroomStatusView>('/lightroom', { method: 'DELETE' }),
    receiver: () => call<ReceiverSettings>('/receiver'),
    rotateReceiverPassword: (password) => post<ReceiverSettings>('/receiver/password', password ? { password } : {}),
    receiverPower: (action) => post<ReceiverSettings>('/receiver/power', { action }),
  };
}
