# Decisions

Short architecture decision records. Newest at the bottom.

## ADR-001: FTPS receiver on a tiny EC2 instance, not AWS Transfer Family

**Context.** The a7C II can only push over FTP/FTPES. AWS Transfer Family offers
a managed FTPS endpoint that writes straight to S3, which is the obvious fit.
But it bills ~$0.30 per protocol-hour (~$216/month) whether or not anything is
transferred, and stopping the server does not stop the charge; only deleting it
does. Plain FTP on Transfer Family is VPC-only, so the camera could not reach it
from a hotspot anyway.

**Decision.** Run `pure-ftpd` on a `t4g.nano` (arm64, ~$3/month) behind an
Elastic IP, TLS required, passive ports 30000–30009 opened in the security
group. `pure-uploadscript` runs `aws s3 mv` on each completed upload. The
instance is stateless; cloud-init rebuilds it from `infra/ingest/`.

**Consequences.** We own patching and the TLS cert. The cert is self-signed by
default; the camera accepts it either by importing the cert as a root
certificate from a memory card, or by setting *Root Certificate Error →
Connect* (Sony warns this skips server verification). A Let's Encrypt cert on a
real hostname removes that step and is a documented follow-up.

**Revisit if** Transfer Family gets a per-request pricing tier, or the project
grows beyond one photographer.

## ADR-002: Expo (React Native) for the swipe app

**Context.** The repo was created with an Xcode `.gitignore`, so a native
SwiftUI app was on the table. The swipe UI is small and the heavy lifting is in
AWS. Since ADR-006 the only platform-specific need is catching Adobe's OAuth
redirect (a custom URL scheme); the phone never handles a RAW file.

**Decision.** Expo with TypeScript, `react-native-gesture-handler` +
`react-native-reanimated` for the deck, `expo-auth-session` +
`expo-web-browser` for the Adobe login, `expo-secure-store` for the API token.
EAS development builds for a device install (Expo Go can't register the Adobe
scheme). Reaffirmed after ADR-006: SwiftUI was offered as the alternative and
declined.

**Consequences.** One codebase also runs on Android and (for the review
screen) in a browser. Native modules are limited to what Expo ships.

## ADR-003: Picks reach Lightroom through the iOS share sheet first (superseded by ADR-006)

**Context.** Three ways to get an ARW into Lightroom:

1. **Lightroom cloud API** (`PUT /v2/catalogs/{id}/assets/{id}/master`).
   Cleanest, fully server-side, but the API is gated: you must apply for
   Lightroom Services access in the Adobe Developer Console and user reports
   say it's not available on trial/individual plans. High risk of being stuck.
2. **iOS share sheet → "Add to Lightroom".** Lightroom mobile ships a share
   extension that accepts RAW files. Works today with zero approvals, syncs to
   the cloud catalog and on to Lightroom desktop. Costs one tap per batch and
   the download goes through the phone.
3. **Desktop watched folder.** A small CLI pulls `pick` RAWs from S3 into a
   folder that Lightroom Classic auto-imports. Best for Classic users, no phone
   bandwidth, but needs a machine running.

**Decision (original).** Ship (2) in v1. Add (3) as `tools/lightroom-sync` when
someone needs Classic. Keep (1) as a stretch goal.

**Superseded.** Two constraints surfaced after the first scaffold: the RAW files
must never be on the phone, and Lightroom Classic is out. That rules out (2) and
(3) outright. See ADR-006.

## ADR-004: Previews come from the embedded JPEG, not a RAW decode

**Context.** Verified on a real a7C II file (`DSC02429.ARW` from raw.pixls.us):
the ARW embeds a 7008×4672 JPEG (~6.7 MB). A full LibRaw demosaic would take
seconds and ~1 GB of memory per image; extracting the embedded JPEG takes
milliseconds.

**Decision.** `rawpy.extract_thumb()` → Pillow resize to 2048 px and 400 px
long edge. The preview reflects the camera's JPEG rendering (picture profile,
white balance), which is exactly what you want when culling.

## ADR-005: One S3 bucket with prefixes, one DynamoDB table

Separate buckets buy nothing at this scale. `raw/`, `previews/`, `thumbs/`
prefixes in one bucket; the S3 → Lambda notification is filtered to `raw/` so
writing previews cannot re-trigger the function. One table with a `byStatus`
GSI covers the only query pattern (give me the next N unreviewed, oldest
first).

## ADR-006: Upload picks server-side with the Lightroom catalog API

**Context.** Requirements: preview on the phone, RAW files never on the phone,
picks land in the Lightroom *cloud* catalog, no Lightroom Classic. Every
phone-side hand-off (share sheet, Photos Auto Add, Shortcuts) pulls the file
onto the phone first. Lightroom desktop (cloud) has no watched folder. That
leaves the catalog API at `lr.adobe.io`, which is partner-gated. Adobe's other
"Lightroom API" (Firefly Services) is an unrelated, stateless image processor
that reached end-of-life in July 2026 and never touched catalogs.

**Unblocked by.** An "OAuth Native App" credential with Lightroom Services on the
Adobe Developer Console, in development mode, with the Lightroom account added
as a beta user. Enough for one user's own catalog.

**Decision.**
- The app runs Authorization Code + PKCE against Adobe IMS (public client, no
  secret). Adobe fixes the redirect URI for Native App credentials to
  `adobe+<hash>://adobeid/<clientId>`, so the app registers that scheme and the
  backend serves the exact value; the app immediately hands the tokens to the
  backend. The backend stores them in Secrets Manager, refreshes them, and never
  returns them.
- A pick is a row-level state change (`lightroomStatus = queued`; since
  ADR-008 set by an explicit send, not by the swipe). The table
  stream → router Lambda → SQS → uploader Lambda pipeline reacts to it. SQS gives
  retries, a dead-letter queue, and serialization (uploader concurrency 1).
- The uploader follows Adobe's documented flow: create asset with
  `importedOnDevice = <API key>` and the file's SHA-256, PUT the master in one
  request, add to a project album named "Picket" with our `photoId` as
  `remoteId`. 412 means Lightroom already has those bytes; recorded as
  `duplicate`, not an error.
- `lightroomStatus` is separate from `status`. Un-picking after upload does not
  delete anything in Lightroom.

**Consequences.** The phone only ever sees JPEG previews, and that is also all
it can keep: *Save to Photos* / *Share…* (from #30) put the 2048 px preview in
the photo library or the share sheet, never the RAW. Delivery is a few
seconds after the send and survives the phone going offline. We depend on
Adobe keeping the credential enabled; development mode caps who can log in
(fine for one photographer). There is deliberately no API route that hands out
a RAW download URL; the API role can only presign `previews/` and `thumbs/`.

**Confirmed from the console.** Scopes are `lr_partner_apis, AdobeID,
lr_partner_rendition_apis, openid, offline_access`; client id and redirect URI
are the defaults in `infra/bin/picket.ts`.

**Open item to confirm on the first real upload.** The `Content-Type` Lightroom
accepts for `.ARW` masters (`image/x-sony-arw` by default;
`LIGHTROOM_RAW_CONTENT_TYPE` overrides it if Adobe answers 415).

## ADR-007: Phone-only operations; GitHub holds only AWS and Expo credentials

**Context.** The operator runs everything from a phone. GitHub Actions is the
only executor. Camera settings should be managed in the app, not in a console.

**Decision.**
- Every operation is a `workflow_dispatch` button: `deploy`, `ops`,
  `app-build`. Results go to the run summary; no secret is ever printed.
- GitHub secrets: AWS credentials (keys or an OIDC role), `EXPO_TOKEN` and the
  Apple Team key. The app pairs through a 30-minute, single-use code that the
  deploy or ops workflow writes to Secrets Manager and prints; `POST /pair`
  redeems it for the bearer token, so no human ever handles the token. Secrets
  Manager holds only machine state: the camera password (managed through the
  app's Camera tab, which rotates it and reloads the receiver over SSM), the API
  token, the pairing code, the iOS signing material, and the Lightroom tokens.
- iOS signing goes through the App Store Connect API from the workflow, because
  EAS CLI will not create a distribution certificate non-interactively.
- `picket.photos` is registered through Netlify, whose registered domains
  can't be delegated elsewhere, so the records live in Netlify DNS and the
  deploy manages them through Netlify's API with a personal access token
  (`infra/scripts/netlify-dns.sh`): `ftp` A (receiver, Let's Encrypt via
  certbot on the instance), the ACM validation CNAME, and `api` CNAME. The
  workflow requests the certificate outside CloudFormation, waits for it to
  validate, then attaches the custom domain, so pending validation never
  stalls a deploy. Without the token the summary lists the records to add by
  hand; if a Route 53 zone for the domain ever appears in the account, the
  same workflow switches to Route 53 mode.

**Consequences.** The camera password, and the receiver's on/off switch, are a
tap in the app. Adding a phone is two buttons. Nothing in the
repo or in GitHub can sign an iOS app or log into Lightroom; the AWS account is
the single trust root.

## ADR-008: Picking stages a photo; sending to Lightroom is a separate, explicit step

**Context.** The first live sessions uploaded every swipe-right to Lightroom
within seconds. That felt wrong in use: a pick during a fast first pass is a
"maybe", not a commitment, and once a photo was in Lightroom it had no place
left in the app (it sat in Picks looking identical to the ones still waiting).
The owner asked for a staged flow: triage fast, look at the picks as a set,
send them in a batch, and have sent photos leave the way.

**Decision.**
- `POST /photos/{id}/decision {pick}` only sets `status = pick`. Nothing is
  queued.
- The Picks tab is a staging area with **Send all to Lightroom** and a
  long-press multi-select (**Send N** / **Skip N**). It calls
  `POST /lightroom/send` (`{photoIds}` or `{all: true}`), which sets
  `lightroomStatus = queued` on picks that are not already queued, uploading or
  delivered. The single-photo route `POST /photos/{id}/lightroom` is the same
  operation for one photo and doubles as the retry for a failed upload and the
  nudge for one stuck on queued.
- A fourth photo status, `sent`, is written by the uploader in the same
  DynamoDB update that records `done` or `duplicate`. Only the uploader writes
  it; the decision route rejects it. The app's tabs are Review (`unreviewed`),
  Picks (`pick`), Sent (`sent`), Skipped (`reject`).
- Picks that were delivered before this change are moved to `sent` lazily the
  first time `GET /photos?status=pick` returns them, instead of a migration run.
- Review became a carousel: left and right browse, a flick up picks, a flick
  down skips. Looking ahead and going back without deciding was the other half
  of the request.

**Consequences.** Uploads happen when the photographer chooses, typically once
per session, so a failed Adobe token refresh surfaces as one visible failure
instead of a day of silent ones. `lightroomStatus` stays sparse (only sent
photos carry it), and the `byLightroomStatus` index now counts only photos
that were actually sent. A photo in Sent is read-only in the app; un-picking
or skipping it would not remove it from Lightroom, so the app does not offer
that.
