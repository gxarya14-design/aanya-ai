import { AudioContextManager } from './AudioContextManager';

/**
 * AudioRecorder handles mic input streaming.
 * Captures user speech, downsamples to 16kHz PCM16 Little-Endian,
 * and passes base64 audio chunks to the callback.
 */

export class AudioRecorder {
  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private silenceGainNode: GainNode | null = null;
  private isRecording: boolean = false;
  private recoveryInterval: any = null;
  private micPacketCount: number = 0;

  private onAudioChunk?: (base64Audio: string) => void;
  private onVolumeChange?: (volume: number) => void;

  constructor(
    onAudioChunk?: (base64Audio: string) => void,
    onVolumeChange?: (volume: number) => void
  ) {
    this.onAudioChunk = onAudioChunk;
    this.onVolumeChange = onVolumeChange;
  }

  public getAudioContextState(): string {
    return this.audioCtx ? this.audioCtx.state : 'uninitialized';
  }

  public async start(): Promise<void> {
    if (this.isRecording) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      this.audioCtx = AudioContextManager.getSharedAudioContext();
      AudioContextManager.register('AudioRecorder', this.audioCtx);

      await AudioContextManager.ensureResumed(this.audioCtx, 'AudioRecorder');

      this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.processorNode = this.audioCtx.createScriptProcessor(4096, 1, 1);

      this.processorNode.onaudioprocess = (event: AudioProcessingEvent): void => {
        if (!this.isRecording) return;

        const ctxState = this.audioCtx ? this.audioCtx.state : 'null';

        if (this.audioCtx && (this.audioCtx.state as string) !== 'running') {
          console.warn(`[STAGE 2 AUDIO CONTEXT] AudioRecorder detected state '${ctxState}'. Auto-resuming...`);
          AudioContextManager.ensureResumed(this.audioCtx, 'AudioRecorder');
        }

        const inputBuffer = event.inputBuffer.getChannelData(0);
        const nativeSampleRate = event.inputBuffer.sampleRate;

        let sum = 0;
        for (let i = 0; i < inputBuffer.length; i++) {
          sum += inputBuffer[i] * inputBuffer[i];
        }
        const rms = Math.sqrt(sum / inputBuffer.length);
        const volume = Math.min(1, rms * 5);
        if (this.onVolumeChange) {
          this.onVolumeChange(volume);
        }

        // STAGE 3: PCM ENCODING
        const downsampled = this.downsample(inputBuffer, nativeSampleRate, 16000);
        const pcm16 = this.floatToPCM16(downsampled);
        const base64 = this.arrayBufferToBase64(pcm16);

        this.micPacketCount++;

        if (this.micPacketCount % 30 === 1) {
          console.log(`[STAGE 1 MIC CAPTURE & STAGE 3 PCM ENCODING] Success: true | Packet #${this.micPacketCount} | Float samples: ${inputBuffer.length} | PCM16 bytes: ${pcm16.byteLength} | Base64 chars: ${base64.length} | AudioContext State: ${ctxState}`);
        }

        if (this.onAudioChunk && base64) {
          this.onAudioChunk(base64);
        }
      };

      this.sourceNode.connect(this.processorNode);

      // Connect via Zero Gain node to destination to trigger Web Audio API processing without speaker echo/feedback
      this.silenceGainNode = this.audioCtx.createGain();
      this.silenceGainNode.gain.value = 0;
      this.processorNode.connect(this.silenceGainNode);
      this.silenceGainNode.connect(this.audioCtx.destination);

      this.isRecording = true;

      // Active periodic check to recover from suspended AudioContext
      if (this.recoveryInterval) clearInterval(this.recoveryInterval);
      this.recoveryInterval = setInterval(() => {
        if (this.isRecording && this.audioCtx && (this.audioCtx.state as string) !== 'running') {
          console.warn(`[STAGE 2 AUDIO CONTEXT CHECK] AudioRecorder context is '${this.audioCtx.state}'. Periodic check triggering resume...`);
          AudioContextManager.ensureResumed(this.audioCtx, 'AudioRecorder');
        }
      }, 1000);

      console.log(`[STAGE 1 MIC CAPTURE] Success: true | Microphone streaming active | AudioContext State: ${this.audioCtx.state}`);
    } catch (err: any) {
      console.error(`[STAGE 1 MIC CAPTURE] Failure: true | Error: ${err.message || err} | AudioContext State: ${this.getAudioContextState()}`);
      throw err;
    }
  }

  public stop(): void {
    this.isRecording = false;

    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = null;
    }

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try {
        this.processorNode.disconnect();
      } catch (e) {
        // ignore
      }
      this.processorNode = null;
    }

    if (this.silenceGainNode) {
      try {
        this.silenceGainNode.disconnect();
      } catch (e) {
        // ignore
      }
      this.silenceGainNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (e) {
        // ignore
      }
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.onVolumeChange) {
      this.onVolumeChange(0);
    }
  }

  private downsample(buffer: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
    if (inputSampleRate === outputSampleRate) {
      return buffer;
    }
    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }

  private floatToPCM16(input: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); // Little endian
    }
    return buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

