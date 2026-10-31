# Sony a7C II (ILCE-7CM2) setup

Everything below is in **MENU → Network → FTP Transfer → FTP Transfer Func.**
Firmware 2.00 or later is recommended (adds transfer-while-writing and
auto-transfer of protected files). Sony's full guide:
<https://helpguide.sony.net/di/ftp_2360/v1/en/index.html>

## 1. Network

Either:

- **Wi‑Fi** (MENU → Network → Wi‑Fi → Wi‑Fi Connect → On, then Access Point
  Set.) and join your phone's personal hotspot or a venue network. WPA2/WPA3.
- **USB tethering** to the phone (MENU → Network → USB-LAN/Tethering) if the
  hotspot route is flaky.

## 2. FTP server entry

`Server Setting → Server 1`:

| field                  | value                                                        |
|------------------------|--------------------------------------------------------------|
| Display Name           | `picket`                                                     |
| Destination Settings → Host Name | `ftp.picket.photos` (CDK output `FtpHost`; falls back to the Elastic IP when no domain is configured) |
| Secure Protocol        | **On** (FTPES, explicit FTP over TLS)                        |
| Root Certificate Error | try `Does Not Connect` (the receiver serves a Let's Encrypt certificate once DNS is live); switch to `Connect` if the camera rejects the chain |
| Port                   | `21`                                                         |
| Directory Settings → Specify Directory | `/` (leave default)                           |
| Directory Hierarchy    | `Standard`                                                   |
| Same File Name         | `Does Not Overwrite`                                         |
| User Info → User       | `camera` (shown in the app's Camera tab)                      |
| User Info → Password   | from the app's **Camera** tab (set one that's easy to type there; the receiver switches immediately) |
| Passive Mode           | **On**                                                       |

Then `Server Setting → Server 1 → Connect` and confirm you see **Connected**.

### About the certificate

With a domain configured, the receiver obtains a Let's Encrypt certificate for
`ftp.picket.photos` within about 15 minutes of the first deploy and renews it
automatically. Whether the camera trusts Let's Encrypt's root depends on
Sony's built-in root store, so try *Does Not Connect* first. If the camera
shows a certificate error, use *Connect*: the connection is still encrypted,
the camera just skips verifying who it's talking to. Until DNS is delegated the
receiver serves a self-signed certificate, which always needs *Connect*.

## 3. Transfer rules

- `FTP Function` → **On**
- `Auto FTP Transfer` → **On**
- `Auto FTP Target` → still images: **All** (or **Protect Only** to send just
  what you protect in-camera)
- `RAW+J/H Transfer Target` → **RAW** (only matters when shooting RAW+JPEG)
- `FTP Power Save` → On if battery matters; the camera reconnects on demand

Shoot RAW only (MENU → Shooting → Image Quality → File Format → RAW) and the
camera will upload each frame as it's written. If the server is unreachable the
images queue and transfer when the connection comes back.

## Tips

- Compressed RAW (~35 MB) halves upload time versus lossless/uncompressed.
- Check progress under FTP Transfer → `FTP Transfer Result` /
  `Display FTP Transfer Status`.
- For a venue Wi‑Fi with a captive portal, use the phone hotspot instead.
