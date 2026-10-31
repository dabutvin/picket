# Status and handoff

Last updated: 2026-10-31 (after deploy run #8). Read this first; the rest of
`docs/` describes the intended system, this file says how much of it is real.

## In one line

**The AWS stack is deployed** (deploy run #8, 2026-10-31 ~02:00Z): bucket,
table, FTPS receiver instance, preview Lambda, HTTP API at
`https://api.picket.photos` with its certificate, Lightroom queue and Lambdas,
and the Netlify DNS records. The run then failed on its last step, issuing the
pairing code (a shell bug, fixed since), so no summary was written and the app
has not been paired. No camera, app or Lightroom step has been exercised yet.

## Live values (from the run #8 stack outputs)

| output | value |
|---|---|
| `ApiUrl` | `https://api.picket.photos` (answers 401 without a token: authorizer is live) |
| `FtpHost` / `ReceiverIp` | `ftp.picket.photos` → `32.195.179.86` (A record created 02:00Z) |
| `FtpUser` | `camera` (password in the `ReceiverFtpPassword…` secret, shown on the app's Camera tab) |
| `ReceiverInstanceId` | `i-0f03cb3e4abe79692` |
| `Bucket` / `Table` | `picket-storagephotos333b189a-fdxlcmdf8lng` / `Picket-StoragePhotosTable7FF827A8-JKR9YJGGIDGW` |
| `ApiDomainTarget` | `d-thqkmpdtdl.execute-api.us-east-1.amazonaws.com` (the `api` CNAME points here) |

## What exists and how it was verified

| part | state | evidence |
|---|---|---|
| `docs/` architecture, 7 ADRs, camera menu guide, operations runbook | written | reviewed against code in the last cleanup pass |
| `infra/` CDK stack (bucket, table, FTPS receiver, preview Lambda, HTTP API + authorizer, Lightroom queue/router/uploader, pairing secret, optional custom domain) | **deployed** | run #8: `CREATE_COMPLETE`, then `UPDATE_COMPLETE` attaching `api.picket.photos` |
| `infra/ingest/cloud-init.sh` (pure-ftpd, upload hook, Let's Encrypt timer, password reload script) | booted once, **unverified** | the instance exists since run #8; nobody has checked that pure-ftpd is up or that the certificate was issued (`ops → status`, then a camera connect) |
| `services/preview` Python Lambda | tested | 6 pytest tests, including a real ILCE-7CM2 ARW (7008×4672 embedded JPEG confirmed) |
| `services/api` (routes, authorizer, pairing, receiver management, Lightroom client, uploader, stream router) | tested | 50 vitest tests; Adobe responses replayed through an injectable fetch, never against Adobe |
| `app/` Expo SDK 58 (Review, Picks, Skipped, Camera, Settings with pairing and Connect Lightroom) | typechecks | `tsc` only; **never run on a device or simulator**, never built with EAS |
| `app/scripts/apple-signing.mjs` (App Store Connect API signing) | self-tested offline | JWT/CSR/PKCS#12 round trip; **no call to Apple has been made** |
| `infra/scripts/netlify-dns.sh` | works | run #8 created the `ftp` A record and the ACM validation CNAME; the `api` CNAME followed |
| `infra/scripts/pairing-code.sh` | tested offline | 500 generated codes matched `XXXX-XXXX` over the 32-symbol alphabet; the AWS write was faked |
| GitHub Actions `ci` | green on `main` | runs synth, tests, typechecks |
| GitHub Actions `deploy` | works through the DNS step | 8 runs (below); the pairing step's `tr … \| head` broke under `pipefail` and is replaced by the script |
| GitHub Actions `ops`, `app-build` | YAML-valid | **never run** (`ops → pairing-code` had the same pairing bug, fixed with it) |

## External accounts and secrets (names only)

- **GitHub repository secrets present** (per the owner): `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `EXPO_TOKEN`, `APPLE_TEAM_ID`, `ASC_API_KEY_P8`,
  `ASC_KEY_ID`, `ASC_ISSUER_ID`, `NETLIFY_AUTH_TOKEN`. Variables `AWS_REGION`
  and `DOMAIN_NAME` are unset (defaults `us-east-1`, `picket.photos`).
- **AWS**: the run #8 stack ARN is in account 798764287578 (the kick-off notes
  said 940392916059; the credentials in the repository secrets decide). IAM
  user `Picket` with `AdministratorAccess`, region `us-east-1`, CDK
  bootstrapped. The EC2 account-verification block seen in runs #5 and #6 is
  gone: run #8 created the receiver instance. The `Picket` stack is in
  `UPDATE_COMPLETE`.
- **Adobe**: Developer Console project with Lightroom Services, OAuth Native App
  credential in development mode, the Lightroom account added as a beta user.
  Client id, redirect URI (`adobe+94690ff144227aa43751adfb4cb46fc1432adb0c://adobeid/<clientId>`)
  and scopes are the defaults in `infra/bin/picket.ts` and `app/app.json`.
- **Apple**: Developer Program membership and an App Store Connect Team key
  exist (per the owner). Role should be Admin; unverified.
- **Expo**: account and access token exist. **No EAS project yet**; the first
  `app-build` run creates it and commits the id into `app/app.json`.
- **Domain**: `picket.photos` registered through Netlify; DNS is Netlify DNS.
  No records exist yet. No Route 53 zone exists (the first run tried to create
  one and was denied; the workflow no longer creates zones).
- **The repository is public.** Workflow summaries (which print pairing codes)
  are therefore public too; the owner was advised to make it private.

## Deploy attempts

| run | result | cause | fixed by |
|---|---|---|---|
| #1 (2026-10-31 00:40Z) | failed in "Resolve DNS zone" | `aws route53 list-hosted-zones-by-name` denied; error text was swallowed by a `2>/dev/null` | PR #3: external-DNS mode, Route 53 optional, errors surfaced |
| #2 (2026-10-31 00:58Z) | failed in `cdk bootstrap` | `User Picket is not authorized to perform cloudformation:DescribeStacks` | owner attached `AdministratorAccess` |
| #3 (2026-10-31 01:08Z) | bootstrap OK; stack rolled back at resource 29/86 | EC2 rejects an apostrophe in a security group rule description (`Let's Encrypt…`) | PR #5 |
| #4 (2026-10-31 01:17Z) | rolled back creating the Lightroom uploader | account Lambda quota too small for `ReservedConcurrentExecutions: 1` | PR #6 (SQS `maxConcurrency: 2` instead) |
| #5 (2026-10-31 01:25Z) | rolled back creating the EC2 receiver, after everything else created | EC2: "This account is currently blocked and not recognized as a valid account" (new-account verification hold) | owner action with AWS; receiver made optional (`receiver=false` deploys the rest) |
| #6 (2026-10-31 01:36Z) | same rollback at the receiver | same EC2 block | owner action with AWS |
| #7 (2026-10-31 01:46Z) | cancelled by the owner | | |
| #8 (2026-10-31 01:54Z) | **stack created** in ~4 min, Netlify records written, certificate `ISSUED` after ~4 min, `api.picket.photos` attached by the second `cdk deploy`; then **failed in "Issue an app pairing code"** | `tr -dc … </dev/urandom \| head -c 8` exits 141 (SIGPIPE) under `set -o pipefail`; the Summary step was skipped, so the outputs and code were never shown | `infra/scripts/pairing-code.sh` (byte-wise, no pipeline); Summary now runs even if pairing fails |

## Next steps, in order

1. Get a pairing code: `ops → pairing-code` (fast), or run `deploy` again
   (idempotent, ~6 min, and it prints the full summary with every output).
   The code is valid 30 minutes and once; the app's Settings screen takes
   `https://api.picket.photos` plus the code.
2. Check the receiver: `ops → status` should show the instance `running`.
   `cloud-init.sh` had never booted before run #8, so expect a shakedown: if
   the camera can't connect, use Session Manager on `i-0f03cb3e4abe79692` and
   `journalctl -t picket -t picket-upload`, and check that the Let's Encrypt
   timer issued a certificate for `ftp.picket.photos` (needs port 80 reachable
   and the A record, which exists since 02:00Z).
3. `app-build → register-device`, enroll the iPhone via the EAS link, approve.
4. `app-build → build` (ios, preview). First run links the EAS project, then
   the signing script makes its first real Apple calls (certificate, bundle id,
   device, profile). Watch for: certificate limit (2 per team), device not yet
   accepted by Apple (up to 72 h on new memberships), key role not Admin.
5. Install the build from the EAS link. Settings → API URL + pairing code →
   Pair. Camera tab → set a password → configure the camera per
   `docs/CAMERA_SETUP.md`. Settings → Connect Lightroom.
6. First round trip: shoot RAW, see it in Review, swipe right, confirm it lands
   in the "Picket" album in Lightroom.

## Open questions only a live run can answer

- `Content-Type` Lightroom accepts for `.ARW` masters (`image/x-sony-arw`
  default; `LIGHTROOM_RAW_CONTENT_TYPE=application/octet-stream` if 415).
- Whether the a7C II trusts Let's Encrypt's root (else *Root Certificate Error
  → Connect*).
- Whether Adobe's `offline_access` scope returns a refresh token on the PKCE
  exchange from a Native App credential (the app errors clearly if not).
- ~~Whether the ACM certificate validates within the deploy's 12-minute wait~~
  It did, in about 4 minutes (run #8).
- Whether `eas device:list --json` has the field names the signing script
  expects (`identifier`/`udid`, `name`); it reads both.
- IAM: `AdministratorAccess` is assumed. A narrower policy was not attempted.

## Things deliberately not built

Cognito/multi-user, the Lightroom API in production mode (needs Adobe
approval), video handling, burst de-duplication, a web build of the review
screen (Netlify could host it), narrower IAM.
