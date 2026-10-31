# services/api

Node 22 Lambdas (arm64). Three entry points share one codebase:

- `src/handler.ts`  the HTTP API (routes in `docs/ARCHITECTURE.md` §API) and `src/authorizer.ts` its bearer-token check
- `src/router.ts`   Photos table stream → SQS when a row becomes `lightroomStatus = queued`
- `src/uploader.ts` SQS → S3 RAW → Lightroom catalog (`src/adobe.ts` is the IMS/Lightroom client); marks the photo `sent` when done

A pick is queued only by `POST /lightroom/send` or `POST /photos/{id}/lightroom` (the app's
Send to Lightroom), never by the decision route (ADR-008).

```bash
npm install
npm test            # vitest, no AWS needed
npm run typecheck
```

`src/app.ts` holds the routes and takes a `Store` + `ConnectionStore` so tests
inject fakes; `src/store.ts` is the DynamoDB + S3 presign implementation;
`src/connection.ts` keeps the user's Lightroom tokens in Secrets Manager and
refreshes them. Every Adobe call goes through an injectable `fetch`, so the
tests replay Adobe's documented responses (including the `while (1) {}` JSON
prefix and the 412 duplicate case) without network.
