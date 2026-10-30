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

Secrets only ever flow GitHub → AWS. No workflow prints a secret value.

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

Starts an EAS Build and links to it in the summary. `preview` is the one to
use: a standalone, internally distributed build you install from the EAS link
(no dev server needed). `production` goes through TestFlight / the stores.

### `ci`

Runs on every pull request and push to `main`: synth, tests, typechecks.

## One-time setup checklist

1. **AWS**: create the IAM user (or OIDC role), add the key secrets. Run
   `deploy`. Read `ReceiverIp` and `FtpUser` from the summary.
2. **Camera**: `docs/CAMERA_SETUP.md`. Host Name = `ReceiverIp`, user =
   `FtpUser`, password = `PICKET_FTP_PASSWORD`, Secure Protocol on, Passive on.
   Set *Root Certificate Error → Connect* (the receiver's certificate is
   self-signed).
3. **Adobe**: done. The Native App credential's client id, redirect URI and
   scopes are the defaults in `infra/bin/picket.ts`.
4. **App**: see below; then Settings → `ApiUrl` + `PICKET_API_TOKEN` → Connect
   Lightroom.

## The app build, honestly

Everything on the AWS side is phone-only. The iOS build has one step that
Expo requires to be done interactively, once:

- Generating the iOS signing credentials (distribution certificate and
  provisioning profile) requires an Apple Developer Program membership and an
  Apple sign-in through the EAS CLI (`eas build -p ios --profile preview` on
  any computer, answering the prompts). Expo's docs state both requirements, and
  "Build from GitHub" additionally requires one successful build from a
  computer before it will build from the repo.
- Your iPhone must be registered for the ad-hoc profile. EAS gives you a link
  to open on the phone for that (`eas device:create` → *Website*).

After that one session, `app-build` from GitHub (or "Build from GitHub" on
expo.dev) does everything, and each finished build is an Install link on the
phone. Before the first build, the Expo project id has to be in
`app/app.json` under `expo.extra.eas.projectId` (create the project on
expo.dev and paste the id).

If you'd rather avoid Apple's developer program entirely, an Android phone can
install the `preview` APK straight from the EAS link with no signing setup at
all.

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
