# Picket architecture

Picket moves RAW photos from a Sony a7C II to AWS wirelessly, lets you swipe
through them on your phone to pick keepers, and hands the picks to Lightroom.

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
                                                                                                 ▲
                   Expo app (iOS)  ◀──HTTPS + bearer token──▶  HTTP API + Lambda  ─────────────────┘
                   swipe left = reject                        GET  /photos?status=
                   swipe right = pick                         POST /photos/{id}/decision
                   "Send to Lightroom" ──share sheet──▶        GET  /photos/{id}/raw-url (presigned)
                           Lightroom mobile ("Add to Lightroom")
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

### 4. Picks → Lightroom

v1 uses the iOS share sheet: the app downloads the RAW via a presigned URL to
the app cache and opens the share sheet; Lightroom mobile's "Add to Lightroom"
extension imports the ARW into the cloud catalog, which syncs to Lightroom
desktop. No Adobe API approval needed. See ADR-003 for the alternatives
(a desktop watched-folder sync for Lightroom Classic, and the Lightroom cloud
API).

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

GSI `byStatus`: PK `status`, SK `capturedAt`. That is the only query the app
makes.

## API

HTTP API (API Gateway v2) in front of one Lambda (`services/api`). Every
request carries `Authorization: Bearer <token>`; the token lives in Secrets
Manager and is checked by a Lambda authorizer. Single user for now.

| method | path                        | body / query                        | returns |
|--------|-----------------------------|-------------------------------------|---------|
| GET    | `/photos`                   | `status` (default `unreviewed`), `limit` (≤100), `cursor` | `{ items: Photo[], cursor? }` with `previewUrl`/`thumbUrl` presigned (1 h) |
| POST   | `/photos/{id}/decision`     | `{ "decision": "pick" \| "reject" \| "unreviewed" }` | updated `Photo` |
| GET    | `/photos/{id}/raw-url`      |                                     | `{ url, fileName, bytes }` presigned GET (15 min) |

## Repo layout

```
docs/            architecture, ADRs, camera setup
infra/           AWS CDK (TypeScript). One stack: PicketStack
infra/ingest/    cloud-init + upload hook for the FTPS receiver
services/preview Python Lambda: ARW → previews + DynamoDB
services/api     TypeScript Lambda: HTTP API handlers + authorizer
app/             Expo app (swipe review, picks, send to Lightroom)
```

## Costs (us-east-1, rough, per month)

| item                                   | est.   |
|----------------------------------------|--------|
| t4g.nano receiver, on 24/7             | ~$3    |
| public IPv4 (Elastic IP)               | ~$3.65 |
| 8 GB gp3 root volume                   | ~$0.65 |
| S3 standard, 50 GB of RAW              | ~$1.15 |
| Lambda, DynamoDB, API Gateway at hobby volume | <$1 |

Stop the receiver instance when not travelling to save the compute line; the
Elastic IP keeps costing while allocated.

## Not in scope yet

- Multiple users / Cognito.
- Lightroom cloud API upload (needs Adobe partner approval, see ADR-003).
- Burst de-duplication, auto culling, face/focus heuristics.
- Video (the camera can FTP movies too; they'd land in `raw/` and the preview
  Lambda currently skips non-ARW keys).
