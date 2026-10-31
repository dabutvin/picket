# infra

AWS CDK (TypeScript). One stack, `Picket`, made of four constructs that map to
the stages in `docs/ARCHITECTURE.md`:

- `lib/storage.ts`    S3 bucket (`raw/`, `previews/`, `thumbs/`) + DynamoDB `Photos` (stream on, `byStatus` + `byLightroomStatus` GSIs)
- `lib/receiver.ts`   t4g.nano running pure-ftpd (FTPES), Elastic IP, upload hook → S3. Scripts in `ingest/`
- `lib/processing.ts` Python Lambda on `raw/` ObjectCreated (bundled by `services/preview/build.sh`)
- `lib/lightroom.ts`  connection secret, SQS + DLQ, stream router, serialized Lightroom uploader
- `lib/api.ts`        HTTP API + Node Lambda + bearer-token authorizer

```bash
npm install
npm run build     # tsc
npm run synth     # also bundles both Lambdas locally (python3 + esbuild, no Docker)
npm run deploy
```

Adobe settings default to the project's credential in `bin/picket.ts`; override with
`LIGHTROOM_CLIENT_ID`, `LIGHTROOM_REDIRECT_URI`, `LIGHTROOM_SCOPES`, `LIGHTROOM_ALBUM_NAME`,
`LIGHTROOM_RAW_CONTENT_TYPE` or the matching `-c` context keys.

Deploys normally run from the `deploy` GitHub Actions workflow (`docs/OPERATIONS.md`).
`scripts/netlify-dns.sh` upserts the domain's records on Netlify DNS (the workflow calls it).
The receiver carries the tag `picket:role=receiver`; `/usr/local/bin/picket-set-ftp-password.sh`
on it reloads the camera password from Secrets Manager (the deploy workflow runs it over SSM).

Buckets and tables are `RETAIN`ed on destroy. The receiver is replaced when
`ingest/cloud-init.sh` changes (`userDataCausesReplacement`).
