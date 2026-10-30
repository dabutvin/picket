# Operating Picket from a phone

Nothing in this project needs a terminal. Every action is a **Run workflow**
button in the GitHub app (Actions tab), and every result is written to the run's
summary page. Credentials live in the repository's Actions secrets.

## Secrets and variables (Settings → Secrets and variables → Actions)

| name | kind | what it is |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secret | An IAM user's access key in your AWS account. Simplest path: IAM → Users → Create user → attach `AdministratorAccess` → Security credentials → Create access key. |
| `AWS_DEPLOY_ROLE_ARN` | secret, optional | Instead of keys: an IAM role trusting GitHub's OIDC provider for `repo:dabutvin/picket:*`. If set, the workflows use it and ignore the keys. |
| `AWS_REGION` | variable, optional | Defaults to `us-east-1`. |
| `PICKET_FTP_PASSWORD` | secret, optional | The password you'll type into the camera. Letters and digits, up to 64 chars. If unset, AWS generates one and you read it in the Secrets Manager console. |
| `PICKET_API_TOKEN` | secret, optional | The bearer token you'll paste into the app's Settings. Same fallback as above. |
| `EXPO_TOKEN` | secret | For app builds. expo.dev → account → Access tokens. |
| `APPLE_TEAM_ID` | secret | developer.apple.com → Membership details (10 characters). |
| `ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | secret | An App Store Connect **Team** API key with the **Admin** role: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate. Paste the whole `.p8` file contents into `ASC_API_KEY_P8`; the Key ID is on that row, the Issuer ID at the top of the page. |

Secrets only ever flow GitHub → AWS / Expo / Apple. No workflow prints a secret value.

## Workflows

### `deploy`

`deploy` (default) bootstraps the CDK environment if needed, deploys the stack,
pushes `PICKET_FTP_PASSWORD` / `PICKET_API_TOKEN` into the AWS secrets when they
differ, reloads the FTP password on the receiver over SSM, and writes a summary
table with `ApiUrl`, `ReceiverIp`, `FtpUser` and friends. `diff` shows what a
deploy would change without changing anything.

First deploy takes about 10 minutes (the receiver needs ~3 more to install
pure-ftpd after the stack reports done). Re-deploys after a code change are a
couple of minutes. Running it when nothing changed is harmless.

### `ops`

| action | what it does |
|---|---|
| `status` | receiver state, photo counts per status, Lightroom counts per status, queue and dead-letter depth |
| `receiver-start` / `receiver-stop` | start or stop the FTPS instance. Stopped, it costs nothing but the Elastic IP (~$3.65/mo) and the camera settings stay valid. Stop it between trips. |
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

1. **AWS**: create the IAM user (or OIDC role), add the key secrets. Run
   `deploy`. Read `ReceiverIp` and `FtpUser` from the summary.
2. **Camera**: `docs/CAMERA_SETUP.md`. Host Name = `ReceiverIp`, user =
   `FtpUser`, password = `PICKET_FTP_PASSWORD`, Secure Protocol on, Passive on.
   Set *Root Certificate Error → Connect* (the receiver's certificate is
   self-signed).
3. **Adobe**: done. The Native App credential's client id, redirect URI and
   scopes are the defaults in `infra/bin/picket.ts`.
4. **Apple**: join the Apple Developer Program (developer.apple.com, works
   from Safari on the phone), note the Team ID, create the App Store Connect
   Team API key, add the four secrets above.
5. **Expo**: create an account at expo.dev, make an access token, add
   `EXPO_TOKEN`. No project needed; the first build creates it.
6. **Phone enrollment**: `app-build → register-device`, follow the summary.
7. **Build**: `app-build → build` (ios, preview). Open the build link on the
   phone and tap Install. Settings → `ApiUrl` + `PICKET_API_TOKEN` → Connect
   Lightroom.

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

- **Camera says it can't connect**: `ops → status`; if the receiver is stopped,
  `receiver-start`. Confirm Secure Protocol is On and the password matches
  `PICKET_FTP_PASSWORD`.
- **Photos upload but never show in the app**: `ops → status` shows
  `unreviewed` growing? Then it's the app's API URL/token. Not growing? Check
  the receiver: it logs to the system journal under `picket-upload`
  (Session Manager in the AWS console).
- **Picks stuck on "Queued"/"Failed"**: `ops → uploader-errors`. A 403 means
  reconnect Lightroom in Settings. A 413 means Lightroom storage is full. A 415
  means set `LIGHTROOM_RAW_CONTENT_TYPE=application/octet-stream` as a
  repository variable, then `deploy`. Then `redrive-dlq`.
- **Rotate the FTP password or API token**: change the secret, run `deploy`.
- **New iPhone**: `app-build → register-device`, enroll, approve, then
  `app-build → build`. The profile is recreated with the new device list.
- **iOS build fails on signing**: the `iOS signing` step's summary shows which
  Apple call failed. Certificate limit → revoke one at developer.apple.com.
  Device not accepted → wait for Apple, retry. Key rejected → confirm it's a
  Team key with Admin role.
