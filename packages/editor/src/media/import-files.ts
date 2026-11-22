import {
  newId,
  AUDIO_SIZE,
  fitBox,
  computePeaks,
  fitMediaSize,
  isMedia,
  type Scene,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';

/** New images are scaled so their longer side is at most this (world units). */
export const IMAGE_MAX_SIZE = 480;
/** Waveform resolution stored with the element. */
export const WAVE_BARS = 120;
/** Corner radius of new images (world units); changeable like any corner radius. */
export const IMAGE_RADIUS = 6;

/**
 * Where a file lives. Locally an object URL; in the app this is where an upload to
 * storage (S3) plugs in, returning the file's URL.
 */
export type Uploader = (file: Blob) => Promise<string>;
export const localUploader: Uploader = async (file) => URL.createObjectURL(file);

/**
 * Revokes `blob:` URLs once no element in the scene refers to them any more, so the files
 * of deleted images/audio (or of a replaced board) don't stay in memory until the tab closes.
 * Returns the unsubscribe function.
 */
export function revokeUnusedObjectUrls(
  scene: Scene,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): () => void {
  const sourceOf = new Map<string, string>();
  const references = new Map<string, number>();
  const release = (source: string) => {
    const count = (references.get(source) ?? 1) - 1;
    if (count > 0) references.set(source, count);
    else {
      references.delete(source);
      revoke(source);
    }
  };
  const track = (id: string, source: string | undefined) => {
    const old = sourceOf.get(id);
    if (old === source) return;
    if (old !== undefined) release(old);
    if (source === undefined) sourceOf.delete(id);
    else {
      sourceOf.set(id, source);
      references.set(source, (references.get(source) ?? 0) + 1);
    }
  };
  for (const element of scene.all())
    if (isMedia(element) && element.media.source.startsWith('blob:'))
      track(element.id, element.media.source);
  return scene.subscribe((changes) => {
    for (const id of changes.removed) track(id, undefined);
    for (const element of [...changes.added, ...changes.updated]) {
      const source =
        isMedia(element) && element.media.source.startsWith('blob:')
          ? element.media.source
          : undefined;
      track(element.id, source);
    }
  });
}

export async function imageElement(
  file: Blob,
  name: string,
  center: Vec2,
  z: number,
  upload: Uploader = localUploader,
): Promise<ShapeElement> {
  const bitmap = await createImageBitmap(file);
  const naturalWidth = bitmap.width;
  const naturalHeight = bitmap.height;
  bitmap.close();
  const { width, height } = fitMediaSize(naturalWidth, naturalHeight, IMAGE_MAX_SIZE);
  return {
    id: newId('img'),
    type: 'image',
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    rotation: 0,
    z,
    fill: 0,
    stroke: 0,
    strokeWidth: 0,
    radius: IMAGE_RADIUS,
    media: { source: await upload(file), mime: file.type, name, naturalWidth, naturalHeight },
  };
}

/**
 * Puts another file into an image element, as Figma's "Replace image": the box stays,
 * the new picture fills it (a crop of the old one doesn't apply to the new one).
 * One scene change; returns false if the element isn't an image.
 */
export async function replaceImage(
  scene: Scene,
  id: string,
  file: Blob,
  name: string,
  upload: Uploader = localUploader,
): Promise<boolean> {
  const bitmap = await createImageBitmap(file);
  const naturalWidth = bitmap.width;
  const naturalHeight = bitmap.height;
  bitmap.close();
  const source = await upload(file);
  const element = scene.get(id);
  if (!element || element.type !== 'image') return false;
  const media = { source, mime: file.type, name, naturalWidth, naturalHeight };
  scene.update(
    id,
    element.imageFit === 'fit'
      ? // Fit: the frame refits around the new picture, within the old frame.
        { media, ...fitBox(element, { width: naturalWidth, height: naturalHeight }) }
      : { media, imageFit: 'fill', crop: undefined },
  );
  return true;
}

/** Decodes the audio once to measure it and compute the stored waveform. */
export async function analyzeAudio(file: Blob): Promise<{ peaks?: number[]; duration?: number }> {
  try {
    const context = new OfflineAudioContext(1, 1, 44100);
    const audio = await context.decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) =>
      audio.getChannelData(channel),
    );
    return { peaks: computePeaks(channels, WAVE_BARS), duration: audio.duration };
  } catch {
    return {}; // undecodable here: the player still works, with a flat waveform
  }
}

export async function audioElement(
  file: Blob,
  name: string,
  center: Vec2,
  z: number,
  upload: Uploader = localUploader,
): Promise<ShapeElement> {
  const { peaks, duration } = await analyzeAudio(file);
  const { width, height } = AUDIO_SIZE;
  return {
    id: newId('aud'),
    type: 'audio',
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    rotation: 0,
    z,
    fill: 0,
    stroke: 0,
    strokeWidth: 0,
    radius: 0,
    volume: 0.8,
    media: { source: await upload(file), mime: file.type, name, duration, peaks },
  };
}

export const isImageFile = (file: Blob) => file.type.startsWith('image/');
export const isAudioFile = (file: Blob) => file.type.startsWith('audio/');

/**
 * Adds images and audio files to the scene around `center`, stacked so they don't
 * overlap. Other file types are ignored. Returns the new element ids.
 *
 * A file that can't be read (corrupt, unsupported format, too large to decode) doesn't
 * stop the others: it is reported through `onError` and skipped.
 */
export async function importFiles(
  files: File[],
  center: Vec2,
  scene: Scene,
  upload: Uploader = localUploader,
  onError: (file: File, error: unknown) => void = () => undefined,
): Promise<string[]> {
  const ids: string[] = [];
  let y = center.y;
  for (const file of files) {
    const at = { x: center.x, y };
    const z = scene.maxZ() + 1;
    let element: ShapeElement | null = null;
    try {
      if (isImageFile(file)) element = await imageElement(file, file.name, at, z, upload);
      else if (isAudioFile(file)) element = await audioElement(file, file.name, at, z, upload);
    } catch (error) {
      onError(file, error);
      continue;
    }
    if (!element) continue;
    // Keep the first one centred at `center`, stack the rest below.
    element.y = y - (ids.length === 0 ? element.height / 2 : 0);
    y = element.y + element.height + 24;
    scene.add(element);
    ids.push(element.id);
  }
  return ids;
}

/** A short synthetic WAV (PCM16 mono): chords with a varying envelope, for demos and tests. */
export function synthWav(seconds = 4, sampleRate = 22050): Blob {
  const count = Math.floor(seconds * sampleRate);
  const data = new Int16Array(count);
  for (let index = 0; index < count; index++) {
    const time = index / sampleRate;
    const envelope = 0.15 + 0.85 * Math.abs(Math.sin(time * 2.3)) * Math.exp(-((time % 1.1) * 1.5));
    const sample =
      Math.sin(2 * Math.PI * 220 * time) * 0.5 +
      Math.sin(2 * Math.PI * 277 * time) * 0.3 +
      Math.sin(2 * Math.PI * 330 * time) * 0.2;
    data[index] = Math.max(-1, Math.min(1, sample * envelope)) * 32767;
  }
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) =>
    [...value].forEach((character, index) =>
      header.setUint8(offset + index, character.charCodeAt(0)),
    );
  text(0, 'RIFF');
  header.setUint32(4, 36 + data.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, data.byteLength, true);
  return new Blob([header.buffer, data.buffer], { type: 'audio/wav' });
}
