# Operating Picket from a phone

Nothing in this project needs a terminal. Every action is a **Run workflow**
button in the GitHub app (Actions tab), and every result is written to the run's
summary page. Credentials live in the repository's Actions secrets.

## Where secrets live

GitHub holds the credentials the workflows need (AWS, Expo, Apple). The app
pairs with the API through a one-time code that the deploy (or `ops →
pairing-code`) prints; nobody ever sees or types the token itself. Camera
settings are not secrets you manage anywhere: the app's **Camera** tab shows
them, rotates the password and starts or stops the receiver.

### GitHub (Settings → Secrets and variables → Actions)

| name | kind | what it is |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secret | An IAM user's access key. Simplest: IAM → Users → Create user → attach `AdministratorAccess` → Create access key. |
| `AWS_DEPLOY_ROLE_ARN` | secret, optional | Instead of keys: an IAM role trusting GitHub's OIDC provider for `repo:dabutvin/picket:*`. |
| `EXPO_TOKEN` | secret | expo.dev → account → Access tokens. |
| `APPLE_TEAM_ID` | secret | developer.apple.com → Membership details (10 characters). |
| `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | secret | An App Store Connect **Team** API key with the **Admin** role: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate. Paste the whole `.p8` file contents into `ASC_API_KEY_P8` (raw, `\n`-escaped or base64 all work); the Key ID is on that row, the Issuer ID at the top of the page. |
| `NETLIFY_AUTH_TOKEN` | secret | Netlify → User settings → Applications → Personal access tokens. Lets `deploy` and `ops → dns` manage the DNS records for the domain. Without it the summary lists the records to add by hand. |
| `AWS_REGION` | variable, optional | Defaults to `us-east-1`. |
| `DOMAIN_NAME` | variable, optional | Defaults to `picket.photos`. |

### In the app (Camera tab)

Host name, port, user and password for the camera's FTP menu, each tappable to
copy. **Set** or **Generate** a new password (letters and digits, 8 to 64; the
receiver switches within seconds). **Start** / **Stop** the receiver instance.

### Pairing the app

Settings → API URL (the `ApiUrl` from the deploy summary) → the 8-character
pairing code from the same summary → **Pair**. The code works once and expires
after 30 minutes; `ops → pairing-code` issues a fresh one any time (new phone,
reinstall). Behind it, `POST /pair` is the API's only unauthenticated route and
hands back the bearer token, which the app keeps in SecureStore.

### Internal state in AWS (nothing to do)

`picket/apple-signing` (iOS key, certificate and profile written by the build
workflow), the camera password secret (edited through the app), the API token
and pairing-code secrets, and the Lightroom OAuth tokens (written by Connect
Lightroom in the app).

## Workflows

### `deploy`

`deploy` (default) bootstraps the CDK environment if needed, deploys the stack,
issues a pairing code, and writes a summary with `ApiUrl`, `FtpHost`, `FtpUser`,
the pairing code, and the DNS records to add (see **Domain** below). `diff`
shows what a deploy would change without changing anything. Re-running it when
nothing changed is harmless and is how you pick up the API's custom domain once
its certificate is issued.

First deploy takes about 10 minutes (the receiver needs ~3 more to install
pure-ftpd after the stack reports done). Re-deploys after a code change are a
couple of minutes. Running it when nothing changed is harmless.

### `ops`

| action | what it does |
|---|---|
| `status` | receiver state, photo counts per status, Lightroom counts per status, queue and dead-letter depth |
| `pairing-code` | a fresh one-time code for the app's Settings screen |
| `receiver-logs` | health report from the instance over Session Manager: cloud-init result, pure-ftpd state and log, certificate in use, Picket log lines. First stop when the camera can't connect. |
| `lightroom-debug` | the pick → Lightroom pipeline in one log: queue depths, every photo by Lightroom status, router and uploader CloudWatch events, a peek at the dead-letter queue. First stop when a pick sticks on Queued or Failed. |
| `migrate-photo-ids` | one-off: moves rows from the legacy photo id (hash of the S3 key, which carried the upload date) to the current one (file name + capture time). Dry run unless the confirm box says `migrate`. Needed once after #23; harmless to re-run. |
| `dns` | re-sync the `ftp` and `api` records on Netlify and list the zone |
| `receiver-start` / `receiver-stop` | start or stop the FTPS instance. Stopped, it costs nothing but the Elastic IP (~$3.65/mo) and the camera settings stay valid. Stop it between trips. |
| `reload-ftp-password` | force the receiver to re-read the camera password (the app does this itself after a change; this is the manual fallback) |
| `redrive-dlq` | put picks that failed six times back on the upload queue (after you fixed the cause, e.g. reconnected Lightroom or freed storage) |
| `uploader-errors` | last 24 h of error lines from the Lightroom uploader |
| `destroy` | tear the stack down (type `destroy` in the confirm box). The photos bucket and the Photos table are kept. |

### `app-build`

Three actions, all without a computer or an Apple ID login:

| action | what it does |
|---|---|
| `register-device` | starts an EAS workflow that pauses with a link. Open it on your iPhone, install the profile it offers, then approve the device on the run page. That's how EAS learns the phone's UDID. |
| `devices` | lists the iPhones registered on EAS for your Apple team |
| `build` | iOS: creates or reuses an iOS Distribution certificate, registers the bundle id and your devices, and creates an ad hoc provisioning profile, all through the App Store Connect API (`app/scripts/apple-signing.mjs`); then starts the EAS build with those credentials. `preview` is the one to use: a standalone build you install from the EAS link, no dev server. `production` (ios) makes an App Store profile instead and hands the finished build to TestFlight automatically; see **TestFlight** below. Android needs none of this. |

The signing material (private key, certificate, profile) lives in AWS Secrets
Manager under `picket/apple-signing`, so every build reuses it; nothing is
committed. The first `build` also links the Expo project and commits its id
into `app/app.json`.

### `ci`

Runs on every pull request and push to `main`: synth, tests, typechecks.

## One-time setup checklist (phone only)

1. **GitHub secrets**: AWS keys (or role), `EXPO_TOKEN`, `APPLE_TEAM_ID`, the
   three `ASC_*` values. Run `deploy`; the summary has `ApiUrl`, the pairing
   code, and the DNS records for Netlify.
2. **Adobe**: done. The Native App credential's client id, redirect URI and
   scopes are the defaults in `infra/bin/picket.ts`.
3. **Phone enrollment** (ad hoc path only): `app-build → register-device`,
   follow the summary. The TestFlight path needs no enrollment.
4. **Build**: either `app-build → build` (ios, preview) and tap Install on the
   build link, or `app-build → build` (ios, production) and install from the
   TestFlight app once it appears there (see **TestFlight** below).
5. **App**: Settings → `ApiUrl` + pairing code → Pair → Connect Lightroom.
6. **Camera**: the app's Camera tab has every value for
   `docs/CAMERA_SETUP.md`: Host Name `ftp.picket.photos`, user, password
   (set one that's easy to type), Secure Protocol on, Passive on. Try *Root
   Certificate Error → Does Not Connect* first; if the camera rejects the
   Let's Encrypt chain, use *Connect* (TLS still encrypts, the camera just
   skips verifying the server).

## Domain: picket.photos (DNS at Netlify)

The domain is registered through Netlify, whose registered domains can't be
pointed at other name servers, so DNS records live in Netlify DNS. With the
`NETLIFY_AUTH_TOKEN` secret set, `deploy` creates and updates them itself,
waits for the API certificate to validate, and attaches `api.picket.photos`
in the same run. Without the token, the summary tells you exactly what to add
in Netlify → Domains → picket.photos → DNS settings:

| record | points at | purpose |
|---|---|---|
| `ftp` A | the receiver's Elastic IP | the camera's host. The receiver starts self-signed and swaps in a Let's Encrypt certificate within ~15 minutes of this record resolving; certbot renews it. |
| validation CNAME (name and value printed in the summary) | AWS | proves ownership of `api.picket.photos` so AWS issues its certificate |
| `api` CNAME | the `ApiDomainTarget` output | the app's API at https://api.picket.photos |

Manual sequence (no token): first `deploy` prints the `ftp` A record and the
validation CNAME. Add both. Within ~30 minutes AWS issues the certificate; run
`deploy` again and the summary prints the `api` CNAME. Add it. The default
`execute-api` URL works the whole time, so none of this blocks using the app.

If a Route 53 hosted zone for the domain ever exists in the account, `deploy`
switches to Route 53 mode automatically and manages the records itself.

## How the iOS signing works without a computer

Expo's own tooling gets most of the way: EAS CLI accepts an App Store Connect
API key in `--non-interactive` mode and can refresh an ad hoc profile with it.
The one thing it refuses to do non-interactively is create the distribution
certificate. Apple's API has no such restriction, so `apple-signing.mjs` does
the whole chain itself (certificate, bundle id, devices, profile) and hands EAS
a `credentials.json` with `credentialsSource: local`. Devices come from EAS's
device list, filled by the `register-device` enrollment link.

Known limits:

- Apple allows two iOS Distribution certificates per team. If you already have
  two (from Xcode, say), revoke one at developer.apple.com → Certificates.
- Apple can take up to 72 hours to accept a newly registered device on a new
  or just-renewed membership; the first build may fail with a device error
  until then.
- The App Store Connect key must be a **Team** key with **Admin** role;
  app-scoped or Developer-role keys can't manage certificates.
- An Android phone needs none of this: `app-build → build` with platform
  `android` installs straight from the EAS link.

## Runbook

- **Camera says it can't connect**: app → Camera; if the receiver is stopped,
  Start it. Confirm Secure Protocol is On and the camera's password matches
  the one shown.
- **Photos upload but never show in the app**: `ops → status` shows
  `unreviewed` growing? Then it's the app's API URL/token. Not growing? Check
  the receiver: it logs to the system journal under `picket-upload`
  (Session Manager in the AWS console).
- **Picks stuck on "Queued"/"Failed"**: `ops → lightroom-debug` (or
  `uploader-errors`). A 403 means reconnect Lightroom in Settings. A 413 means
  Lightroom storage is full. A 415 means Adobe rejected the content type: RAW
  masters are sent as `application/octet-stream` (the only type Lightroom
  accepts for proprietary raws); `LIGHTROOM_RAW_CONTENT_TYPE` as a repository
  variable overrides it, then `deploy`. Then tap **Retry upload** on the pick,
  or `redrive-dlq` if it reached the dead-letter queue.
- **Change the camera password**: app → Camera → Set or Generate, then update
  the camera. **New phone or reinstall**: `ops → pairing-code`, enter it in
  Settings.
- **TestFlight** (`app-build → build`, profile `production`, platform `ios`):
  one-time setup is an app record in App Store Connect (My Apps → + → New
  App, bundle id `com.danbut.picket`; Apple's API cannot create it). The
  workflow looks up the record's id, writes the ASC key into a submit profile
  for that run only, and starts the build with `--auto-submit`, so EAS uploads
  it when it finishes. Testers go in App Store Connect → Picket → TestFlight →
  Internal Testing (team members, up to 100, no review; an external group
  needs a one-time beta review). TestFlight builds expire after 90 days; run
  `build` again. Switching between `preview` and `production` regenerates the
  provisioning profile each time, which is automatic and harmless.
- **Re-sending files from the camera** (failed transfers, a second card dump):
  safe at any time. A photo's identity is its file name plus capture time, so a
  re-sent file lands on the same row and keeps its swipe; only the newest RAW
  object is referenced (an earlier upload of the same frame stays in S3 unused).
  On the camera: FTP Transfer → Transfer Status → *Only Failed Transfer*.
- **New iPhone**: `app-build → register-device`, enroll, approve, then
  `app-build → build`. The profile is recreated with the new device list.
- **iOS build fails on signing**: the `iOS signing` step's summary shows which
  Apple call failed. Certificate limit → revoke one at developer.apple.com.
  Device not accepted → wait for Apple, retry. Key rejected → confirm it's a
  Team key with Admin role.
