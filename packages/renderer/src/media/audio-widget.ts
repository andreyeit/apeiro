import { audioLayout } from '@apeiro/core';

/** Playback state of one audio element, owned by whoever plays the audio. */
export interface AudioVisualState {
  playing: boolean;
  /** 0..1 */
  progress: number;
}

/**
 * Colours of the player controls. Defaults follow the board's light theme (zinc neutrals,
 * like the toolbar and panels); the app passes its dark tokens through `setAudioStyle`.
 */
export interface AudioWidgetStyle {
  /** Play button, played part of the waveform, volume level. */
  primary: string;
  /** Icon on the play button. */
  primaryForeground: string;
  /** Unplayed waveform bars and the empty volume track. */
  track: string;
  /** Speaker icon and time label. */
  ink: string;
  /** Font family of the time label. */
  font: string;
}

export const DEFAULT_AUDIO_STYLE: AudioWidgetStyle = {
  primary: '#18181b',
  primaryForeground: '#fafafa',
  track: '#d4d4d8',
  ink: '#71717a',
  font: "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace",
};

/**
 * Optional card behind the controls, from the element's own fill and border. Absent
 * (or transparent / zero width) by default: the player sits right on the board.
 */
export interface AudioCard {
  /** CSS colour, or null for no fill. */
  fill: string | null;
  /** CSS colour, or null for no border. */
  stroke: string | null;
  /** Border width, world units. */
  strokeWidth: number;
  /** Corner radius, world units. */
  radius: number;
}

export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BAR_PITCH = 3.6; // world units per waveform bar (bar + gap)
const BAR_WIDTH = 1.6;

/** `m:ss` (or `h:mm:ss`) for a time in seconds. */
export function formatAudioTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const secondsText = String(totalSeconds % 60).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}:${secondsText}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${secondsText}`;
}

/**
 * Draws the audio player: a small round play/pause button, a fine waveform (played part
 * in the primary colour), a time label, a line speaker icon and a hairline volume slider.
 * Transparent by default; `card` adds a fill and/or border behind it. `scale` maps world
 * units to canvas pixels; `duration` (seconds, 0 if unknown) feeds the time label.
 */
export function drawAudioWidget(
  context: Context2D,
  width: number,
  height: number,
  scale: number,
  peaks: readonly number[] | undefined,
  volume: number,
  state: AudioVisualState,
  style: AudioWidgetStyle = DEFAULT_AUDIO_STYLE,
  duration = 0,
  card?: AudioCard,
): void {
  const layout = audioLayout(width, height);
  context.save();
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineCap = 'round';
  context.lineJoin = 'round';

  // Card: only what the element asks for. The border stays inside the box.
  if (card && (card.fill || (card.stroke && card.strokeWidth > 0))) {
    const strokeWidth = card.stroke ? Math.min(card.strokeWidth, height / 4) : 0;
    context.beginPath();
    roundedRectangle(
      context,
      strokeWidth / 2,
      strokeWidth / 2,
      width - strokeWidth,
      height - strokeWidth,
      Math.max(0, card.radius - strokeWidth / 2),
    );
    if (card.fill) {
      context.fillStyle = card.fill;
      context.fill();
    }
    if (card.stroke && strokeWidth > 0) {
      context.lineWidth = strokeWidth;
      context.strokeStyle = card.stroke;
      context.stroke();
    }
  }

  // Play / pause: small filled disc with a light glyph.
  const { centerX, centerY, radius } = layout.play;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fillStyle = style.primary;
  context.fill();
  context.fillStyle = style.primaryForeground;
  context.strokeStyle = style.primaryForeground;
  if (state.playing) {
    const barWidth = radius * 0.16;
    const barHeight = radius * 0.72;
    context.beginPath();
    roundedRectangle(
      context,
      centerX - radius * 0.2 - barWidth / 2,
      centerY - barHeight / 2,
      barWidth,
      barHeight,
      barWidth / 2,
    );
    roundedRectangle(
      context,
      centerX + radius * 0.2 - barWidth / 2,
      centerY - barHeight / 2,
      barWidth,
      barHeight,
      barWidth / 2,
    );
    context.fill();
  } else {
    // Slightly rounded triangle, nudged right so it looks optically centred.
    const size = radius * 0.36;
    context.beginPath();
    context.moveTo(centerX - size * 0.6, centerY - size);
    context.lineTo(centerX + size * 1.0, centerY);
    context.lineTo(centerX - size * 0.6, centerY + size);
    context.closePath();
    context.lineWidth = radius * 0.08;
    context.stroke();
    context.fill();
  }

  // Waveform: fine bars resampled from the stored peaks to fit the width.
  const wave = layout.wave;
  const bars = Math.max(1, Math.floor(wave.width / BAR_PITCH));
  const offset = (wave.width - bars * BAR_PITCH) / 2;
  const played = state.progress * bars;
  for (const pass of [false, true]) {
    context.fillStyle = pass ? style.primary : style.track;
    context.beginPath();
    for (let bar = 0; bar < bars; bar++) {
      if (bar < played !== pass) continue;
      const peak = peaks && peaks.length > 0 ? sample(peaks, (bar + 0.5) / bars) : 0.15;
      const barHeight = Math.max(BAR_WIDTH, peak * wave.height);
      const x = wave.x + offset + bar * BAR_PITCH + (BAR_PITCH - BAR_WIDTH) / 2;
      roundedRectangle(
        context,
        x,
        wave.y + (wave.height - barHeight) / 2,
        BAR_WIDTH,
        barHeight,
        BAR_WIDTH / 2,
      );
    }
    context.fill();
  }

  // Time: elapsed while playing or paused mid-track, otherwise the length.
  const time = layout.time;
  const started = state.playing || state.progress > 0;
  const label =
    duration > 0 ? formatAudioTime(started ? state.progress * duration : duration) : '--:--';
  context.font = `400 ${time.size}px ${style.font}`;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.fillStyle = style.ink;
  context.fillText(label, time.x + time.width, time.y, time.width);

  // Speaker: line icon, like the toolbar icons.
  const speaker = layout.speaker;
  const half = speaker.size / 2;
  context.strokeStyle = style.ink;
  context.lineWidth = Math.max(0.9, half * 0.14);
  context.beginPath();
  context.moveTo(speaker.centerX - half, speaker.centerY - half * 0.32);
  context.lineTo(speaker.centerX - half * 0.5, speaker.centerY - half * 0.32);
  context.lineTo(speaker.centerX + half * 0.1, speaker.centerY - half * 0.82);
  context.lineTo(speaker.centerX + half * 0.1, speaker.centerY + half * 0.82);
  context.lineTo(speaker.centerX - half * 0.5, speaker.centerY + half * 0.32);
  context.lineTo(speaker.centerX - half, speaker.centerY + half * 0.32);
  context.closePath();
  context.stroke();
  const waves = volume <= 0 ? 0 : volume < 0.5 ? 1 : 2;
  for (let wave = 1; wave <= waves; wave++) {
    context.beginPath();
    context.arc(
      speaker.centerX + half * 0.15,
      speaker.centerY,
      half * 0.38 * wave + half * 0.12,
      -Math.PI / 4,
      Math.PI / 4,
    );
    context.stroke();
  }
  if (volume <= 0) {
    context.beginPath();
    context.moveTo(speaker.centerX + half * 0.45, speaker.centerY - half * 0.32);
    context.lineTo(speaker.centerX + half * 1.05, speaker.centerY + half * 0.32);
    context.moveTo(speaker.centerX + half * 1.05, speaker.centerY - half * 0.32);
    context.lineTo(speaker.centerX + half * 0.45, speaker.centerY + half * 0.32);
    context.stroke();
  }

  // Volume: hairline track, filled part and a small knob.
  const volumeLayout = layout.volume;
  const trackHeight = Math.max(1, volumeLayout.knob * 0.32);
  context.fillStyle = style.track;
  context.beginPath();
  roundedRectangle(
    context,
    volumeLayout.x,
    volumeLayout.y - trackHeight / 2,
    volumeLayout.width,
    trackHeight,
    trackHeight / 2,
  );
  context.fill();
  context.fillStyle = style.primary;
  context.beginPath();
  roundedRectangle(
    context,
    volumeLayout.x,
    volumeLayout.y - trackHeight / 2,
    Math.max(trackHeight, volumeLayout.width * volume),
    trackHeight,
    trackHeight / 2,
  );
  context.fill();
  context.beginPath();
  context.arc(
    volumeLayout.x + volumeLayout.width * volume,
    volumeLayout.y,
    volumeLayout.knob,
    0,
    Math.PI * 2,
  );
  context.fill();

  context.restore();
}

/** Linear sample of `values` at `fraction` (0..1) of the way through them. */
function sample(values: readonly number[], fraction: number): number {
  const position = fraction * (values.length - 1);
  const index = Math.floor(position);
  const before = values[index] ?? 0;
  const after = values[Math.min(values.length - 1, index + 1)] ?? before;
  return before + (after - before) * (position - index);
}

function roundedRectangle(
  context: Context2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  // A player squeezed narrower than its border gives negative sizes; a negative radius
  // makes `arcTo` throw (IndexSizeError).
  width = Math.max(0, width);
  height = Math.max(0, height);
  const clampedRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.moveTo(x + clampedRadius, y);
  context.arcTo(x + width, y, x + width, y + height, clampedRadius);
  context.arcTo(x + width, y + height, x, y + height, clampedRadius);
  context.arcTo(x, y + height, x, y, clampedRadius);
  context.arcTo(x, y, x + width, y, clampedRadius);
  context.closePath();
}
