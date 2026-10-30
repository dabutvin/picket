# picket

Transfer RAW photos from a Sony a7C II wirelessly to AWS, swipe through them on
your phone to pick keepers, and send the picks to Lightroom.

```
camera ──FTPS──▶ receiver (EC2) ──▶ S3 raw/ ──▶ Lambda previews ──▶ DynamoDB
                                                                      │
                          Expo app  ◀── swipe ◀── HTTP API ◀──────────┘
                              └── Send to Lightroom (iOS share sheet)
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
| `services/api/`     | Node Lambda: `/photos` routes + bearer-token authorizer     | `npm test`               |
| `app/`              | Expo app: swipe deck, picks grid, send to Lightroom         | `npm run typecheck`      |

## Getting started

Prereqs: Node 22, Python 3.12+, an AWS account with credentials in your shell,
and the CDK bootstrapped once in the target account/region (`npx cdk bootstrap`).

```bash
# 1. deploy everything
cd infra && npm install && npm run deploy
#    outputs: ReceiverIp, FtpUser, FtpPasswordSecret, ApiUrl, ApiTokenSecret, Bucket, Table

# 2. read the two secrets
aws secretsmanager get-secret-value --secret-id <FtpPasswordSecret> --query SecretString --output text
aws secretsmanager get-secret-value --secret-id <ApiTokenSecret>    --query SecretString --output text

# 3. point the camera at ReceiverIp with FtpUser + password (docs/CAMERA_SETUP.md)

# 4. run the app, paste ApiUrl + token in Settings
cd ../app && npm install && npx expo start
```

The receiver takes a couple of minutes after `deploy` finishes to install
pure-ftpd and the AWS CLI. Check it with
`aws ssm start-session --target <instance-id>` then `journalctl -t picket -t picket-upload`.

Picks reach Lightroom through the iOS share sheet ("Add to Lightroom" needs the
Lightroom mobile app installed), so the app needs a development build rather
than Expo Go: `npx eas-cli build --profile development --platform ios`.

## Status

Kick-off scaffold. Everything synthesizes, typechecks and passes tests; nothing
has been deployed yet. First deploy and a real camera → S3 → swipe → Lightroom
round trip is the next milestone. See `docs/ARCHITECTURE.md` → "Not in scope yet".
