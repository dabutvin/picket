# app

Expo SDK 58, TypeScript. Six screens behind a plain tab bar:

- **Review**: carousel over `unreviewed` photos, oldest first. Swipe left/right to look ahead and go back; flick a photo up (or tap “Pick”) → `pick`, flick down (or “Skip”) → `reject`; Undo puts the last one back where it was. Tap the position counter (“▦ Jump to”) for a grid of the whole queue by capture day and tap a photo to jump the carousel there. Nothing is uploaded from here. (`src/components/Carousel.tsx` is the pager, `ReviewCard.tsx` the flickable card.)
- **Picks**: grid of `pick` photos waiting to go to Lightroom. **Send all to Lightroom**, or long-press / “Select” to send or skip a few. Tap one to send it alone, retry a failed upload, skip it, or send it back to Review. Polls while anything is queued or uploading; a photo leaves this tab once Lightroom has it.
- **Sent**: grid of `sent` photos (in the Lightroom “Picket” album). Read-only.
- **Skipped**: grid of `reject` photos. Tap one to make it a pick or send it back to Review.
- **Camera**: the FTP settings the a7C II needs (tap to copy), set/generate the password (the receiver reloads it over SSM), start/stop the receiver.
- **Settings**: API URL + one-time pairing code (from the deploy summary) → the token lands in SecureStore; and **Connect Lightroom** (Adobe OAuth with PKCE; tokens go to the backend, not the phone).

```bash
npm install
npm run typecheck
npx expo start                      # Review/Picks/Sent/Skipped work in Expo Go; Connect Lightroom needs a dev build (adobe+… scheme)
npx eas-cli build --profile development --platform ios
```

`eas.json` has `preview` (internal distribution, install from the EAS link) and `production`
profiles with `credentialsSource: local`; `scripts/apple-signing.mjs` creates the certificate
and provisioning profile through the App Store Connect API and the `app-build` GitHub
workflow runs both. `.eas/workflows/register-device.yml` enrolls a phone via a link.
`node scripts/apple-signing.mjs self-test` exercises the crypto/openssl parts offline.
See `docs/OPERATIONS.md`.

## Sample photos and UI previews

Settings → **Try with sample photos** runs the whole app against `src/lib/demo.ts`, an
in-memory stand-in for the API with 18 sample photos (sends to Lightroom "complete" after a
few seconds). Nothing talks to a server. Leave it from Settings.

Every pull request that touches `app/` gets a **UI preview** comment from
`.github/workflows/ui-preview.yml`: the web export in sample-photos mode
(`EXPO_PUBLIC_PICKET_DEMO=1`), driven by `scripts/ui-screenshots.mjs` in headless Chromium at
phone size, one screenshot per screen and state. The images live on the `ui-previews` branch
(latest commit per PR) and as a workflow artifact. It is a web rendering: layout and copy are
faithful, native gestures and fonts are not. To run it locally:

```bash
EXPO_PUBLIC_PICKET_DEMO=1 npx expo export --platform web --output-dir dist
npm install --no-save playwright && npx playwright install chromium
node scripts/ui-screenshots.mjs dist screenshots
```

Add a screen or state to the script when you add one to the app; the script fails on any
uncaught page error, so it doubles as a smoke test of the web build.

`src/lib/types.ts` mirrors `services/api/src/types.ts`; keep them in sync.

Naming: the API's `reject` status is shown as “Skip”/“Skipped” in the UI, since
nothing is deleted and any skip can become a pick later.
