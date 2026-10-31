# Status and handoff

Last updated: 2026-10-31, after the send-to-Lightroom / carousel change (#25)
and the UI preview workflow (#26). **Read this first.** The rest of `docs/` describes the intended system; this file says what
is real, what to do next, and how the previous agents operated it.

## In one line

**The whole loop works end to end.** Shots from the a7C II reach the receiver
over FTPS, land in S3, get previews, appear in the app's Review tab, and a pick
sent from the Picks tab puts the RAW into the *Picket* album of Elise's Lightroom cloud catalog
(first pick showed **In Lightroom** at ~13:07Z after #20 and #21). Elise's paid
Adobe account is the connected one. The app is installed both ad hoc and via
TestFlight. The system is in normal use; what follows is upkeep and polish.

## Resume here

0. ~~Deploy and build #25~~ Done 2026-10-31 17:24Z: `deploy` #16 (Lambda
   only) and `app-build` #7 → EAS build 3 → TestFlight, auto-submitted. The
   app now has a Review carousel (left/right browse, flick up = pick, flick
   down = skip), picks wait on the Picks tab until **Send all to Lightroom**
   (or a long-press selection), and sent photos move to a Sent tab. Picks
   delivered before #25 move to Sent the first time the Picks tab loads.
   **Not yet felt on a phone**: the carousel's flick threshold (22% of screen
   height or a fast fling) and whether a diagonal swipe ever stalls; ask the
   owner after they try build 3. #26 (sample-photos mode, UI preview comment
   on PRs) needs no deploy; the sample mode ships with the next `app-build`.
1. ~~Run the photo-id migration~~ Done 2026-10-31 16:22Z (`ops` run 13,
   confirm=`migrate`): 642 rows, 526 moved to the frame-based id, 116 already
   current, no merges, no skips. Camera re-sends are now safe on any day
   (*FTP Transfer → Transfer Status → Only Failed Transfer*).
2. **Watch the first Lightroom token refresh.** Adobe access tokens expire
   after about a day; the uploader refreshes with the stored refresh token on
   its next pick. A pick failing with a 403 tomorrow means the refresh path
   needs a look (`ops → lightroom-debug` shows the uploader's error; Settings →
   Disconnect / Connect Lightroom as Elise is the manual recovery).
3. **Make the repository private.** Workflow summaries show pairing codes and
   the deploy log echoes `PAIRING_CODE`; codes are one-use and 30-minute, but
   there is no reason to publish them.
4. **Let's Encrypt budget**: 4 of 5 weekly issuances for `ftp.picket.photos`
   were used on Oct 31 (02:01, 02:54, 03:04, 03:19Z); the window clears around
   Nov 7. Until then avoid changes to `cloud-init.sh`, `upload-to-s3.sh` or
   `sweep.sh` (each replaces the receiver and issues a certificate), or accept
   the self-signed fallback (the camera is not verifying anyway).
5. **Elise's own phone**, if not done: App Store Connect → Users and Access →
   invite her Apple ID; Picket → TestFlight → Internal Testing → add her; she
   installs from the TestFlight app; `ops → pairing-code`; pair. All phones
   share one API token, one Lightroom connection, the same photos.
6. Optional camera hardening: *Root Certificate Error → Does Not Connect* to
   learn whether the a7C II trusts Let's Encrypt's root.
7. Ops polish (small, when convenient): `ops → status` and `uploader-errors`
   write only to the step summary (unreadable through the API; use
   `lightroom-debug` or `tee` them); `lightroom-debug`'s photo rows show
   `null` for file/status/lightroom because the `byLightroomStatus` index is
   `KEYS_ONLY` (follow with a `GetItem` per photoId); `ReceiverInstanceId`
   in this file goes stale on every replacement, the deploy summary is
   authoritative.

## Live values

| output | value |
|---|---|
| `ApiUrl` | `https://api.picket.photos` (custom domain + ACM certificate) |
| `FtpHost` / `ReceiverIp` | `ftp.picket.photos` → `32.195.179.86` (Elastic IP, survives instance replacement) |
| `FtpUser` | `camera`; password set from the app's Camera tab, stored in the `ReceiverFtpPassword…` secret |
| `ReceiverInstanceId` | `i-0655430efda5208f1` (since deploy #11; changes on every replacement) |
| `Bucket` / `Table` | `picket-storagephotos333b189a-fdxlcmdf8lng` / `Picket-StoragePhotosTable7FF827A8-JKR9YJGGIDGW` |
| Upload queue / DLQ | outputs `UploadQueueUrl` / `LightroomUploadDlqUrlE37DE845` (CDK-suffixed key; ops resolves it by prefix) |
| EAS project | `eb68e542-b0d1-44b5-881f-8df4326d867f`, Expo account `danbutvinik`, bundle id `com.danbut.picket` |
| App Store Connect app | id `6829118006`; TestFlight build 2 installed |
| Lightroom | connected as Elise's paid account; album *Picket*; RAW masters sent as `application/octet-stream` |

## What ran for real

| part | result |
|---|---|
| `deploy` | 15 runs. #8 created the stack; #9–#11 replaced the receiver after cloud-init fixes; #12–#15 updated Lambdas only (~2 min, no receiver impact) |
| `infra/ingest/cloud-init.sh` | boots cleanly; Let's Encrypt certificate ~10 s after boot |
| `app-build` register-device / build preview / build production | all worked: ad hoc install from the EAS link; TestFlight via `--auto-submit` with the App Store Connect app looked up by bundle id (builds 2 and 3) |
| `ui-preview` | first run on #26: web export + 10 screenshots in ~2 min, comment posted, images load from the `ui-previews` branch |
| `ops` | `pairing-code`, `receiver-logs`, `lightroom-debug`, `migrate-photo-ids` (dry run + apply) used and working; `status`, `dns`, `uploader-errors`, `redrive-dlq`, `reload-ftp-password`, receiver start/stop not yet exercised |
| camera → receiver | FTPES, TLSv1.2 against the Let's Encrypt certificate, *Root Certificate Error → Connect*; uploads 45–46 MB at 4–8 MB/s. An 800-photo card dump ran at ~4 MB/s (the t4g.nano network baseline, 0.032 Gbps) until the camera battery died; the owner chose to keep the nano and send incrementally |
| receiver → S3 → previews → app | per-shot hook works since #14 (the first two photos went through the 5-minute sweep instead) |
| Lightroom | login/redirect as Elise, `/v2/account` entitled, catalog found, master upload accepted as octet-stream, album *Picket*, pick status **In Lightroom** |
| CI | 53 API tests, preview tests, `cdk synth`, app typecheck: green on every PR |

## Fixes and features, by PR

| PR | found live | change |
|---|---|---|
| #8 | `tr … \| head` exits 141 under `pipefail`; deploy #8 lost its summary | `infra/scripts/pairing-code.sh`; summary survives a pairing failure |
| #9 | `eas whoami \| tail -n1` returned an account-list line | `expo.owner` in `app/app.json` |
| #10 | no way to see the receiver from a phone | `ops → receiver-logs` (`infra/ingest/diagnose.sh` over Session Manager) |
| #11 | pure-ftpd never started: Umask must be `137 027` | one token in cloud-init |
| #12 | login refused: backing account uid 999 < `MinUID 1000` | `ftpcamera` uid/gid 1500 |
| #13 | hook failures were silent | report runs the hook as `ftpcamera` with stderr visible |
| #14 | `pure-uploadscript` PATH lacks `/usr/local/bin` | hook sets PATH and logs the CLI error |
| #15, #17 | handoff | STATUS.md; clearer unentitled-account error; report fallback uses the real hook |
| #16 | no TestFlight path | production ios builds auto-submit; `apple-signing.mjs app-id` / `write-p8`; export-compliance key |
| #18 | pick stuck on Queued, nothing readable | `ops → lightroom-debug`: queues, photos by status, router + uploader logs, DLQ peek |
| #19 | DLQ stack output is `LightroomUploadDlqUrlE37DE845` | ops resolves CDK-suffixed output keys; debug step tolerates failing calls |
| #20 | uploader's first write: DynamoDB "ExpressionAttributeNames must not be empty" | update helper omits the empty map; regression test against the real store |
| #21 | Adobe 415 `InvalidContentTypeError` on `image/x-sony-arw` | ARW masters sent as `application/octet-stream` |
| #23 | a frame re-sent on a later day became a second row (id was the S3 key, which carries the upload date) | id = file name + EXIF capture time; `ops → migrate-photo-ids` moved the 526 existing rows (applied 16:22Z) |
| #25 | every swipe right uploaded at once; sent photos lingered in Picks | picking only stages; Picks tab sends in a batch (`POST /lightroom/send`); uploader marks `status = sent`; Sent tab; Review is a carousel (ADR-008) |
| #26 | UI changes could only be judged after a TestFlight build | sample-photos mode (`app/src/lib/demo.ts`); `ui-preview` workflow screenshots every screen on PRs touching `app/` |
| #28 | no way to move around a long review queue except one swipe at a time | **▦ Jump to** on the Review header: grid of the queue by capture day, tap to jump the carousel there (`app/src/components/QueueGrid.tsx`) |
| #29 | Picks / Sent / Skipped were one flat grid | grouped under collapsible capture-day headers (collapsed state kept across tab switches); in Select mode a header's circle takes the whole day; Picks headers show "N sending · N failed" |

## External accounts and secrets (names only)

- **GitHub secrets**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `EXPO_TOKEN`,
  `APPLE_TEAM_ID`, `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`,
  `NETLIFY_AUTH_TOKEN`. Variables `AWS_REGION`, `DOMAIN_NAME` unset.
- **AWS**: account 798764287578, IAM user `Picket` (`AdministratorAccess`),
  `us-east-1`, stack `Picket` `UPDATE_COMPLETE`.
- **Adobe**: Developer Console project, Lightroom Services, OAuth Native App
  credential in development mode (client id `5143c127087c4e06ac773b76c4d05f61`).
  Beta users: Dan's free account and Elise's paid account. The server holds
  one Lightroom connection (Elise's); refresh tokens live in the
  `LightroomConnection…` secret.
- **Apple**: Developer Program; Team key (Admin); signing material in Secrets
  Manager `picket/apple-signing` (one profile tracked; switching between
  preview and production regenerates it); App Store Connect app `6829118006`.
- **Expo**: project linked, owner `danbutvinik`; EAS holds the ASC key for
  submissions.
- **Domain**: `picket.photos` on Netlify DNS; `deploy` manages `ftp` A, the ACM
  validation CNAME and the `api` CNAME.
- **The repository is public** (see Resume here, item 2).

## For the next agent: how this was operated

- **Everything runs through GitHub Actions** (`deploy`, `ops`, `app-build`,
  all `workflow_dispatch`). Trigger them and read job logs through the GitHub
  tooling; the cloud session has no AWS, Expo or Apple credentials and cannot
  reach port 21 (only 443 outbound).
- **Step summaries are not readable through the API.** Anything you need to
  read must be in the job log. The pairing code is only in the summary (and the
  deploy log's env group).
- **First stops**: camera-side → `ops → receiver-logs`; pick-side →
  `ops → lightroom-debug`. Since #25 nothing uploads until **Send to
  Lightroom** is tapped on the Picks tab, so "my pick is not in Lightroom"
  first means "was it sent" (the Picks tab shows Queued/Sending/Failed per
  photo). A pick stuck on *Queued* means the uploader never
  reached its first status write (**Send again** in its detail view nudges it); *Failed* carries Adobe's error text in the
  app (tap **Retry upload** after a fix); six failures send it to the DLQ
  (`ops → redrive-dlq`).
- **Any change to `cloud-init.sh`, `upload-to-s3.sh` or `sweep.sh` replaces
  the instance** (~3 min deploy + ~2 min boot, camera uploads queue meanwhile,
  one Let's Encrypt issuance). `diagnose.sh` is sent over SSM at run time and
  does not. Lambda-only changes deploy in ~2 minutes with no side effects.
- **Conventions**: one PR per fix, squash-merged as "title (#N)", commit body
  stating the live failure; CI green first; the owner authorized merging during
  these sessions. Branches `fix/…`, `ops/…`, `docs/…`, `feat/…`.
- **UI work has its own loop; read `app/AGENTS.md` ("Picket: how UI work is
  done here") before touching `app/src/`.** In short: build against the
  sample photos (`app/src/lib/demo.ts`), export the web build and run
  `app/scripts/ui-screenshots.mjs` in the session, look at the PNGs yourself,
  extend the script for every new screen or state, then read the PR's
  **UI preview** comment (posted by `.github/workflows/ui-preview.yml` on any
  PR touching `app/`). Gestures can only be felt on a phone: say so in the PR
  and ship to TestFlight after merging (`deploy` if the API changed, then
  `app-build` production ios). The preview images are raw URLs on the
  `ui-previews` branch and stop rendering in comments if the repository goes
  private (the `ui-screenshots` artifact on the run still has them).
- **Harmless leftovers in S3** from the interrupted card dump on Oct 31:
  `session.db` (the camera's FTP bookkeeping file, not a photo) and a
  truncated `DSC03799.ARW` (6.8 MB, the file in flight when the battery died;
  a re-send replaces it as the row's `rawKey`). Earlier uploads of re-sent
  frames also stay in S3 unreferenced. Nothing cleans these up yet.
- **Camera settings in use**: Secure Protocol On, Passive On, Root Certificate
  Error → Connect, port 21, user `camera`, Auto FTP Transfer On, RAW only.

## Open questions

- Whether the a7C II trusts Let's Encrypt's root (*Does Not Connect* untested).
- Whether the Lightroom token refresh works unattended (first refresh due
  within ~24 h of the 2026-10-31 connection).
- ~~ARW content type~~ (`application/octet-stream`, #21). ~~ACM validation
  time~~ (~4 min). ~~`eas device:list` fields~~ (worked). ~~TestFlight
  submission~~ (worked). ~~Per-shot upload hook~~ (works since #14).
- IAM: `AdministratorAccess` is assumed; a narrower policy was not attempted.

## Things deliberately not built

Cognito/multi-user, the Lightroom API in production mode (needs Adobe
approval), video handling, burst de-duplication, a web build of the review
screen (Netlify could host it), narrower IAM, automatic TestFlight group
creation (needs an Apple ID login, not the API key).
