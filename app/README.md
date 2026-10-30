# app

Expo SDK 58, TypeScript. Three screens behind a plain tab bar:

- **Review**: swipe deck over `unreviewed` photos. Right/“Pick” → `pick` (and queued for Lightroom), left/“Skip” → `reject`, Undo re-opens the last one. Header shows lifetime counts.
- **Picks**: grid of `pick` photos with their Lightroom upload state. Tap one to un-pick or retry a failed upload.
- **Skipped**: grid of `reject` photos. Tap one to make it a pick or send it back to Review.
- **Settings**: API URL + bearer token (from the CDK outputs) in SecureStore, and **Connect Lightroom** (Adobe OAuth with PKCE; tokens go to the backend, not the phone).

```bash
npm install
npm run typecheck
npx expo start                      # Review/Picks/Skipped work in Expo Go; Connect Lightroom needs a dev build (adobe+… scheme)
npx eas-cli build --profile development --platform ios
```

`eas.json` has `preview` (internal distribution, install from the EAS link) and `production`
profiles with `credentialsSource: local`; `scripts/apple-signing.mjs` creates the certificate
and provisioning profile through the App Store Connect API and the `app-build` GitHub
workflow runs both. `.eas/workflows/register-device.yml` enrolls a phone via a link.
`node scripts/apple-signing.mjs self-test` exercises the crypto/openssl parts offline.
See `docs/OPERATIONS.md`.

`src/lib/types.ts` mirrors `services/api/src/types.ts`; keep them in sync.

Naming: the API's `reject` status is shown as “Skip”/“Skipped” in the UI, since
nothing is deleted and any skip can become a pick later.
