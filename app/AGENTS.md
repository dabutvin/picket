This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Picket: how UI work is done here (read before changing anything under `src/`)

The owner operates from a phone and cannot run Metro or a simulator, and this cloud session
has no device either. So UI work follows a loop that needs neither:

1. **Build against the sample photos, not the live API.** `src/lib/demo.ts` is an in-memory
   stand-in for the Picket API with 18 sample photos spread across every tab (Review, Picks
   with one failed upload, Sent, Skipped), a connected "Lightroom" and receiver settings.
   Sends to Lightroom "complete" after a few seconds. Settings → **Try with sample photos**
   turns it on in the app; `EXPO_PUBLIC_PICKET_DEMO=1` at export time starts in it. When you
   add a screen or state, give the sample data what it needs to show that state.
2. **Look at your own work before asking the owner to.** Export the web build and run the
   screenshot script in this session (Chromium and Playwright are preinstalled; the script
   resolves Playwright through CommonJS so a global install works):
   ```bash
   cd app
   EXPO_PUBLIC_PICKET_DEMO=1 npx expo export --platform web --output-dir dist
   node scripts/ui-screenshots.mjs dist screenshots      # PNGs in app/screenshots/
   ```
   Then read the PNGs (the Read tool renders images). Fix what looks wrong and run it again.
   Two real defects were caught this way on the first run (a wrapping button label and a
   font fallback), so do not skip it.
3. **Extend `scripts/ui-screenshots.mjs` for every new screen or state.** It drives the app
   through `testID`s (`tab-<key>`, `thumb-<photoId>`, `grid-select`, `detail-close`,
   `picks-send-all`, `picks-send-one`, `demo-enter`, `demo-leave`); add a `testID` to anything
   the script must tap and a `shot(name, caption)` for each state worth seeing. The script
   exits non-zero on any uncaught page error, so it is also the web smoke test.
4. **Open the PR and read its UI preview comment.** `.github/workflows/ui-preview.yml` runs
   the same export and script on every PR touching `app/`, pushes the images to the
   `ui-previews` branch (latest commit per PR) and posts one comment that updates on each
   push. The owner reviews the UI from that comment; so should you, since it is the exact
   build CI made. Images are raw URLs on that branch and stop rendering in comments if the
   repository goes private (the `ui-screenshots` artifact on the run still has them).
5. **Know what the preview cannot tell you.** It is `react-native-web` in headless Chromium:
   layout, copy, colors and flow are faithful; native gesture feel, fonts and animation
   timing are not. Gesture code (the Review carousel in `src/components/Carousel.tsx` and
   `ReviewCard.tsx`, Reanimated + gesture-handler) can only be felt on a phone. Say so in the
   PR, name the thing to feel out (threshold, stuck diagonal swipe), and ship it to TestFlight
   for the owner: merge, then run the `deploy` workflow if the API changed and `app-build`
   (profile `production`, platform `ios`); the build auto-submits and Apple processes it in
   5–15 minutes. Both workflows also run from a PR branch via "Use workflow from" when a full
   end-to-end preview is worth it (the API is single-user; redeploying `main` reverts it).
6. **Keep the web build working.** `expo-secure-store` has no web implementation
   (`src/lib/settings.ts` falls back to `localStorage`); `Alert.alert` is a no-op on web, so
   the script avoids flows that confirm through one; fonts need a web fallback
   (`MONO` in `src/lib/theme.ts`). A new native module needs the same treatment or a
   `Platform.OS === 'web'` guard, or the preview breaks for every later PR.

Conventions for the UI itself: dark theme only, the four semantic colors in
`src/lib/theme.ts` (`pick` green, `reject` red, `accent` blue, `muted` grey), `Button` for
every action, grid screens share `src/screens/PhotoGrid.tsx`, and the API's `reject` is shown
as "Skip"/"Skipped" because nothing is ever deleted. The product flow (ADR-008 in
`docs/DECISIONS.md`): Review is a first triage (flick up = pick, down = skip, left/right
browse), Picks is a staging area where nothing uploads until **Send to Lightroom**, Sent is
read-only. The app typecheck is the only app check in CI; `npx expo lint` has pre-existing
findings (Reanimated shared-value writes and setState-in-effect) that are not yours to clear.
