import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { Api } from './api';

/** Apple's system UTI for Sony RAW; lets the share sheet offer "Add to Lightroom". */
const SONY_ARW_UTI = 'com.sony.arw-raw-image';

/**
 * Download one RAW into the cache and hand it to the share sheet. The user taps
 * Lightroom there (see docs/DECISIONS.md ADR-003 for why this and not the API).
 * Returns the local file so the caller can delete it afterwards.
 */
export async function sendToLightroom(api: Api, photoId: string, onProgress?: (fraction: number) => void): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');

  const { url, fileName } = await api.rawUrl(photoId);
  const dir = new Directory(Paths.cache, 'picks');
  if (!dir.exists) dir.create();
  const target = new File(dir, fileName);
  if (target.exists) target.delete();

  onProgress?.(0);
  const file = await File.downloadFileAsync(url, target);
  onProgress?.(1);

  try {
    await Sharing.shareAsync(file.uri, {
      UTI: SONY_ARW_UTI,
      mimeType: 'image/x-sony-arw',
      dialogTitle: `Send ${fileName} to Lightroom`,
    });
  } finally {
    // The share extension has copied the file by the time the sheet closes.
    try {
      file.delete();
    } catch {
      /* best effort */
    }
  }
}
