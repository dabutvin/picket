# services/api

Node 22 Lambda (arm64) behind an HTTP API. Routes and auth are described in
`docs/ARCHITECTURE.md` §API.

```bash
npm install
npm test            # vitest, no AWS needed
npm run typecheck
```

`src/app.ts` holds the routes and takes a `Store` so tests inject a fake;
`src/store.ts` is the DynamoDB + S3 presign implementation; `src/authorizer.ts`
checks the bearer token against the Secrets Manager value.
