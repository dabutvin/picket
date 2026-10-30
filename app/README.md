# app

Expo SDK 58, TypeScript. Three screens behind a plain tab bar:

- **Review**: swipe deck over `unreviewed` photos. Right/“Pick” → `pick`, left/“Skip” → `reject`, Undo re-opens the last one.
- **Picks**: grid of `pick` photos. Tap one → “Send to Lightroom” downloads the ARW and opens the share sheet.
- **Settings**: API URL + bearer token (from the CDK outputs), stored in SecureStore.

```bash
npm install
npm run typecheck
npx expo start                      # Review/Picks work in Expo Go; sharing a RAW needs a dev build
npx eas-cli build --profile development --platform ios
```

`src/lib/types.ts` mirrors `services/api/src/types.ts`; keep them in sync.
