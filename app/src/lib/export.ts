import { Platform } from 'react-native';
import type { Photo } from './types';

/**
 * Getting a photo out of Picket onto the phone. What leaves the cloud is the JPEG preview the
 * preview Lambda made from the camera's embedded JPEG: 2048 px on the long edge, usually well
 * under 1 MB, the camera's own rendering. The RAW stays in S3 by design (ADR-006); the only
 * route to it is Lightroom. The native modules are loaded on demand so the web build (UI
 * previews) never touches them.
 */

export const EXPORT_NOTE = 'JPEG preview, 2048 px on the long edge, under 1 MB. The RAW stays in the cloud and goes to Lightroom only.';

const jpegName = (photo: Photo) => photo.fileName.replace(/\.[^.]+$/, '') + '.jpg';

/** Download the preview into the app's cache as <DSC01234>.jpg and return its file URI. */
async function downloadPreview(photo: Photo): Promise<string> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const dir = new Directory(Paths.cache, 'picket-exports');
  if (!dir.exists) dir.create();
  const file = new File(dir, jpegName(photo));
  if (file.exists) file.delete(); // the preview can be replaced by a re-sent frame
  const saved = await File.downloadFileAsync(photo.previewUrl, file);
  return saved.uri;
}

export type SaveOutcome = 'saved' | 'denied';

/** Put the JPEG preview in the phone's photo library (add-only permission, no read access asked). */
export async function saveToPhotos(photo: Photo): Promise<SaveOutcome> {
  if (Platform.OS === 'web') {
    globalThis.open?.(photo.previewUrl, '_blank');
    return 'saved';
  }
  const MediaLibrary = await import('expo-media-library');
  const permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
  if (!permission.granted) return 'denied';
  const uri = await downloadPreview(photo);
  await MediaLibrary.Asset.create(uri);
  return 'saved';
}

/** The system share sheet with the JPEG preview (Messages, AirDrop, Save Image, ...). */
export async function sharePreview(photo: Photo): Promise<boolean> {
  if (Platform.OS === 'web') {
    const nav = globalThis.navigator as Navigator | undefined;
    if (nav?.share) await nav.share({ title: photo.fileName, url: photo.previewUrl });
    else globalThis.open?.(photo.previewUrl, '_blank');
    return true;
  }
  const Sharing = await import('expo-sharing');
  if (!(await Sharing.isAvailableAsync())) return false;
  const uri = await downloadPreview(photo);
  await Sharing.shareAsync(uri, { mimeType: 'image/jpeg', UTI: 'public.jpeg', dialogTitle: photo.fileName });
  return true;
}
