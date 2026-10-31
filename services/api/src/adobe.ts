/**
 * Minimal clients for Adobe IMS (OAuth) and the Lightroom cloud catalog API.
 * Everything takes an injectable fetch so tests never hit the network.
 * Flow and endpoints: https://developer.adobe.com/lightroom/lightroom-api-docs/getting-started/upload-content/
 */
import { randomUUID } from 'node:crypto';

export type FetchFn = typeof fetch;

export const IMS_BASE = 'https://ims-na1.adobelogin.com';
export const IMS_AUTHORIZE_URL = `${IMS_BASE}/ims/authorize/v2`;
export const IMS_TOKEN_URL = `${IMS_BASE}/ims/token/v3`;
export const LR_BASE = 'https://lr.adobe.io';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export class AdobeError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `Adobe API ${status}: ${body.slice(0, 300)}`);
  }
  /** Not worth retrying: bad request, auth, storage full, wrong content type, not found. */
  get permanent(): boolean {
    return [400, 401, 403, 404, 413, 415].includes(this.status);
  }
}

/** Lightroom responses are prefixed with an anti-JSON-hijacking guard. */
export function parseLightroomJson<T>(text: string): T {
  const trimmed = text.replace(/^while\s*\(1\)\s*\{\s*\}\s*/, '');
  return JSON.parse(trimmed) as T;
}

/** GUID without hyphens, as the Lightroom API requires. */
export const newLightroomId = (): string => randomUUID().replace(/-/g, '');

/** Exchange a refresh token for a fresh access token (public client: no secret). IMS may rotate the refresh token. */
export async function refreshTokens(fetchFn: FetchFn, clientId: string, refreshToken: string): Promise<Tokens> {
  const res = await fetchFn(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }),
  });
  const text = await res.text();
  if (!res.ok) throw new AdobeError(res.status, text, `IMS refresh failed (${res.status})`);
  const json = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
  };
}

export interface Account {
  id: string;
  email: string;
  entitlement: {
    status: string;
    storage?: { used: number; limit: number; display_limit?: number; warn?: number };
  };
}

export interface Catalog {
  id: string;
}

export interface CreateAssetInput {
  fileName: string;
  /** ISO-8601. */
  captureDate: string;
  importedBy: string;
  importTimestamp: string;
  sha256: string;
  fileSize: number;
}

export class LightroomClient {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly apiKey: string,
    private readonly accessToken: string,
    private readonly base: string = LR_BASE,
  ) {}

  private async call(method: string, path: string, init: { body?: RequestInit['body']; headers?: Record<string, string> } = {}): Promise<Response> {
    return this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        Authorization: `Bearer ${this.accessToken}`,
        ...(init.headers ?? {}),
      },
      body: init.body,
    });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new AdobeError(res.status, text);
    return text.trim() ? parseLightroomJson<T>(text) : (undefined as T);
  }

  health(): Promise<{ version: string }> {
    return this.json('GET', '/v2/health');
  }

  account(): Promise<Account> {
    return this.json('GET', '/v2/account');
  }

  catalog(): Promise<Catalog> {
    return this.json('GET', '/v2/catalog');
  }

  /** Returns 'duplicate' when Lightroom already holds a file with this SHA-256 (HTTP 412). */
  async createAsset(catalogId: string, assetId: string, input: CreateAssetInput): Promise<'created' | 'duplicate'> {
    const res = await this.call('PUT', `/v2/catalogs/${catalogId}/assets/${assetId}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subtype: 'image',
        payload: {
          captureDate: input.captureDate,
          importSource: {
            fileName: input.fileName,
            importedOnDevice: this.apiKey,
            importedBy: input.importedBy,
            importTimestamp: input.importTimestamp,
            sha256: input.sha256,
            fileSize: input.fileSize,
          },
        },
      }),
    });
    if (res.status === 412) return 'duplicate';
    if (!res.ok) throw new AdobeError(res.status, await res.text());
    return 'created';
  }

  /** Single-shot upload; the API allows 200 MB per call, far above any a7C II frame. */
  async uploadMaster(catalogId: string, assetId: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await this.call('PUT', `/v2/catalogs/${catalogId}/assets/${assetId}/master`, {
      headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
      body,
    });
    if (!res.ok) throw new AdobeError(res.status, await res.text());
  }

  async listProjectAlbums(catalogId: string): Promise<{ id: string; payload?: { name?: string } }[]> {
    const page = await this.json<{ resources?: { id: string; payload?: { name?: string } }[] }>(
      'GET',
      `/v2/catalogs/${catalogId}/albums?subtype=project`,
    );
    return page.resources ?? [];
  }

  async createProjectAlbum(catalogId: string, albumId: string, name: string): Promise<void> {
    const now = new Date().toISOString();
    await this.json('PUT', `/v2/catalogs/${catalogId}/albums/${albumId}`, {
      subtype: 'project',
      serviceId: this.apiKey,
      payload: { userCreated: now, userUpdated: now, name, publishInfo: { version: 3, created: now, updated: now } },
    });
  }

  /** Up to 50 per call. `remoteId` lets Lightroom carry our photoId back to us. */
  async addToAlbum(catalogId: string, albumId: string, assets: { assetId: string; remoteId: string }[]): Promise<void> {
    for (let i = 0; i < assets.length; i += 50) {
      await this.json('PUT', `/v2/catalogs/${catalogId}/albums/${albumId}/assets`, {
        resources: assets.slice(i, i + 50).map((a) => ({ id: a.assetId, payload: { publishInfo: { remoteId: a.remoteId } } })),
      });
    }
  }
}

/**
 * Content type for the master upload. Lightroom accepts the common image types by name and
 * everything else, proprietary camera raws included, only as application/octet-stream: the
 * first live ARW with image/x-sony-arw was refused with 415 InvalidContentTypeError.
 * Override with LIGHTROOM_RAW_CONTENT_TYPE if Adobe changes its mind.
 */
export function contentTypeFor(fileName: string, override?: string): string {
  if (override) return override;
  const ext = fileName.toLowerCase().split('.').pop();
  switch (ext) {
    case 'dng':
      return 'image/x-adobe-dng';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'heif':
    case 'heic':
      return 'image/heic';
    default:
      return 'application/octet-stream';
  }
}
