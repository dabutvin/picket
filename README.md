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
[`docs/DECISIONS.md`](docs/DECISIONS.md) for why, and
[`docs/CAMERA_SETUP.md`](docs/CAMERA_SETUP.md) for the camera menus.

## Layout

| path                | what                                                        | check it with            |
|---------------------|-------------------------------------------------------------|--------------------------|
| `infra/`            | AWS CDK app (TypeScript): bucket, table, FTPS receiver, Lambdas, API | `npm run build && npm run synth` |
| `infra/ingest/`     | cloud-init + upload hook for the FTPS receiver              | rendered into the stack  |
| `services/preview/` | Python Lambda: ARW → embedded-JPEG previews + DynamoDB row  | `pytest`                 |
| `services/api/`     | Node Lambdas: HTTP API + authorizer, stream router, Lightroom uploader | `npm test`    |
| `app/`              | Expo app: swipe deck, picks, skipped, connect Lightroom     | `npm run typecheck`      |

## Getting started

Prereqs: Node 22, Python 3.12+, an AWS account with credentials in your shell,
the CDK bootstrapped once in the target account/region (`npx cdk bootstrap`),
and an Adobe Developer Console project (below).

### Adobe Developer Console (once)

1. Create a project, **Add API → Lightroom Services**, credential type
   **OAuth Native App**.
2. Add the redirect URI `picket://oauth`.
3. Under the project's user settings, add the Adobe account that owns your
   Lightroom catalog as a **beta user** (development mode only lets listed users
   log in).
4. Note the **Client ID** and the scopes the console shows for Lightroom
   Services. The client id is public; there is no secret.

```bash
# 1. deploy everything
cd infra && npm install
export LIGHTROOM_CLIENT_ID=<client id from the console>
# export LIGHTROOM_SCOPES=openid,AdobeID,lr_partner_apis,lr_partner_rendition_apis,offline_access   # only if the console lists different ones
npm run deploy
#    outputs: ReceiverIp, FtpUser, FtpPasswordSecret, ApiUrl, ApiTokenSecret, Bucket, Table, LightroomRedirectUri

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

"Connect Lightroom" returns to the app through the `picket://` URL scheme, which
Expo Go doesn't register, so use a development build:
`npx eas-cli build --profile development --platform ios`. Review, Picks and
Skipped work in Expo Go.

Watch uploads with `aws logs tail /aws/lambda/<Uploader function> --follow`.
Picks that fail six times land on the dead-letter queue (`UploadDlqUrl` output).

## Status

Kick-off scaffold. Everything synthesizes, typechecks and passes tests; nothing
has been deployed yet. First deploy and a real camera → S3 → swipe → Lightroom
round trip is the next milestone. Two things to confirm on that first run: the
IMS scope names and the `Content-Type` Lightroom wants for `.ARW` masters (see
ADR-006). See `docs/ARCHITECTURE.md` → "Not in scope yet" for the rest.
