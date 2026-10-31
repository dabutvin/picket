# Status and handoff

Last updated: 2026-10-31 04:05Z, end of the first live session. **Read this
first.** The rest of `docs/` describes the intended system; this file says how
much of it is real, what to do next, and how the previous agent operated it.

## In one line

**Everything up to Lightroom works and is deployed.** Shots from the a7C II
reach the receiver over FTPS, land in S3, get previews, and appear in the app's
Review tab. The app is paired, installed both ad hoc and through **TestFlight**
(build 2 is in TestFlight). **Not done: Connect Lightroom and the first swipe.**
The Adobe account tried has only the free tier (`entitlement.status = created`,
refused by design). Elise owns the paid Lightroom plan and will be the primary
user; her Adobe account must be added as a beta user first.

## Resume here (next steps, in order)

1. **Adobe Developer Console** → the Picket project → user settings → add
   Elise's Adobe email as a **beta user**. The OAuth credential is in
   development mode; only listed accounts can sign in. Until this is done her
   login fails before it reaches our server.
2. **Get Picket onto Elise's iPhone through TestFlight** (no device
   registration needed): App Store Connect → Users and Access → invite her
   Apple ID (any role); App Store Connect → Picket → TestFlight → Internal
   Testing → create a group if none exists, add her (and Dan). She installs
   the TestFlight app, accepts, installs Picket. Then `ops → pairing-code`,
   and on her phone Settings → `https://api.picket.photos` + the code → Pair.
   Every paired phone shares one API token, one Lightroom connection and the
   same photos.
3. **Connect Lightroom** as Elise: Settings → Connect Lightroom → sign in with
   her account. Expect *Connected as <her email>* and album *Picket*. If it
   still says `status: created`, open lightroom.adobe.com or the Lightroom
   mobile app with her account once (the cloud catalog may never have been
   provisioned if she only used Lightroom Classic), then retry.
4. **First swipe right.** Picks tab: Queued → Uploading → Done; the photo
   should appear in a *Picket* album in her Lightroom. If it ends up Failed:
   `ops → uploader-errors`. A 415 means set the repository variable
   `LIGHTROOM_RAW_CONTENT_TYPE=application/octet-stream`, run `deploy`, then
   `ops → redrive-dlq`. A 403 means reconnect Lightroom.
5. **Prove the per-shot upload path**: take one photo and confirm it shows in
   Review within ~30 s. The hook fix (#14) is deployed but was never seen
   working on a real shot; tonight's two photos went through the 5-minute
   sweep instead.
6. Optional: camera *Root Certificate Error → Does Not Connect* to learn
   whether the a7C II trusts Let's Encrypt's root (it connected fine with
   *Connect*).

## Live values

| output | value |
|---|---|
| `ApiUrl` | `https://api.picket.photos` (custom domain + ACM certificate) |
| `FtpHost` / `ReceiverIp` | `ftp.picket.photos` → `32.195.179.86` (Elastic IP, survives instance replacement) |
| `FtpUser` | `camera`; password set from the app's Camera tab, stored in the `ReceiverFtpPassword…` secret |
| `ReceiverInstanceId` | `i-0655430efda5208f1` (changes on every replacement; the latest `deploy`/`ops` summary is authoritative) |
| `Bucket` / `Table` | `picket-storagephotos333b189a-fdxlcmdf8lng` / `Picket-StoragePhotosTable7FF827A8-JKR9YJGGIDGW` |
| EAS project | `eb68e542-b0d1-44b5-881f-8df4326d867f`, Expo account `danbutvinik`, bundle id `com.danbut.picket` |
| App Store Connect app | id `6829118006`; TestFlight build 2 (EAS build `53110fc8…`) processed and installable |
| Photos in the system | `DSC04182.ARW`, `DSC04183.ARW` (unreviewed) |

## What ran for real on 2026-10-31

| part | result |
|---|---|
| `deploy` | 5 successful runs: #8 created the stack and attached `api.picket.photos` (certificate validated in ~4 min); #9–#11 replaced the receiver after cloud-init fixes; #12 updated only the API Lambda |
| `infra/ingest/cloud-init.sh` | boots cleanly; Let's Encrypt certificate ~10 s after boot |
| `app-build → register-device`, `build` (preview) | worked once the Expo owner was fixed; ad hoc build installed from the EAS link |
| `app-build → build` (production, ios) | App Store profile, app-id lookup, `eas build --auto-submit`; **TestFlight install confirmed by the owner** |
| `ops → pairing-code`, `receiver-logs` | work; `status`, `dns`, `uploader-errors`, `redrive-dlq`, `reload-ftp-password`, receiver start/stop not yet exercised |
| pairing | one-time code against `https://api.picket.photos` |
| camera → receiver | FTPES, TLSv1.2 ECDHE-ECDSA against the Let's Encrypt certificate, *Root Certificate Error → Connect* |
| uploads | 45 / 46 MB RAWs at 4–8 MB/s; moved to S3 by the sweep timer (hook was broken, fixed in #14); preview Lambda, DynamoDB, app Review all worked |
| Adobe login | PKCE login and redirect back into the app work; `GET /v2/account` answered; free account refused with 403 as intended |
| CI (`services/api` 51 tests, `services/preview`, `cdk synth`, app typecheck) | green on every PR |

## Fixes and features merged tonight (PRs #8–#16)

| PR | found live | change |
|---|---|---|
| #8 | `tr … \| head` exits 141 under `pipefail`; deploy #8 failed at the pairing step with no summary | `infra/scripts/pairing-code.sh`; summary survives a pairing failure |
| #9 | `eas whoami \| tail -n1` returned an account-list line | `expo.owner` in `app/app.json` |
| #10 | no way to see the receiver from a phone | `ops → receiver-logs` (`infra/ingest/diagnose.sh` over Session Manager) |
| #11 | pure-ftpd never started: Umask must be `137 027` | one token in cloud-init |
| #12 | login refused: backing account uid 999 < `MinUID 1000` | `ftpcamera` uid/gid 1500 |
| #13 | hook failures were silent | report runs the hook as `ftpcamera` with stderr visible |
| #14 | `pure-uploadscript` PATH lacks `/usr/local/bin`, so `aws` not found | hook sets PATH, logs the CLI error |
| #15 | handoff; unentitled-account message | STATUS.md; clearer 403 text; report fallback uses the real hook |
| #16 | no TestFlight path | production ios builds auto-submit; `apple-signing.mjs app-id` / `write-p8`; export-compliance key; docs |

## External accounts and secrets (names only)

- **GitHub secrets**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `EXPO_TOKEN`,
  `APPLE_TEAM_ID`, `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`,
  `NETLIFY_AUTH_TOKEN`. Variables `AWS_REGION`, `DOMAIN_NAME` unset
  (defaults `us-east-1`, `picket.photos`).
- **AWS**: account 798764287578 (the owner switched from the original blocked
  account). IAM user `Picket`, `AdministratorAccess`, `us-east-1`, CDK
  bootstrapped. Stack `Picket` is `UPDATE_COMPLETE`.
- **Adobe**: Developer Console project, Lightroom Services, OAuth Native App
  credential in development mode. Client id `5143c127087c4e06ac773b76c4d05f61`,
  redirect URI `adobe+94690ff144227aa43751adfb4cb46fc1432adb0c://adobeid/<clientId>`.
  Beta users: only Dan's free account so far. **Add Elise.**
- **Apple**: Developer Program; Team key with Admin role; signing material in
  Secrets Manager `picket/apple-signing` (the state tracks one profile and
  regenerates it when switching between ad hoc and App Store; harmless). App
  Store Connect app record exists (id above). One iPhone registered for ad hoc.
- **Expo**: project linked, owner `danbutvinik`. EAS stores the ASC API key
  uploaded for submissions.
- **Domain**: `picket.photos` on Netlify DNS; `deploy` manages `ftp` A, the
  ACM validation CNAME and the `api` CNAME.
- **The repository is public.** Workflow summaries show pairing codes and the
  deploy job log echoes `PAIRING_CODE` in its env group. Codes are one-use and
  expire in 30 minutes; making the repository private is still advised.

## For the next agent: how this was operated

- **Everything runs through GitHub Actions** (`deploy`, `ops`, `app-build`,
  all `workflow_dispatch`). Trigger them and read job logs through the GitHub
  tooling; the cloud session has no AWS, Expo or Apple credentials of its own
  and cannot reach port 21 (only 443 is open outbound).
- **Step summaries are not readable through the API.** Anything you need to
  read must be in the job log. The receiver report, CDK events and `eas`
  output are; the pairing code is only in the summary (and, incidentally, the
  env group of the deploy log).
- **`ops → receiver-logs` is the first stop** for anything camera-side:
  cloud-init, pure-ftpd state/config/journal, the hook's environment, a hook
  dry run with stderr, the sweep, the certificate.
- **Any change to `cloud-init.sh`, `upload-to-s3.sh` or `sweep.sh` replaces
  the instance** (`userDataCausesReplacement`): ~3 min deploy + ~2 min first
  boot, during which the camera queues uploads and shows misleading errors.
  `diagnose.sh` is sent over SSM at run time and does **not** replace it.
- **Let's Encrypt budget**: each replacement issues a certificate for
  `ftp.picket.photos`; **4 of the 5 allowed per rolling week were used on
  Oct 31 (02:01, 02:54, 03:04, 03:19Z)**. One replacement remains before
  ~Nov 7; beyond that the receiver serves its self-signed certificate and the
  obtain-cert timer retries every 15 min (the camera is not verifying anyway).
- **Conventions used**: one PR per fix, squash-merged with the PR title +
  `(#N)`, commit body explaining the live failure; CI must be green; the
  owner authorized merging during the walkthrough. Branch names
  `fix/…`, `ops/…`, `docs/…`, `feat/…`.
- **Camera settings in use**: Secure Protocol On, Passive On, Root Certificate
  Error → Connect, port 21, user `camera`, Auto FTP Transfer On, RAW only.

## Open questions

- `Content-Type` Lightroom accepts for `.ARW` masters (`image/x-sony-arw`
  default; `application/octet-stream` via `LIGHTROOM_RAW_CONTENT_TYPE` if 415).
  Open until the first pick uploads.
- Whether the a7C II trusts Let's Encrypt's root (*Does Not Connect* untested).
- Whether a Lightroom token refresh works (`offline_access`): the PKCE
  exchange returned tokens the server could use, but no refresh has happened.
- ~~ACM validation time~~ (~4 min). ~~`eas device:list` field names~~ (ad hoc
  build worked). ~~TestFlight submission~~ (worked first time).
- IAM: `AdministratorAccess` is assumed; a narrower policy was not attempted.

## Things deliberately not built

Cognito/multi-user, the Lightroom API in production mode (needs Adobe
approval), video handling, burst de-duplication, a web build of the review
screen (Netlify could host it), narrower IAM, automatic TestFlight group
creation (needs an Apple ID login, not the API key).
