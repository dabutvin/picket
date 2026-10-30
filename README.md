# picket

Transfer RAW photos from a Sony a7C II wirelessly to AWS, swipe through them on
your phone to pick keepers, and have the picks uploaded straight into your
Lightroom cloud catalog. RAW files never touch the phone.

```
camera ──FTPS──▶ receiver (EC2) ──▶ S3 raw/ ──▶ Lambda previews ──▶ DynamoDB ──stream──▶ SQS ──▶ uploader ──▶ Lightroom cloud
                                                                      │
                          Expo app  ◀── swipe ◀── HTTP API ◀──────────┘
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it fits together,
[`docs/DECISIONS.md`](docs/DECISIONS.md) for why,
[`docs/CAMERA_SETUP.md`](docs/CAMERA_SETUP.md) for the camera menus, and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) to run all of it from a phone.

## Layout

| path                | what                                                        | check it with            |
|---------------------|-------------------------------------------------------------|--------------------------|
| `infra/`            | AWS CDK app (TypeScript): bucket, table, FTPS receiver, Lambdas, API | `npm run build && npm run synth` |
| `infra/ingest/`     | cloud-init + upload hook for the FTPS receiver              | rendered into the stack  |
| `services/preview/` | Python Lambda: ARW → embedded-JPEG previews + DynamoDB row  | `pytest`                 |
| `services/api/`     | Node Lambdas: HTTP API + authorizer, stream router, Lightroom uploader | `npm test`    |
| `app/`              | Expo app: swipe deck, picks, skipped, connect Lightroom     | `npm run typecheck`      |

## Getting started (no terminal)

Everything deploys and operates through GitHub Actions buttons; see
[`docs/OPERATIONS.md`](docs/OPERATIONS.md). In short: add AWS credentials and
your chosen FTP password / API token as repository secrets, run the **deploy**
workflow, read `ReceiverIp` and `ApiUrl` from its summary, set up the camera
and the app. The **ops** workflow gives you status, receiver start/stop and
retries. The **app-build** workflow starts EAS builds once the one-time Apple
signing setup is done.

## Getting started (terminal)

Prereqs: Node 22, Python 3.12+, an AWS account with credentials in your shell,
the CDK bootstrapped once in the target account/region (`npx cdk bootstrap`),
and an Adobe Developer Console project (below).

### Adobe Developer Console (once)

1. Create a project, **Add API → Lightroom Services**, credential type
   **OAuth Native App**. Adobe assigns the redirect URI itself, of the form
   `adobe+<hash>://adobeid/<client id>`; you can't change it.
2. Under the project's user settings, add the Adobe account that owns your
   Lightroom catalog as a **beta user** (development mode only lets listed users
   log in).
3. Note the **Client ID**, the **redirect URI**, and the scopes the console
   shows (`lr_partner_apis, AdobeID, lr_partner_rendition_apis, openid,
   offline_access`). None of these are secrets.

This repo already carries the project's values as defaults in
`infra/bin/picket.ts`, and the redirect URI's scheme is registered under
`expo.scheme` in `app/app.json`. If you create a different credential, update
both places (or pass `LIGHTROOM_CLIENT_ID` / `LIGHTROOM_REDIRECT_URI` at deploy
time and edit `app.json`).

```bash
# 1. deploy everything
cd infra && npm install
npm run deploy
#    outputs: ReceiverIp, FtpUser, FtpPasswordSecret, ApiUrl, ApiTokenSecret, Bucket, Table, LightroomClientId, LightroomRedirectUri

# 2. read the two secrets
aws secretsmanager get-secret-value --secret-id <FtpPasswordSecret> --query SecretString --output text
aws secretsmanager get-secret-value --secret-id <ApiTokenSecret>    --query SecretString --output text

# 3. point the camera at ReceiverIp with FtpUser + password (docs/CAMERA_SETUP.md)

# 4. run the app, paste ApiUrl + token in Settings, then tap "Connect Lightroom"
cd ../app && npm install && npx expo start
```

The receiver takes a couple of minutes after `deploy` finishes to install
pure-ftpd and the AWS CLI. Check it with
`aws ssm start-session --target <instance-id>` then `journalctl -t picket -t picket-upload`.

"Connect Lightroom" returns to the app through Adobe's `adobe+<hash>://` URL
scheme, which Expo Go doesn't register, so use a development build:
`npx eas-cli build --profile development --platform ios`. Review, Picks and
Skipped work in Expo Go.

Watch uploads with `aws logs tail /aws/lambda/<Uploader function> --follow`.
Picks that fail six times land on the dead-letter queue (`UploadDlqUrl` output).

## Status

Kick-off scaffold plus phone-only operations. Everything synthesizes, typechecks
and passes tests; nothing has been deployed yet. First deploy and a real camera → S3 → swipe → Lightroom
round trip is the next milestone. Two things to confirm on that first run: the
IMS scope names and the `Content-Type` Lightroom wants for `.ARW` masters (see
ADR-006). See `docs/ARCHITECTURE.md` → "Not in scope yet" for the rest.
