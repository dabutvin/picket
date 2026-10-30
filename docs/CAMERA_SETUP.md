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
| Destination Settings → Host Name | the receiver's Elastic IP (CDK output `ReceiverIp`), or your DNS name |
| Secure Protocol        | **On** (FTPES, explicit FTP over TLS)                        |
| Root Certificate Error | `Does Not Connect` once you've imported the cert (below); `Connect` to test |
| Port                   | `21`                                                         |
| Directory Settings → Specify Directory | `/` (leave default)                           |
| Directory Hierarchy    | `Standard`                                                   |
| Same File Name         | `Does Not Overwrite`                                         |
| User Info → User       | `camera` (CDK output `FtpUser`)                              |
| User Info → Password   | from Secrets Manager (CDK output `FtpPasswordSecret`)        |
| Passive Mode           | **On**                                                       |

Then `Server Setting → Server 1 → Connect` and confirm you see **Connected**.

### Importing the server certificate

The receiver uses a self-signed certificate by default. To have the camera
verify it, export the cert (`infra/ingest/export-cert.sh`, or copy
`/etc/ssl/private/pure-ftpd.pem` from the instance), save it as
`PRIVATE/SONY/CERT/cacert.pem` ... (follow MENU → Network → Network Option →
Import Root Certificate) on a memory card, and import. Until then set
*Root Certificate Error → Connect*.

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
