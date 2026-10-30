# infra

AWS CDK (TypeScript). One stack, `Picket`, made of four constructs that map to
the stages in `docs/ARCHITECTURE.md`:

- `lib/storage.ts`    S3 bucket (`raw/`, `previews/`, `thumbs/`) + DynamoDB `Photos` with `byStatus` GSI
- `lib/receiver.ts`   t4g.nano running pure-ftpd (FTPES), Elastic IP, upload hook → S3. Scripts in `ingest/`
- `lib/processing.ts` Python Lambda on `raw/` ObjectCreated (bundled by `services/preview/build.sh`)
- `lib/api.ts`        HTTP API + Node Lambda + bearer-token authorizer

```bash
npm install
npm run build     # tsc
npm run synth     # also bundles both Lambdas locally (python3 + esbuild, no Docker)
npm run deploy
```

Buckets and tables are `RETAIN`ed on destroy. The receiver is replaced when
`ingest/cloud-init.sh` changes (`userDataCausesReplacement`).
