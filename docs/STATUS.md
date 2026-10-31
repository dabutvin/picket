# Status and handoff

Last updated: 2026-10-31 03:30Z (end of the first live session). Read this
first; the rest of `docs/` describes the intended system, this file says how
much of it is real.

## In one line

**Camera → receiver → S3 → previews → app works end to end.** Two RAWs shot on
the a7C II tonight appeared in the app's Review tab. The app is paired, the
receiver serves a Let's Encrypt certificate and the camera connects to it over
FTPS. **Not done yet: Connect Lightroom**, and therefore the first swipe into a
Lightroom album. The Adobe account tried tonight has only the free tier
(`entitlement.status = created`, refused by design); the paid account belongs to
Elise, who will be the primary user, and must be added as a beta user first.

## Live values (from deploy run #11)

| output | value |
|---|---|
| `ApiUrl` | `https://api.picket.photos` (custom domain + ACM certificate attached) |
| `FtpHost` / `ReceiverIp` | `ftp.picket.photos` → `32.195.179.86` (Elastic IP, survives instance replacement) |
| `FtpUser` | `camera` (password set from the app's Camera tab; stored in the `ReceiverFtpPassword…` secret) |
| `ReceiverInstanceId` | changes on every replacement; read it from the latest `deploy` or `ops` summary |
| `Bucket` / `Table` | `picket-storagephotos333b189a-fdxlcmdf8lng` / `Picket-StoragePhotosTable7FF827A8-JKR9YJGGIDGW` |
| EAS project | `eb68e542-b0d1-44b5-881f-8df4326d867f` under Expo account `danbutvinik`; bundle id `com.danbut.picket` |

## What ran for real tonight

| part | result |
|---|---|
| `deploy` | 4 successful runs: #8 created the stack and attached `api.picket.photos` (certificate validated in ~4 min); #9–#11 each replaced the receiver after a cloud-init fix (~3 min each) |
| `infra/ingest/cloud-init.sh` | boots cleanly now; Let's Encrypt certificate obtained ~10 s after boot each time |
| `app-build → register-device`, `build` (ios, preview) | worked first time once the Expo owner was fixed: EAS project linked and committed, App Store Connect API signing created the certificate/profile, build installed from the EAS link |
| `ops → pairing-code`, `receiver-logs` | work; `status`, `dns`, `uploader-errors`, `redrive-dlq` not yet exercised |
| pairing | app paired with a one-time code against `https://api.picket.photos` |
| camera → receiver | FTPES, TLSv1.2 ECDHE-ECDSA against the Let's Encrypt certificate, with *Root Certificate Error → Connect* (the stricter *Does Not Connect* is untested) |
| uploads | `DSC04182.ARW` / `DSC04183.ARW` (45 / 46 MB at 4–8 MB/s) reached the receiver; moved to S3 by the sweep timer (the per-shot hook was broken, fixed in #14); preview Lambda, DynamoDB and the app's Review tab all worked |
| Adobe login | PKCE login and the redirect back into the app work; `GET /v2/account` answered; the free account was refused with 403 as intended |
| `services/api`, `services/preview` tests, CI | green on every PR |

## Fixes made tonight

| PR | problem found live | fix |
|---|---|---|
| #8 | `tr … </dev/urandom \| head -c 8` exits 141 under `pipefail`; deploy #8 failed at the pairing step and never printed its summary | `infra/scripts/pairing-code.sh`; the deploy summary now survives a pairing failure |
| #9 | `eas whoami \| tail -n1` returned an account-list line, `eas init` refused it | `expo.owner` in `app/app.json`, passed to `eas init --account` |
| #10 | no way to see the receiver from a phone | `ops → receiver-logs`: health report over Session Manager (`infra/ingest/diagnose.sh`) |
| #11 | pure-ftpd never started: Ubuntu's wrapper wants `Umask` as `137 027`, not `137:027` | one token in cloud-init |
| #12 | login refused: backing account uid 999 < `MinUID 1000` | `ftpcamera` created with uid/gid 1500 |
| #13 | hook failures were silent | report runs the hook as `ftpcamera` with stderr visible |
| #14 | `pure-uploadscript` runs with `PATH=/sbin:/bin:/usr/sbin:/usr/bin`, so `aws` (in `/usr/local/bin`) was not found | hook sets its own PATH and logs the CLI error |

## External accounts and secrets (names only)

- **GitHub repository secrets present**: `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `EXPO_TOKEN`, `APPLE_TEAM_ID`, `ASC_API_KEY_P8`,
  `ASC_KEY_ID`, `ASC_ISSUER_ID`, `NETLIFY_AUTH_TOKEN`. Variables `AWS_REGION`
  and `DOMAIN_NAME` unset (defaults `us-east-1`, `picket.photos`).
- **AWS**: account 798764287578 (the owner switched from the original blocked
  account to an active one). IAM user `Picket` with `AdministratorAccess`,
  region `us-east-1`, CDK bootstrapped. Stack `Picket` is `UPDATE_COMPLETE`.
- **Adobe**: Developer Console project with Lightroom Services, OAuth Native App
  credential in development mode. Client id `5143c127087c4e06ac773b76c4d05f61`,
  redirect URI `adobe+94690ff144227aa43751adfb4cb46fc1432adb0c://adobeid/<clientId>`.
  Beta users: only the owner's free Adobe account so far. **Elise's Adobe
  account (the paid Lightroom plan) must be added as a beta user** before she
  can connect.
- **Apple**: Developer Program membership; Team key with Admin role (it created
  the certificate and profile tonight). Signing material lives in Secrets
  Manager `picket/apple-signing`. One iPhone registered.
- **Expo**: project linked (id above), owner `danbutvinik`.
- **Domain**: `picket.photos` on Netlify DNS. Records managed by `deploy`:
  `ftp` A, ACM validation CNAME, `api` CNAME.
- **The repository is public.** Workflow summaries show pairing codes, and the
  deploy job log echoes `PAIRING_CODE` in its env group. Codes are one-use and
  expire in 30 minutes, but making the repository private is still advised.

## Deploy attempts

| run | result |
|---|---|
| #1–#7 (2026-10-31 00:40–01:46Z) | failed or cancelled before anything useful existed: IAM permissions, apostrophe in a security-group description, Lambda reserved concurrency, EC2 blocked on the first AWS account (see git history of this file) |
| #8 (01:54Z) | **stack created**, certificate issued, `api.picket.photos` attached; failed only at the pairing step (#8) |
| #9 (02:51Z) | receiver replaced with the Umask fix (#11) |
| #10 (03:00Z) | receiver replaced with the uid fix (#12) |
| #11 (03:16Z) | receiver replaced with the hook PATH fix (#14); current instance |

## Next steps, in order

1. **Adobe Developer Console** → the Picket project → add Elise's Adobe email as
   a beta user (the credential is in development mode; only listed users can
   sign in).
2. **Connect Lightroom** as Elise: on the already-paired phone, Settings →
   Connect Lightroom → sign in with her account. Expect *Connected as
   <her email>* and the album name *Picket*. If it still says `status: created`,
   open lightroom.adobe.com or the Lightroom mobile app with her account once
   and retry.
3. If Elise should use **her own iPhone**: `app-build → register-device` (her
   phone), approve, then `app-build → build` again (the profile is regenerated
   with both devices), install from the EAS link, `ops → pairing-code`, pair.
   One API token and one Lightroom connection are shared by every paired phone.
4. **First swipe right.** The Picks tab shows Queued → Uploading → Done; the
   photo should appear in the *Picket* album in Lightroom. If it sticks on
   Failed: `ops → uploader-errors` (415 → set the repository variable
   `LIGHTROOM_RAW_CONTENT_TYPE=application/octet-stream`, `deploy`,
   `ops → redrive-dlq`).
5. Optional hardening: camera *Root Certificate Error → Does Not Connect* to
   test whether the a7C II trusts Let's Encrypt's root.
6. **Let's Encrypt budget**: every receiver replacement issues a new
   certificate for `ftp.picket.photos`; 4 of the 5 allowed per rolling week were
   used tonight (first at 02:01Z Oct 31). Avoid changes to `cloud-init.sh`,
   `upload-to-s3.sh` or `sweep.sh` (all replace the instance) until about
   Nov 7, or accept the self-signed fallback (the obtain-cert timer retries
   every 15 minutes; the camera is not verifying the certificate anyway).

## Operating notes learned tonight

- `ops → receiver-logs` is the first stop for anything camera-side. It shows
  cloud-init, pure-ftpd, the hook's environment, a hook dry run, the sweep,
  the certificate and the journals.
- Any change to the files embedded in user data replaces the instance
  (`userDataCausesReplacement`): ~3 minutes of deploy plus ~2 minutes of
  first boot, during which the camera queues its uploads. Do not test the
  camera inside that window; the errors are misleading.
- The sweep timer (every 5 minutes, files older than 60 s) is the safety net
  for anything the hook misses; it is what delivered tonight's two photos.

## Open questions

- `Content-Type` Lightroom accepts for `.ARW` masters (`image/x-sony-arw`
  default; `LIGHTROOM_RAW_CONTENT_TYPE=application/octet-stream` if 415).
  Still open until the first pick uploads.
- Whether the a7C II trusts Let's Encrypt's root (*Does Not Connect* untested).
- ~~Whether Adobe's `offline_access` scope returns a refresh token~~: the PKCE
  exchange returned tokens the app accepted and the server reached
  `/v2/account` with them; a token refresh has not happened yet.
- ~~Whether the ACM certificate validates within the deploy's wait~~: ~4 min.
- ~~Whether `eas device:list --json` has the expected field names~~: the signing
  step built a working ad hoc profile.
- IAM: `AdministratorAccess` is assumed. A narrower policy was not attempted.

## Things deliberately not built

Cognito/multi-user, the Lightroom API in production mode (needs Adobe
approval), video handling, burst de-duplication, a web build of the review
screen (Netlify could host it), narrower IAM.
