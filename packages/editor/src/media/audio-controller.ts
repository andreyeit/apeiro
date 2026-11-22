import { isAllowedMediaSource, isMedia, type Scene } from '@apeiro/core';

export interface AudioStateSink {
  setAudioState(id: string, state: { playing: boolean; progress: number }): void;
}

/** The parts of HTMLAudioElement the controller uses (lets tests pass a fake). */
export interface AudioPlayer {
  src: string;
  volume: number;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: 'ended', callback: () => void): void;
}

/**
 * Plays audio elements. Playback is local to this viewer (not synced); the volume
 * lives on the element, so changing it is a normal scene update. Only one element
 * plays at a time. Pushes play state/progress to the renderer every frame while playing.
 */
export class AudioController {
  private players = new Map<string, AudioPlayer>();
  /** The source each player was created for. */
  private sources = new Map<string, string>();
  private frame = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly scene: Scene,
    private readonly sink: AudioStateSink,
    private readonly create: (source: string) => AudioPlayer = (source) => new Audio(source),
    /** Origins audio may be loaded from besides blob:, data: and the page's own. */
    private readonly allowedOrigins: readonly string[] = [],
  ) {
    this.unsubscribe = scene.subscribe((changes) => {
      for (const element of changes.updated) {
        const player = this.players.get(element.id);
        if (!player) continue;
        // A different file (or no longer audio): the old player must not keep playing it.
        if (
          !isMedia(element) ||
          element.type !== 'audio' ||
          element.media.source !== this.sources.get(element.id)
        ) {
          this.stop(element.id);
          this.sink.setAudioState(element.id, { playing: false, progress: 0 });
          continue;
        }
        player.volume = element.volume ?? 1;
      }
      for (const id of changes.removed) this.stop(id);
    });
  }

  isPlaying(id: string): boolean {
    const player = this.players.get(id);
    return !!player && !player.paused;
  }

  toggle(id: string): void {
    if (this.isPlaying(id)) {
      this.players.get(id)!.pause();
      this.push(id);
      return;
    }
    for (const [other, player] of this.players) {
      if (other !== id && !player.paused) {
        player.pause();
        this.push(other);
      }
    }
    const player = this.player(id);
    if (!player) return;
    void player.play().catch(() => this.push(id));
    this.push(id);
    this.loop();
  }

  /** Jumps to a position (0..1); works while paused too. */
  seek(id: string, fraction: number): void {
    const player = this.player(id);
    if (!player) return;
    const duration = this.duration(id, player);
    if (duration > 0) player.currentTime = fraction * duration;
    this.push(id, fraction);
  }

  /** Stops every player and the scene subscription. */
  dispose(): void {
    this.unsubscribe();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const id of [...this.players.keys()]) this.stop(id);
  }

  stop(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    player.pause();
    this.players.delete(id);
    this.sources.delete(id);
  }

  private player(id: string): AudioPlayer | null {
    let player = this.players.get(id);
    if (player) return player;
    const element = this.scene.get(id);
    if (!element || !isMedia(element) || element.type !== 'audio') return null;
    // The src comes from element data: don't let it point the player at arbitrary hosts.
    if (!isAllowedMediaSource(element.media.source, this.allowedOrigins)) return null;
    player = this.create(element.media.source);
    player.volume = element.volume ?? 1;
    player.addEventListener('ended', () => {
      player!.currentTime = 0;
      this.push(id, 0);
    });
    this.players.set(id, player);
    this.sources.set(id, element.media.source);
    return player;
  }

  private duration(id: string, player: AudioPlayer): number {
    if (Number.isFinite(player.duration) && player.duration > 0) return player.duration;
    const element = this.scene.get(id);
    return element && isMedia(element) ? (element.media.duration ?? 0) : 0;
  }

  private push(id: string, progress?: number): void {
    const player = this.players.get(id);
    if (!player) return;
    const duration = this.duration(id, player);
    this.sink.setAudioState(id, {
      playing: !player.paused,
      progress: progress ?? (duration > 0 ? Math.min(1, player.currentTime / duration) : 0),
    });
  }

  private loop(): void {
    if (this.frame) return;
    const tick = () => {
      this.frame = 0;
      let any = false;
      for (const [id, player] of this.players) {
        if (player.paused) continue;
        any = true;
        this.push(id);
      }
      if (any) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
}
