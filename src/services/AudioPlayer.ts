import { AudioContextManager } from './AudioContextManager';

/**
 * AudioPlayer handles output audio playback for Aanya.
 * Plays 24kHz PCM16 Little-Endian audio chunks from Gemini Live API
 * using gapless Web Audio API scheduling.
 */

export class AudioPlayer {
  private audioCtx: AudioContext | null = null;
  private nextStartTime: number = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private analyser: AnalyserNode | null = null;
  private animationFrameId: number | null = null;
  private chunkCounter: number = 0;

  private onPlaybackStateChange?: (isPlaying: boolean) => void;
  private onVolumeChange?: (volume: number) => void;

  constructor(
    onPlaybackStateChange?: (isPlaying: boolean) => void,
    onVolumeChange?: (volume: number) => void
  ) {
    this.onPlaybackStateChange = onPlaybackStateChange;
    this.onVolumeChange = onVolumeChange;
  }

  public isPlaying(): boolean {
    return this.activeSources.length > 0;
  }

  public isReady(): boolean {
    return !!this.audioCtx && (this.audioCtx.state as string) === 'running';
  }

  public getAudioContextState(): string {
    return this.audioCtx ? this.audioCtx.state : 'uninitialized';
  }

  public async unlockContext(): Promise<void> {
    this.initContext();
    if (this.audioCtx) {
      await AudioContextManager.ensureResumed(this.audioCtx, 'AudioPlayer');
    }
  }

  private initContext(): void {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = AudioContextManager.getSharedAudioContext();

      if (!this.analyser) {
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.connect(this.audioCtx.destination);
      }

      AudioContextManager.register('AudioPlayer', this.audioCtx);
      this.startVolumeMonitoring();
      console.log(`[AUDIO CONTEXT] AudioPlayer bound to shared AudioContext | State: ${this.audioCtx.state}`);
      console.log('[AUDIO OUTPUT READY] AudioPlayer output pipeline active');
    }

    if ((this.audioCtx.state as string) !== 'running') {
      AudioContextManager.ensureResumed(this.audioCtx, 'AudioPlayer');
    }
  }

  public async playChunk(base64Audio: string): Promise<void> {
    this.initContext();
    if (!this.audioCtx || !this.analyser) {
      console.error("[STAGE 7 AUDIO PLAYER & STAGE 8 OUTPUT] Failure: true | AudioContext or Analyser not initialized.");
      return;
    }

    if ((this.audioCtx.state as string) !== 'running') {
      console.log(`[STAGE 2 AUDIO CONTEXT] AudioPlayer context is '${this.audioCtx.state}'. Resuming prior to playback...`);
      await AudioContextManager.ensureResumed(this.audioCtx, 'AudioPlayer');
    }

    this.chunkCounter++;
    const chunkId = this.chunkCounter;

    try {
      const audioBuffer = this.base64ToAudioBuffer(base64Audio, this.audioCtx);
      if (!audioBuffer || audioBuffer.length === 0 || audioBuffer.duration === 0) {
        console.warn(`[STAGE 7 AUDIO PLAYER] Failure: true | Chunk #${chunkId} produced empty/invalid AudioBuffer`);
        return;
      }

      console.log(`[STAGE 7 AUDIO PLAYER PLAYBACK] Success: true | Chunk #${chunkId} | Base64 Chars: ${base64Audio.length} | Duration: ${audioBuffer.duration.toFixed(3)}s | AudioContext State: ${this.audioCtx.state}`);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.analyser);
      source.connect(this.audioCtx.destination);

      const currentTime = this.audioCtx.currentTime;
      if (this.nextStartTime < currentTime) {
        this.nextStartTime = currentTime;
      }

      const scheduledTime = this.nextStartTime;

      try {
        source.start(scheduledTime);
        console.log(`[STAGE 8 AUDIO OUTPUT DEVICE] Success: true | Chunk #${chunkId} scheduled at ${scheduledTime.toFixed(3)}s | Current Time: ${currentTime.toFixed(3)}s | Active Sources: ${this.activeSources.length + 1} | Destination: Active`);
      } catch (playErr: any) {
        console.warn(`[STAGE 8 AUDIO OUTPUT DEVICE] Failure: true | Chunk #${chunkId} source.start error: ${playErr.message || playErr}. Attempting recovery...`);
        await AudioContextManager.ensureResumed(this.audioCtx, 'AudioPlayer');
        source.start(this.audioCtx.currentTime);
        console.log(`[STAGE 8 AUDIO OUTPUT DEVICE] Recovered chunk #${chunkId}`);
      }

      this.nextStartTime = scheduledTime + audioBuffer.duration;
      this.activeSources.push(source);

      if (this.activeSources.length === 1 && this.onPlaybackStateChange) {
        this.onPlaybackStateChange(true);
      }

      source.onended = () => {
        const idx = this.activeSources.indexOf(source);
        if (idx !== -1) {
          this.activeSources.splice(idx, 1);
        }

        try {
          source.disconnect();
        } catch (e) {
          // ignore
        }

        if (this.activeSources.length === 0) {
          if (this.audioCtx) {
            this.nextStartTime = this.audioCtx.currentTime;
          }
          if (this.onPlaybackStateChange) {
            this.onPlaybackStateChange(false);
          }
        }
      };
    } catch (err) {
      console.error(`[AUDIO PLAY FAILED] Failed to decode or play chunk #${chunkId}:`, err);
    }
  }

  public stopAll(): void {
    console.log("[AudioPlayer] Stopping all active audio playback sources...");
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Source already stopped
      }
    }
    this.activeSources = [];
    if (this.audioCtx) {
      this.nextStartTime = this.audioCtx.currentTime;
    } else {
      this.nextStartTime = 0;
    }

    if (this.onPlaybackStateChange) {
      this.onPlaybackStateChange(false);
    }
    if (this.onVolumeChange) {
      this.onVolumeChange(0);
    }
  }

  private startVolumeMonitoring(): void {
    if (this.animationFrameId !== null) return;

    const buffer = new Uint8Array(128);
    const checkVolume = () => {
      if (this.analyser && this.activeSources.length > 0) {
        this.analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const avg = sum / buffer.length;
        const normVolume = Math.min(1, avg / 128);
        if (this.onVolumeChange) {
          this.onVolumeChange(normVolume);
        }
      } else {
        if (this.onVolumeChange && this.activeSources.length === 0) {
          this.onVolumeChange(0);
        }
      }
      this.animationFrameId = requestAnimationFrame(checkVolume);
    };

    checkVolume();
  }

  private base64ToAudioBuffer(base64: string, ctx: AudioContext): AudioBuffer {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const dataView = new DataView(bytes.buffer);
    const numSamples = Math.floor(len / 2);
    const float32Array = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const int16 = dataView.getInt16(i * 2, true); // Little-endian PCM
      float32Array[i] = int16 < 0 ? int16 / 32768 : int16 / 32767;
    }

    const audioBuffer = ctx.createBuffer(1, numSamples, 24000);
    audioBuffer.getChannelData(0).set(float32Array);
    return audioBuffer;
  }

  public destroy(): void {
    this.stopAll();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
}