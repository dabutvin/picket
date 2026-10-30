# Picket architecture

Picket moves RAW photos from a Sony a7C II to AWS wirelessly, lets you swipe
through them on your phone to pick keepers, and uploads the picks straight from
S3 into your Lightroom cloud catalog. The RAW files never touch the phone.

```
 Sony a7C II ──FTPES (FTP over TLS)──▶ Receiver (EC2, pure-ftpd) ──aws s3 mv──▶ S3  raw/
                                                                                 │
                                                             S3 event (prefix raw/)
                                                                                 ▼
                                                                 Lambda: preview-extractor
                                                     (pull embedded JPEG, resize, read EXIF)
                                                                                 │
                                            ┌────────────────────────────────────┴───────────┐
                                            ▼                                                ▼
                                    S3 previews/ thumbs/                           DynamoDB Photos table
                                                                                   (status = unreviewed)
                                                                                        ▲        │ stream
                   Expo app (iOS)  ◀──HTTPS + bearer token──▶  HTTP API + Lambda  ──────┘        ▼
                   swipe left  = reject                        GET  /photos?status=        Lambda: router
                   swipe right = pick  → lightroomStatus=queued POST /photos/{id}/decision  (lightroomStatus → queued)
                   "Connect Lightroom" (OAuth PKCE, once)      POST /lightroom  (stores tokens)     │ SQS
                                                                                                    ▼
                                                                                          Lambda: uploader
                                                                                S3 raw/ ──▶ lr.adobe.io catalog
                                                                                           ("Picket" project album)
```

## Stages

### 1. Camera → AWS (ingest)

The a7C II has a built-in FTP client that can transfer every shot automatically
while shooting, RAW-only, over Wi‑Fi, using FTPES (explicit FTP over TLS). It
does not speak SFTP, S3, or HTTP. So the one thing AWS has to offer the camera
is an FTPS endpoint. See `docs/CAMERA_SETUP.md` for the exact menu path.

The receiver is a single `t4g.nano` EC2 instance running `pure-ftpd` with TLS
required, passive mode on a fixed port range, and an Elastic IP. pure-ftpd's
`pure-uploadscript` hook fires once per *completed* upload and runs
`infra/ingest/upload-to-s3.sh`, which moves the file to
`s3://<bucket>/raw/YYYY/MM/DD/<filename>`. Nothing is kept on the instance.
See `docs/DECISIONS.md` ADR-001 for why this beats AWS Transfer Family here.

In the field the camera joins the phone's personal hotspot (or any Wi‑Fi) and
pushes to the receiver's public IP. If the connection drops, the camera queues
and resumes when it reconnects (Sony documents this behaviour).

### 2. Processing

An S3 `ObjectCreated` notification on `raw/` invokes `services/preview`
(Python 3.12, arm64). Sony ARW files embed a full-resolution JPEG
(7008×4672 on the a7C II), so the Lambda:

1. extracts the embedded JPEG with `rawpy.extract_thumb()` (no demosaic),
2. writes `previews/<id>.jpg` (long edge 2048) and `thumbs/<id>.jpg` (long edge 400),
3. reads EXIF (capture time, lens, exposure) with `exifread`,
4. upserts a `Photos` item with `status = unreviewed`.

`id` is derived deterministically from the raw object key, so re-running is
idempotent. A re-upload with the same name on the same day replaces previews
but keeps an existing decision.

### 3. Review (swipe)

`app/` is an Expo (React Native, TypeScript) app. The Review screen loads
`unreviewed` photos oldest-first and shows a swipe deck. Right = pick,
left = reject. Each decision is posted immediately and optimistic; the deck
pre-fetches the next previews. The Picks screen lists `pick` photos.

### 4. Picks → Lightroom cloud

Server-side, through the Lightroom (catalog) API at `https://lr.adobe.io`
(ADR-006). Once, in Settings, you tap **Connect Lightroom**: the app runs an
OAuth Authorization Code + PKCE flow against Adobe IMS with the project's
"OAuth Native App" client id, then hands the resulting tokens to
`POST /lightroom`. The API verifies the account is entitled (`GET /v2/account`,
status `subscriber` or `trial`), fetches the catalog id (`GET /v2/catalog`), and
stores everything in one Secrets Manager secret. The phone keeps nothing.

From then on a swipe right does this:

1. `POST /photos/{id}/decision {pick}` sets `status = pick` and, the first time,
   `lightroomStatus = queued`.
2. The Photos table stream (filtered to `lightroomStatus = queued`) invokes the
   **router** Lambda, which drops `{photoId}` on an SQS queue.
3. The **uploader** Lambda (concurrency 1, batch size 1) loads the row, refreshes
   the access token if needed, makes sure a project album named "Picket" exists,
   downloads the ARW from S3, computes its SHA-256, and calls
   `PUT /v2/catalogs/{catalog}/assets/{asset}` then
   `PUT …/assets/{asset}/master` (one request; a7C II files are far under the
   200 MB per-call limit), then adds the asset to the album with our `photoId`
   as `remoteId`.
4. The row ends as `lightroomStatus = done` (or `duplicate` if Lightroom already
   had the same bytes, HTTP 412). Transient errors (429, 5xx) go back on the
   queue up to 6 times, then to a dead-letter queue; permanent ones (413 storage
   full, 415 content type, 4xx auth) are recorded as `failed` with the message.
   **Retry upload** in the app re-queues a failed pick.

The "Picket" album shows up in Lightroom's Connections panel on every device.

## Data model

DynamoDB table `Photos` (on-demand):

| attribute    | type | notes                                                        |
|--------------|------|--------------------------------------------------------------|
| `photoId`    | S    | PK. `sha256(rawKey)[:16]`                                    |
| `status`     | S    | `unreviewed` \| `pick` \| `reject`                            |
| `capturedAt` | S    | ISO-8601 from EXIF `DateTimeOriginal`; falls back to upload time |
| `rawKey`     | S    | `raw/2026/10/30/DSC01234.ARW`                                |
| `previewKey` | S    | `previews/<photoId>.jpg`                                     |
| `thumbKey`   | S    | `thumbs/<photoId>.jpg`                                       |
| `fileName`   | S    | `DSC01234.ARW`                                               |
| `bytes`      | N    | raw size                                                     |
| `width`, `height` | N | from the embedded JPEG                                   |
| `camera`, `lens`, `iso`, `shutter`, `aperture` | S | from EXIF, best-effort        |
| `uploadedAt` | S    | S3 event time                                                |
| `decidedAt`  | S    | set when status changes                                      |
| `lightroomStatus` | S | `queued` \| `uploading` \| `done` \| `duplicate` \| `failed`; absent until first picked |
| `lightroom`  | M    | `{ status, updatedAt, assetId?, albumId?, error?, attempts? }` |

Review decisions and Lightroom delivery are deliberately separate fields:
"picked" and "in Lightroom" are different questions. Rejecting is a label, not a
delete; the RAW stays in S3.

GSIs: `byStatus` (PK `status`, SK `capturedAt`) drives the swipe and grid
screens; `byLightroomStatus` (PK `lightroomStatus`, SK `decidedAt`, keys only)
drives counts and "what failed". The table streams `NEW_AND_OLD_IMAGES` to the
router.

## API

HTTP API (API Gateway v2) in front of one Lambda (`services/api`). Every
request carries `Authorization: Bearer <token>`; the token lives in Secrets
Manager and is checked by a Lambda authorizer. Single user for now.

| method | path                        | body / query                        | returns |
|--------|-----------------------------|-------------------------------------|---------|
| GET    | `/photos`                   | `status` (default `unreviewed`), `limit` (≤100), `cursor` | `{ items: Photo[], cursor? }` with `previewUrl`/`thumbUrl` presigned (1 h) |
| POST   | `/photos/{id}/decision`     | `{ "decision": "pick" \| "reject" \| "unreviewed" }` | updated `Photo`; a first-time pick is queued for Lightroom |
| POST   | `/photos/{id}/lightroom`    |                                     | re-queues a failed pick (409 if not a pick) |
| GET    | `/photos/{id}/raw-url`      |                                     | `{ url, fileName, bytes }` presigned GET (15 min); kept for debugging |
| GET    | `/stats`                    |                                     | `{ photos: {unreviewed, pick, reject}, lightroom: {queued, uploading, done, duplicate, failed} }` |
| GET    | `/lightroom`                |                                     | connection view + OAuth config (`clientId`, `scopes`, endpoints) for the app |
| POST   | `/lightroom`                | `{ refreshToken, accessToken?, expiresIn? }` from the PKCE flow | verifies with Adobe, stores tokens, returns the view |
| POST   | `/lightroom/refresh`        |                                     | re-reads account/storage from Adobe |
| DELETE | `/lightroom`                |                                     | forgets the tokens |

Tokens never come back out of the API.

## Repo layout

```
docs/            architecture, ADRs, camera setup
infra/           AWS CDK (TypeScript). One stack: PicketStack
infra/ingest/    cloud-init + upload hook for the FTPS receiver
services/preview Python Lambda: ARW → previews + DynamoDB
services/api     TypeScript Lambdas: HTTP API + authorizer, stream router, Lightroom uploader
app/             Expo app (swipe review, picks, skipped, connect Lightroom)
```

## Costs (us-east-1, rough, per month)

| item                                   | est.   |
|----------------------------------------|--------|
| t4g.nano receiver, on 24/7             | ~$3    |
| public IPv4 (Elastic IP)               | ~$3.65 |
| 8 GB gp3 root volume                   | ~$0.65 |
| S3 standard, 50 GB of RAW              | ~$1.15 |
| Lambda, DynamoDB, SQS, API Gateway at hobby volume | <$1 |
| Secrets Manager, 3 secrets                | ~$1.20 |

Stop the receiver instance when not travelling to save the compute line; the
Elastic IP keeps costing while allocated.

## Not in scope yet

- Multiple users / Cognito. One Adobe account, one Lightroom connection.
- Production Adobe approval: the OAuth credential is in development mode, which
  limits logins to the beta users listed in the Developer Console.
- Burst de-duplication, auto culling, face/focus heuristics.
- Video (the camera can FTP movies too; they'd land in `raw/` and the preview
  Lambda currently skips non-ARW keys).
