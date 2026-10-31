# Status and handoff

Last updated: 2026-10-31 (end of the kick-off sessions). Read this first; the
rest of `docs/` describes the intended system, this file says how much of it is
real.

## In one line

All code, infrastructure definitions and workflows exist and pass their checks,
but **nothing has been deployed yet**: both `deploy` runs failed before creating
anything because the AWS IAM user has no permissions. No camera, app, Lightroom
or DNS step has been exercised against a live system.

## What exists and how it was verified

| part | state | evidence |
|---|---|---|
| `docs/` architecture, 7 ADRs, camera menu guide, operations runbook | written | reviewed against code in the last cleanup pass |
| `infra/` CDK stack (bucket, table, FTPS receiver, preview Lambda, HTTP API + authorizer, Lightroom queue/router/uploader, pairing secret, optional custom domain) | synthesizes | `cdk synth` in all four DNS modes, in CI on every PR |
| `infra/ingest/cloud-init.sh` (pure-ftpd, upload hook, Let's Encrypt timer, password reload script) | **never booted** | shell-reviewed only; expect a shakedown on the first real instance |
| `services/preview` Python Lambda | tested | 6 pytest tests, including a real ILCE-7CM2 ARW (7008×4672 embedded JPEG confirmed) |
| `services/api` (routes, authorizer, pairing, receiver management, Lightroom client, uploader, stream router) | tested | 50 vitest tests; Adobe responses replayed through an injectable fetch, never against Adobe |
| `app/` Expo SDK 58 (Review, Picks, Skipped, Camera, Settings with pairing and Connect Lightroom) | typechecks | `tsc` only; **never run on a device or simulator**, never built with EAS |
| `app/scripts/apple-signing.mjs` (App Store Connect API signing) | self-tested offline | JWT/CSR/PKCS#12 round trip; **no call to Apple has been made** |
| `infra/scripts/netlify-dns.sh` | syntax-checked | `bash -n`; **no call to Netlify has been made** |
| GitHub Actions `ci` | green on `main` | runs synth, tests, typechecks |
| GitHub Actions `deploy`, `ops`, `app-build` | YAML-valid | `deploy` ran twice and failed (below); `ops` and `app-build` have never run |

## External accounts and secrets (names only)

- **GitHub repository secrets present** (per the owner): `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `EXPO_TOKEN`, `APPLE_TEAM_ID`, `ASC_API_KEY_P8`,
  `ASC_KEY_ID`, `ASC_ISSUER_ID`, `NETLIFY_AUTH_TOKEN`. Variables `AWS_REGION`
  and `DOMAIN_NAME` are unset (defaults `us-east-1`, `picket.photos`).
- **AWS**: account 940392916059, IAM user `Picket`. As of the last run it has
  **no policies attached**; the owner was asked to attach `AdministratorAccess`.
  Region `us-east-1`. CDK is **not bootstrapped**.
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
| #2 (2026-10-31 00:58Z) | failed in `cdk bootstrap` | `User Picket is not authorized to perform cloudformation:DescribeStacks` | needs an IAM policy on the user (owner action), not a code change |

## Next steps, in order

1. Owner attaches `AdministratorAccess` to IAM user `Picket`.
2. Run `deploy`. Expect: CDK bootstrap, stack creation (~10 min), Netlify
   records (`ftp` A, ACM validation CNAME), a wait for the certificate, a
   second `cdk deploy` attaching `api.picket.photos`, the `api` CNAME, and a
   pairing code in the summary. Watch for first-run surprises in
   `cloud-init.sh` (never booted): check with `ops → status` and, if the camera
   can't connect after ~5 minutes, Session Manager on the instance and
   `journalctl -t picket -t picket-upload`.
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
- Whether the ACM certificate validates within the deploy's 12-minute wait
  (if not, a later `deploy` attaches the domain).
- Whether `eas device:list --json` has the field names the signing script
  expects (`identifier`/`udid`, `name`); it reads both.
- IAM: `AdministratorAccess` is assumed. A narrower policy was not attempted.

## Things deliberately not built

Cognito/multi-user, the Lightroom API in production mode (needs Adobe
approval), video handling, burst de-duplication, a web build of the review
screen (Netlify could host it), narrower IAM.
