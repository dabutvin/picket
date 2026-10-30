# Decisions

Short architecture decision records. Newest at the bottom.

## ADR-001: FTPS receiver on a tiny EC2 instance, not AWS Transfer Family

**Context.** The a7C II can only push over FTP/FTPES. AWS Transfer Family offers
a managed FTPS endpoint that writes straight to S3, which is the obvious fit.
But it bills ~$0.30 per protocol-hour (~$216/month) whether or not anything is
transferred, and stopping the server does not stop the charge; only deleting it
does. Plain FTP on Transfer Family is VPC-only, so the camera could not reach it
from a hotspot anyway.

**Decision.** Run `pure-ftpd` on a `t4g.nano` (arm64, ~$3/month) behind an
Elastic IP, TLS required, passive ports 30000–30009 opened in the security
group. `pure-uploadscript` runs `aws s3 mv` on each completed upload. The
instance is stateless; cloud-init rebuilds it from `infra/ingest/`.

**Consequences.** We own patching and the TLS cert. The cert is self-signed by
default; the camera accepts it either by importing the cert as a root
certificate from a memory card, or by setting *Root Certificate Error →
Connect* (Sony warns this skips server verification). A Let's Encrypt cert on a
real hostname removes that step and is a documented follow-up.

**Revisit if** Transfer Family gets a per-request pricing tier, or the project
grows beyond one photographer.

## ADR-002: Expo (React Native) for the swipe app

**Context.** The repo was created with an Xcode `.gitignore`, so a native
SwiftUI app was on the table. The swipe UI is small, the heavy lifting is in
AWS, and the only platform-specific need is the iOS share sheet into Lightroom.

**Decision.** Expo with TypeScript, `react-native-gesture-handler` +
`react-native-reanimated` for the deck, `expo-file-system` + `expo-sharing`
for the Lightroom hand-off. EAS builds for a device install.

**Consequences.** One codebase also runs on Android and (for the review
screen) in a browser. Native modules are limited to what Expo ships.

## ADR-003: Picks reach Lightroom through the iOS share sheet first

**Context.** Three ways to get an ARW into Lightroom:

1. **Lightroom cloud API** (`PUT /v2/catalogs/{id}/assets/{id}/master`).
   Cleanest, fully server-side, but the API is gated: you must apply for
   Lightroom Services access in the Adobe Developer Console and user reports
   say it's not available on trial/individual plans. High risk of being stuck.
2. **iOS share sheet → "Add to Lightroom".** Lightroom mobile ships a share
   extension that accepts RAW files. Works today with zero approvals, syncs to
   the cloud catalog and on to Lightroom desktop. Costs one tap per batch and
   the download goes through the phone.
3. **Desktop watched folder.** A small CLI pulls `pick` RAWs from S3 into a
   folder that Lightroom Classic auto-imports. Best for Classic users, no phone
   bandwidth, but needs a machine running.

**Decision.** Ship (2) in v1. Add (3) as `tools/lightroom-sync` when someone
needs Classic. Keep (1) as a stretch goal and request API access early since
approval is the long pole.

## ADR-004: Previews come from the embedded JPEG, not a RAW decode

**Context.** Verified on a real a7C II file (`DSC02429.ARW` from raw.pixls.us):
the ARW embeds a 7008×4672 JPEG (~6.7 MB). A full LibRaw demosaic would take
seconds and ~1 GB of memory per image; extracting the embedded JPEG takes
milliseconds.

**Decision.** `rawpy.extract_thumb()` → Pillow resize to 2048 px and 400 px
long edge. The preview reflects the camera's JPEG rendering (picture profile,
white balance), which is exactly what you want when culling.

## ADR-005: One S3 bucket with prefixes, one DynamoDB table

Separate buckets buy nothing at this scale. `raw/`, `previews/`, `thumbs/`
prefixes in one bucket; the S3 → Lambda notification is filtered to `raw/` so
writing previews cannot re-trigger the function. One table with a `byStatus`
GSI covers the only query pattern (give me the next N unreviewed, oldest
first).
