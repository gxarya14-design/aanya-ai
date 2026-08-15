import { SessionState, ZoyaVoice, ToolCallEvent } from '../types';
import { AudioPlayer } from './AudioPlayer';
import { AudioRecorder } from './AudioRecorder';
import { ScreenSharer } from './ScreenSharer';

export interface LiveSessionCallbacks {
  onStateChange: (state: SessionState) => void;
  onVolumeChange: (volume: number, isInput: boolean) => void;
  onTextReceived: (text: string, isUser: boolean) => void;
  onToolCall: (event: ToolCallEvent) => void;
  onError: (error: string) => void;
  onScreenShareChange?: (isSharing: boolean) => void;
}

export class LiveSession {
  private ws: WebSocket | null = null;
  private state: SessionState = 'disconnected';
  private player: AudioPlayer | null = null;
  private recorder: AudioRecorder | null = null;
  private screenSharer: ScreenSharer | null = null;
  private callbacks: LiveSessionCallbacks;
  private voice: ZoyaVoice = 'Kore';
  private isMuted: boolean = false;
  private isModelResponding: boolean = false;
  private micPacketCount: number = 0;
  private geminiAudioPacketCount: number = 0;
  private speechRecognizer: any = null;

  constructor(callbacks: LiveSessionCallbacks, voice: ZoyaVoice = 'Kore') {
    this.callbacks = callbacks;
    this.voice = voice;
    this.initSpeechRecognition();

    this.player = new AudioPlayer(
      (isPlaying) => {
        if (isPlaying) {
          console.log(`[STAGE 7 AUDIO PLAYER PLAYBACK] Audio output playback started | AudioContext state: ${this.player?.getAudioContextState()}`);
          this.setState('speaking');
        } else if (this.state === 'speaking') {
          console.log(`[STAGE 7 AUDIO PLAYER PLAYBACK] Audio output playback finished | AudioContext state: ${this.player?.getAudioContextState()}`);
          this.setState('idle');
          // Reset isModelResponding when playback finishes so vision frames can resume
          setTimeout(() => {
            if (this.player && !this.player.isPlaying()) {
              this.isModelResponding = false;
            }
          }, 800);
        }
      },
      (volume) => {
        this.callbacks.onVolumeChange(volume, false);
      }
    );

    this.recorder = new AudioRecorder(
      (base64Pcm) => {
        if (!this.isMuted && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.micPacketCount++;
          const before = this.ws.bufferedAmount;
          this.ws.send(JSON.stringify({ type: 'audio', audio: base64Pcm }));
          const after = this.ws.bufferedAmount;
          if (this.micPacketCount % 25 === 1 || before > 2048) {
            console.log(`[STAGE 4 WS AUDIO SEND] Success: true | Packet #${this.micPacketCount} | Bytes Sent: ${base64Pcm.length} | WS State: ${this.ws.readyState} | Buffer Before/After: ${before}/${after}b | ScreenSharing: ${this.isScreenSharing()}`);
          }
        }
      },
      (volume) => {
        if (!this.isMuted && this.player && !this.player.isPlaying()) {
          this.callbacks.onVolumeChange(volume, true);
          if (volume > 0.1 && this.state === 'idle') {
            this.setState('listening');
          } else if (volume <= 0.05 && this.state === 'listening') {
            this.setState('idle');
          }
        }
      }
    );

    this.screenSharer = new ScreenSharer();
  }

  private initSpeechRecognition(): void {
    if (typeof window === 'undefined') return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      try {
        this.speechRecognizer = new SpeechRecognition();
        this.speechRecognizer.continuous = true;
        this.speechRecognizer.interimResults = false;

        this.speechRecognizer.onresult = (event: any) => {
          const lastIndex = event.results.length - 1;
          const transcript = event.results[lastIndex]?.[0]?.transcript;
          if (transcript && transcript.trim()) {
            console.log(`[USER TEXT RECEIVED] Speech Recognition Transcript: "${transcript.trim()}"`);
            this.callbacks.onTextReceived(transcript.trim(), true);
          }
        };

        this.speechRecognizer.onerror = (err: any) => {
          console.log('[LiveSession] Speech recognition notice (non-fatal):', err.error);
        };

        this.speechRecognizer.onend = () => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.isMuted) {
            try {
              this.speechRecognizer?.start();
            } catch (_) {}
          }
        };
      } catch (e) {
        console.warn('SpeechRecognition initialization notice:', e);
      }
    }
  }

  public getState(): SessionState {
    return this.state;
  }

  private setState(newState: SessionState): void {
    if (this.state !== newState) {
      console.log(`[LiveSession Debug] State transition: ${this.state} -> ${newState}`);
      this.state = newState;
      this.callbacks.onStateChange(newState);
    }
  }

  public sendImageFrame(base64Jpeg: string, metadata?: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Audio Output Priority: Delay screen frames if Gemini is generating audio or player is active
    if (this.isModelResponding || (this.player && this.player.isPlaying())) {
      console.log(`[SCREEN FRAME] Audio pipeline active. Delaying screen frame #${metadata?.frameCount || '?'}`);
      return;
    }

    // Backpressure protection: Drop frame if WebSocket buffer has unsent data (>4KB)
    if (this.ws.bufferedAmount > 4096) {
      console.warn(`[WEBSOCKET BUFFER] High buffer (${this.ws.bufferedAmount} bytes). Dropping screen frame #${metadata?.frameCount || '?'}`);
      return;
    }

    const sentTimestamp = Date.now();
    this.ws.send(JSON.stringify({
      type: 'image',
      image: base64Jpeg,
      mimeType: 'image/jpeg',
      sentTimestamp,
      metadata
    }));

    const sizeKb = Math.round((base64Jpeg.length * 0.75) / 1024);
    console.log(`[SCREEN FRAME] Sent frame #${metadata?.frameCount || '?'} | Size: ~${sizeKb} KB`);
  }

  public async toggleScreenShare(): Promise<boolean> {
    if (!this.screenSharer) {
      this.screenSharer = new ScreenSharer();
    }

    if (this.screenSharer.isSharing()) {
      this.screenSharer.stop();
      if (this.callbacks.onScreenShareChange) {
        this.callbacks.onScreenShareChange(false);
      }
      return false;
    }

    const result = await this.screenSharer.start(
      (base64Jpeg, metadata) => {
        this.sendImageFrame(base64Jpeg, metadata);
      },
      () => {
        if (this.callbacks.onScreenShareChange) {
          this.callbacks.onScreenShareChange(false);
        }
      },
      (errorMsg) => {
        this.callbacks.onError(errorMsg);
      },
      3000
    );

    if (this.callbacks.onScreenShareChange) {
      this.callbacks.onScreenShareChange(result);
    }

    return result;
  }

  public isScreenSharing(): boolean {
    return this.screenSharer?.isSharing() ?? false;
  }

  public async connect(): Promise<void> {
    if (this.ws) {
      this.disconnect();
    }

    console.log("[LiveSession Debug] Initiating connection to Live session backend...");
    this.setState('connecting');
    this.player?.unlockContext();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/live?voice=${encodeURIComponent(this.voice)}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = async () => {
        console.log("[LiveSession Debug] Client WebSocket connected to server");
        this.setState('idle');

        // Start microphone recording
        try {
          await this.recorder?.start();
          try { this.speechRecognizer?.start(); } catch (_) {}
          console.log("[LiveSession Debug] AudioRecorder & SpeechRecognizer started mic capture");
        } catch (e: any) {
          this.callbacks.onError("Microphone permission denied or unavailable.");
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'status') {
            console.log("[LiveSession Debug] Status update from server:", msg.status);
            if (msg.status === 'connected') {
              this.setState('idle');
            }
          } else if (msg.type === 'audio' && msg.audio) {
            this.geminiAudioPacketCount++;
            console.log(`[STAGE 6 WS AUDIO RECEPTION] Success: true | Gemini Packet #${this.geminiAudioPacketCount} | Bytes Received: ${msg.audio.length} base64 chars | WS State: ${this.ws?.readyState} | Player AudioCtx State: ${this.player?.getAudioContextState()}`);
            this.isModelResponding = true;
            this.player?.playChunk(msg.audio);
          } else if (msg.type === 'text' && msg.text) {
            console.log(`[AI TEXT RECEIVED] Gemini text: "${msg.text}"`);
            console.log(`[Client] Received text: "${msg.text}"`);
            console.log(`[LiveSession] onTextReceived("${msg.text}", false)`);
            this.isModelResponding = true;
            this.callbacks.onTextReceived(msg.text, false);
          } else if (msg.type === 'interrupted') {
            console.log("[GEMINI TURN STATE] Interrupted event received from server.");
            this.isModelResponding = false;
            this.player?.stopAll();
            this.setState('idle');
          } else if (msg.type === 'turnComplete') {
            console.log("[GEMINI TURN STATE] turnComplete received from server.");
            this.isModelResponding = false;
          } else if (msg.type === 'toolCall') {
            this.handleToolCall(msg.id, msg.name, msg.args);
          } else if (msg.type === 'toolNotify') {
            // Server already executed this itself (createFile/searchWeb/
            // openWebsite) and already responded to Gemini directly — this
            // message is purely so the UI can show what happened.
            const event: ToolCallEvent = {
              id: msg.id,
              name: msg.name,
              args: msg.args || {},
              timestamp: Date.now(),
              status: 'completed',
              resultMessage: msg.resultMessage
            };
            this.callbacks.onToolCall(event);
          } else if (msg.type === 'error') {
            console.error("[LiveSession Debug] Live session error received:", msg.error);
            this.callbacks.onError(msg.error || "Live session error");
            this.setState('error');
          }
        } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
        }
      };

      this.ws.onerror = (evt) => {
        console.error("[LiveSession Debug] Client WebSocket error:", evt);
        this.callbacks.onError("Connection failed to Zoya Live Assistant.");
        this.setState('error');
      };

      this.ws.onclose = () => {
        console.log("[LiveSession Debug] Client WebSocket closed");
        try { this.speechRecognizer?.stop(); } catch (_) {}
        this.recorder?.stop();
        this.player?.stopAll();
        this.screenSharer?.stop();
        this.setState('disconnected');
      };

    } catch (err: any) {
      console.error("[LiveSession Debug] Exception during WebSocket connection setup:", err);
      this.callbacks.onError(err.message || "Could not connect to voice server.");
      this.setState('error');
    }
  }

  public sendTextMessage(text: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log(`[USER TEXT RECEIVED] Outgoing user typed text: "${text}"`);
      this.player?.stopAll();
      this.isModelResponding = true;
      this.callbacks.onTextReceived(text, true);
      this.setState('thinking');
      this.ws.send(JSON.stringify({ type: 'text', text }));
    }
  }

  private handleUserInterrupt(): void {
    console.log("[LiveSession Debug] User interrupt triggered. Halting model output & AudioPlayer.");
    this.isModelResponding = false;
    this.player?.stopAll();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'interrupt' }));
    }
  }

  private handleToolCall(id: string, name: string, args: Record<string, any>): void {
    const event: ToolCallEvent = {
      id,
      name,
      args,
      timestamp: Date.now(),
      status: 'executing'
    };

    this.callbacks.onToolCall(event);

    let resultMsg = `Tool ${name} executed successfully.`;
    if (name === 'changeThemeColor') {
      resultMsg = `Theme changed to ${args.theme}.`;
    }

    setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'toolResponse',
          id,
          name,
          result: { status: 'success', message: resultMsg }
        }));
      }
    }, 400);
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
  }

  public setVoice(voice: ZoyaVoice): void {
    this.voice = voice;
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.screenSharer?.stop();
    this.recorder?.stop();
    this.player?.stopAll();
    this.setState('disconnected');
  }

  public destroy(): void {
    this.disconnect();
    this.player?.destroy();
  }
}
