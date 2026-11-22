import { worldToLocal } from '../geometry/frame';
import { clamp } from '../geometry/numbers';
import type { Vec2 } from '../geometry/vector';
import type { ShapeElement } from './element';

/** File behind an image or audio element. Plain data, synced like the rest of the element. */
export interface MediaFile {
  /** Where to load the file from: an object URL locally, a storage (S3) URL in the app. */
  source: string;
  mime?: string;
  name?: string;
  /** Intrinsic size of an image, px. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Audio length, seconds. */
  duration?: number;
  /**
   * Audio waveform: peak amplitude per bar, 0..1. Computed once on import and stored
   * with the element, so other viewers can draw it without downloading and decoding the file.
   */
  peaks?: number[];
}

/** Default size of a new audio player, world units. */
export const AUDIO_SIZE = { width: 320, height: 40 } as const;

/** Scales an intrinsic size down so its longer side is at most `maximum` (never up). */
export function fitMediaSize(
  width: number,
  height: number,
  maximum: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, maximum / Math.max(safeWidth, safeHeight));
  return { width: safeWidth * scale, height: safeHeight * scale };
}

/** Parts of the audio player in the element's local box (top-left origin, unrotated). */
export interface AudioLayout {
  /** Card the controls sit on: the whole box with rounded corners. */
  card: { radius: number };
  play: { centerX: number; centerY: number; radius: number };
  wave: { x: number; y: number; width: number; height: number };
  /** Time label, right-aligned at `x + width`, vertically centred on `y`; `size` is the font size. */
  time: { x: number; y: number; width: number; size: number };
  speaker: { centerX: number; centerY: number; size: number };
  /** Volume track: the knob moves along it; value 0 at `x`, 1 at `x + width`. */
  volume: { x: number; y: number; width: number; knob: number };
}

/** Layout of the player for a box size. Shared by the renderer and hit testing. */
export function audioLayout(width: number, height: number): AudioLayout {
  // The controls fill the box height, so the selection frame hugs the player.
  const padding = height * 0.08;
  const gap = height * 0.3;
  const radius = height * 0.42;
  const play = { centerX: padding + radius, centerY: height / 2, radius };
  const volumeWidth = Math.min(width * 0.24, height * 2.4);
  const volumeX = width - padding - volumeWidth;
  const speakerSize = height * 0.36;
  const speaker = { centerX: volumeX + speakerSize * 0.5, centerY: height / 2, size: speakerSize };
  const knob = height * 0.1;
  const trackX = volumeX + speakerSize * 1.6;
  const volume = {
    x: trackX,
    y: height / 2,
    width: Math.max(4, width - padding - knob - trackX),
    knob,
  };
  const timeWidth = height * 1.1;
  const time = {
    x: volumeX - gap - timeWidth,
    y: height / 2,
    width: timeWidth,
    size: height * 0.3,
  };
  const waveX = play.centerX + radius + gap;
  const wave = {
    x: waveX,
    y: height * 0.2,
    width: Math.max(8, time.x - gap * 0.5 - waveX),
    height: height * 0.6,
  };
  // A card (if the element has a fill or border) is a pill around the round play button.
  return { card: { radius: height / 2 }, play, wave, time, speaker, volume };
}

/** World point → element-local point (top-left origin, unrotated). */
function toBoxLocal(element: ShapeElement, world: Vec2): Vec2 {
  const local = worldToLocal(element, world);
  return { x: local.x + element.width / 2, y: local.y + element.height / 2 };
}

const clampFraction = (value: number) => clamp(value, 0, 1);

export type AudioHit =
  | { part: 'play' }
  | { part: 'wave'; fraction: number }
  | { part: 'volume'; value: number };

/** Which control of an audio player is under a world point (`tolerance` in world units). */
export function hitTestAudio(element: ShapeElement, world: Vec2, tolerance = 0): AudioHit | null {
  if (element.type !== 'audio') return null;
  const point = toBoxLocal(element, world);
  const layout = audioLayout(element.width, element.height);
  if (
    Math.hypot(point.x - layout.play.centerX, point.y - layout.play.centerY) <=
    layout.play.radius + tolerance
  )
    return { part: 'play' };
  const volume = layout.volume;
  if (
    point.x >= volume.x - volume.knob - tolerance &&
    point.x <= volume.x + volume.width + volume.knob + tolerance &&
    Math.abs(point.y - volume.y) <= volume.knob * 2.2 + tolerance
  ) {
    return { part: 'volume', value: clampFraction((point.x - volume.x) / volume.width) };
  }
  const wave = layout.wave;
  if (
    point.x >= wave.x - tolerance &&
    point.x <= wave.x + wave.width + tolerance &&
    point.y >= wave.y - tolerance &&
    point.y <= wave.y + wave.height + tolerance
  ) {
    return { part: 'wave', fraction: clampFraction((point.x - wave.x) / wave.width) };
  }
  return null;
}

/** Seek position (0..1) for a world point, for dragging along the waveform past its ends. */
export function audioSeekAt(element: ShapeElement, world: Vec2): number {
  const layout = audioLayout(element.width, element.height);
  return clampFraction((toBoxLocal(element, world).x - layout.wave.x) / layout.wave.width);
}

/** Volume (0..1) for a world point, for dragging the knob past the track's ends. */
export function audioVolumeAt(element: ShapeElement, world: Vec2): number {
  const layout = audioLayout(element.width, element.height);
  return clampFraction((toBoxLocal(element, world).x - layout.volume.x) / layout.volume.width);
}

/**
 * Peak amplitude per bar from decoded channel data, normalised so the loudest bar is 1.
 * Rounded to 3 decimals to keep the stored element small.
 */
export function computePeaks(channels: Float32Array[], bars: number): number[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || bars <= 0) return [];
  const peaks = new Array<number>(bars).fill(0);
  const bucket = length / bars;
  for (let bar = 0; bar < bars; bar++) {
    const from = Math.floor(bar * bucket);
    const to = Math.max(from + 1, Math.floor((bar + 1) * bucket));
    let peak = 0;
    for (const channel of channels) {
      for (let index = from; index < to && index < channel.length; index++) {
        const sample = Math.abs(channel[index]!);
        if (sample > peak) peak = sample;
      }
    }
    peaks[bar] = peak;
  }
  let maximum = 0; // a loop, not Math.max(...peaks): spreading a huge array overflows the stack
  for (const peak of peaks) if (peak > maximum) maximum = peak;
  return maximum > 0 ? peaks.map((peak) => Math.round((peak / maximum) * 1000) / 1000) : peaks;
}

/**
 * Whether a media `source` may be loaded. Element data comes from other participants, so
 * loading any URL would let one of them make every viewer request an arbitrary address
 * (tracking, requests into the viewer's network). Allowed: `blob:`, `data:` images/audio,
 * the page's own origin and the explicitly listed origins (e.g. the storage/CDN).
 */
export function isAllowedMediaSource(
  source: string,
  allowedOrigins: readonly string[] = [],
  pageOrigin: string | undefined = typeof location !== 'undefined' ? location.origin : undefined,
): boolean {
  let url: URL;
  try {
    url = new URL(source, pageOrigin);
  } catch {
    return false;
  }
  if (url.protocol === 'blob:') return true;
  if (url.protocol === 'data:') return /^data:(image|audio)\//i.test(source);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return url.origin === pageOrigin || allowedOrigins.includes(url.origin);
}
