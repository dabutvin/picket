# Operating Picket from a phone

Nothing in this project needs a terminal. Every action is a **Run workflow**
button in the GitHub app (Actions tab), and every result is written to the run's
summary page. Credentials live in the repository's Actions secrets.

## Where secrets live

GitHub holds the credentials the workflows need (AWS, Expo, Apple) plus the one
token the app needs to pair with the API. Camera settings are not secrets you
manage anywhere: the app's **Camera** tab shows them, rotates the password and
starts or stops the receiver. No workflow prints a secret value.

### GitHub (Settings → Secrets and variables → Actions)

| name | kind | what it is |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secret | An IAM user's access key. Simplest: IAM → Users → Create user → attach `AdministratorAccess` → Create access key. |
| `AWS_DEPLOY_ROLE_ARN` | secret, optional | Instead of keys: an IAM role trusting GitHub's OIDC provider for `repo:dabutvin/picket:*`. |
| `PICKET_API_TOKEN` | secret | Any long random string. `deploy` installs it as the API's bearer token; you paste the same value into the app's Settings once. |
| `EXPO_TOKEN` | secret | expo.dev → account → Access tokens. |
| `APPLE_TEAM_ID` | secret | developer.apple.com → Membership details (10 characters). |
| `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | secret | An App Store Connect **Team** API key with the **Admin** role: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate. Paste the whole `.p8` file contents into `ASC_API_KEY_P8` (raw, `\n`-escaped or base64 all work); the Key ID is on that row, the Issuer ID at the top of the page. |
| `AWS_REGION` | variable, optional | Defaults to `us-east-1`. |
| `DOMAIN_NAME` | variable, optional | Defaults to `picket.photos`. |

### In the app (Camera tab)

Host name, port, user and password for the camera's FTP menu, each tappable to
copy. **Set** or **Generate** a new password (letters and digits, 8 to 64; the
receiver switches within seconds). **Start** / **Stop** the receiver instance.

### Internal state in AWS (nothing to do)

`picket/apple-signing` (iOS key, certificate and profile written by the build
workflow), the camera password secret (edited through the app), the API token
secret (set by `deploy` from `PICKET_API_TOKEN`), and the Lightroom OAuth
tokens (written by Connect Lightroom in the app).

## Workflows

### `deploy`

`deploy` (default) finds (or creates) the Route 53 hosted zone for the domain,
points the registrar at it when the domain is registered with Route 53 in the
same account, bootstraps the CDK environment if needed, deploys the stack, and
writes a summary table with `ApiUrl`, `FtpHost`, `FtpUser` and friends plus the
names of the secrets to read. `diff` shows what a deploy would change without
changing anything.

While the domain is not yet delegated to the zone (registrar still pointing
elsewhere), the API keeps its default `execute-api` URL; run `deploy` again
once DNS has propagated and `api.picket.photos` is added.

First deploy takes about 10 minutes (the receiver needs ~3 more to install
pure-ftpd after the stack reports done). Re-deploys after a code change are a
couple of minutes. Running it when nothing changed is harmless.

### `ops`

| action | what it does |
|---|---|
| `status` | receiver state, photo counts per status, Lightroom counts per status, queue and dead-letter depth |
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
| `build` | iOS: creates or reuses an iOS Distribution certificate, registers the bundle id and your devices, and creates an ad hoc provisioning profile, all through the App Store Connect API (`app/scripts/apple-signing.mjs`); then starts the EAS build with those credentials. `preview` is the one to use: a standalone build you install from the EAS link, no dev server. `production` makes an App Store profile instead, for TestFlight. Android needs none of this. |

The signing material (private key, certificate, profile) lives in AWS Secrets
Manager under `picket/apple-signing`, so every build reuses it; nothing is
committed. The first `build` also links the Expo project and commits its id
into `app/app.json`.

### `ci`

Runs on every pull request and push to `main`: synth, tests, typechecks.

## One-time setup checklist (phone only)

1. **GitHub secrets**: AWS keys (or role), `PICKET_API_TOKEN`, `EXPO_TOKEN`,
   `APPLE_TEAM_ID`, the three `ASC_*` values. Run `deploy`; read `ApiUrl`
   from the summary.
2. **Adobe**: done. The Native App credential's client id, redirect URI and
   scopes are the defaults in `infra/bin/picket.ts`.
3. **Phone enrollment**: `app-build → register-device`, follow the summary.
4. **Build**: `app-build → build` (ios, preview). Open the build link on the
   phone and tap Install.
5. **App**: Settings → `ApiUrl` + your `PICKET_API_TOKEN` → Connect Lightroom.
6. **Camera**: the app's Camera tab has every value for
   `docs/CAMERA_SETUP.md`: Host Name `ftp.picket.photos`, user, password
   (set one that's easy to type), Secure Protocol on, Passive on. Try *Root
   Certificate Error → Does Not Connect* first; if the camera rejects the
   Let's Encrypt chain, use *Connect* (TLS still encrypts, the camera just
   skips verifying the server).

## Domain: picket.photos

The stack uses one Route 53 hosted zone for the domain:

- `ftp.picket.photos` → the receiver's Elastic IP. The receiver starts with a
  self-signed certificate and swaps in a Let's Encrypt one as soon as the name
  resolves publicly (a timer retries every 15 minutes; certbot renews it).
- `api.picket.photos` → the HTTP API, with an ACM certificate. Only created
  once the domain is delegated to the zone, because certificate validation
  would otherwise stall the deploy.

If the domain was registered with Route 53 in the same AWS account, `deploy`
points it at the zone automatically. If it was registered elsewhere, the deploy
summary lists the four name servers to enter at the registrar.

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
- **Picks stuck on "Queued"/"Failed"**: `ops → uploader-errors`. A 403 means
  reconnect Lightroom in Settings. A 413 means Lightroom storage is full. A 415
  means set `LIGHTROOM_RAW_CONTENT_TYPE=application/octet-stream` as a
  repository variable, then `deploy`. Then `redrive-dlq`.
- **Change the camera password**: app → Camera → Set or Generate, then update
  the camera. **Change the API token**: change the `PICKET_API_TOKEN` secret,
  run `deploy`, update the app's Settings.
- **New iPhone**: `app-build → register-device`, enroll, approve, then
  `app-build → build`. The profile is recreated with the new device list.
- **iOS build fails on signing**: the `iOS signing` step's summary shows which
  Apple call failed. Certificate limit → revoke one at developer.apple.com.
  Device not accepted → wait for Apple, retry. Key rejected → confirm it's a
  Team key with Admin role.
