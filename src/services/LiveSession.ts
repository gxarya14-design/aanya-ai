import { SessionState, ZoyaVoice, ToolCallEvent, ConfirmRequiredEvent, ChatAttachment, WorkspaceFile, WorkspaceFileReadResult } from '../types';
import { AudioPlayer } from './AudioPlayer';
import { AudioRecorder } from './AudioRecorder';
import { ScreenSharer } from './ScreenSharer';

export interface LiveSessionCallbacks {
  onStateChange: (state: SessionState) => void;
  onVolumeChange: (volume: number, isInput: boolean) => void;
  onTextReceived: (text: string, isUser: boolean) => void;
  onToolCall: (event: ToolCallEvent) => void;
  // FIX (confirm-before-act popup): fires when the server parks a gated tool
  // call and needs an on-screen Allow/Deny answer before it will run.
  onConfirmRequired: (event: ConfirmRequiredEvent) => void;
  onError: (error: string) => void;
  onScreenShareChange?: (isSharing: boolean) => void;
  onAttachmentStatus?: (attachment: ChatAttachment) => void;
  onFileCreated?: (file: WorkspaceFile) => void;
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
  private workspaceFileRequests = new Map<string, {
    resolve: (result: WorkspaceFileReadResult) => void;
    reject: (error: Error) => void;
  }>();

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
      // FIX (severe reply latency + wrong clicks, caused by stacking this
      // 1000ms rate on top of MEDIA_RESOLUTION_HIGH + larger 1280px frames
      // in the same round -- see the matching comment in ScreenSharer.ts's
      // minFrameIntervalMs for the full explanation): reverted back to
      // 2000ms. MEDIA_RESOLUTION_HIGH alone already gives Gemini enough
      // detail per frame for precise clicking -- sending frames twice as
      // often on top of that was too much combined token volume and made
      // responses noticeably slower, several seconds behind.
      2000
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
            const isUser = msg.isUser ?? false;
            console.log(`[AI TEXT RECEIVED] Gemini text: "${msg.text}"`);
            console.log(`[Client] Received text: "${msg.text}" | isUser: ${isUser}`);
            console.log(`[LiveSession] onTextReceived("${msg.text}", ${isUser})`);
            if (!isUser) {
              this.isModelResponding = true;
            }
            this.callbacks.onTextReceived(msg.text, isUser);
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
          } else if (msg.type === 'confirmRequired') {
            // Server is parking a gated tool call (openWebsite,
            // openApplication, ...) until the user answers on screen. Just
            // surface it — respondToConfirmation() below sends the answer
            // back. If this is a re-prompt for a multi-approval tool,
            // approvalsSoFar will be higher than last time.
            console.log(`[TOOL CONFIRM] Server needs approval: ${msg.name} (${msg.approvalsSoFar}/${msg.approvalsNeeded})`);
            this.callbacks.onConfirmRequired({
              id: msg.id,
              name: msg.name,
              args: msg.args || {},
              summary: msg.summary || `Run ${msg.name}`,
              approvalsNeeded: msg.approvalsNeeded,
              approvalsSoFar: msg.approvalsSoFar
            });
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
          } else if (msg.type === 'attachmentStatus' && msg.attachment) {
            this.callbacks.onAttachmentStatus?.(msg.attachment);
          } else if (msg.type === 'fileCreated' && msg.path && msg.name) {
            this.callbacks.onFileCreated?.({
              name: msg.name,
              path: msg.path,
              kind: msg.kind === 'folder' ? 'folder' : 'file',
              size: typeof msg.size === 'number' ? msg.size : undefined,
            });
          } else if (msg.type === 'workspaceFileResult' && msg.requestId) {
            const request = this.workspaceFileRequests.get(msg.requestId);
            if (request) {
              this.workspaceFileRequests.delete(msg.requestId);
              if (msg.error) request.reject(new Error(msg.error));
              else request.resolve(msg.file as WorkspaceFileReadResult);
            }
          } else if (msg.type === 'openUrlInElectron' && msg.url) {
            // FIX (Chrome never visibly opens, even though the terminal log
            // shows the correct URL): server.ts's openInSystemBrowser() has
            // ALWAYS sent this message so the Electron renderer can call
            // shell.openExternal via IPC (see main.js: 'open-external-url',
            // wired up correctly in preload.cjs) — but this onmessage
            // handler had NO case for 'openUrlInElectron' at all, so the
            // message was silently dropped the instant it arrived here.
            // Nothing downstream of this point ever ran. The server-side
            // URL generation and its terminal log were always correct;
            // this was the entire gap.
            console.log(`[OPEN URL] Received openUrlInElectron for: ${msg.url}`);
            if (window.electronAPI?.openExternalUrl) {
              window.electronAPI.openExternalUrl(msg.url).then((result) => {
                if (!result?.ok) {
                  console.error(`[OPEN URL] shell.openExternal failed:`, result?.error);
                  this.callbacks.onError(result?.error || 'Could not open the browser.');
                } else {
                  console.log(`[OPEN URL] Successfully opened via Electron: ${msg.url}`);
                }
              }).catch((err) => {
                console.error(`[OPEN URL] IPC call threw:`, err);
                this.callbacks.onError('Could not open the browser.');
              });
            } else {
              // Not running inside Electron (plain browser tab has no
              // window.electronAPI at all) — fall back to a normal
              // browser-native new-tab open instead of silently doing
              // nothing.
              console.log('[OPEN URL] No electronAPI bridge — falling back to window.open()');
              window.open(msg.url, '_blank', 'noopener,noreferrer');
            }
          } else if (msg.type === 'openFileInElectron' && msg.path) {
            // FEATURE (open existing files on the PC by voice): mirrors
            // openUrlInElectron exactly, but calls openFilePath (shell.
            // openPath under the hood) instead of openExternalUrl. No
            // browser-fallback equivalent exists for this one — a plain
            // browser tab has no filesystem access at all, so this is
            // Electron-only by nature, not just by the current bridge.
            console.log(`[OPEN FILE] Received openFileInElectron for: ${msg.path}`);
            if (window.electronAPI?.openFilePath) {
              window.electronAPI.openFilePath(msg.path).then((result) => {
                if (!result?.ok) {
                  console.error(`[OPEN FILE] shell.openPath failed:`, result?.error);
                  this.callbacks.onError(result?.error || 'Could not open that file.');
                } else {
                  console.log(`[OPEN FILE] Successfully opened via Electron: ${msg.path}`);
                }
              }).catch((err) => {
                console.error(`[OPEN FILE] IPC call threw:`, err);
                this.callbacks.onError('Could not open that file.');
              });
            } else {
              console.warn('[OPEN FILE] No electronAPI bridge — opening files requires the desktop app.');
              this.callbacks.onError('Opening files only works in the Aanya desktop app, not in a browser tab.');
            }
          } else if (msg.type === 'screenShareControl') {
            // FEATURE (voice-triggered PC access): server.ts's
            // handleStartPcAccess/handleStopPcAccess send this when Gemini
            // decides the user asked for/gave back PC access. Reuses the
            // exact same toggleScreenShare() the manual Share-Screen button
            // already calls (see VoiceControls.tsx) -- this just triggers
            // it from a voice command instead of a click, so the same
            // onScreenShareChange callback keeps the UI icon in sync either
            // way. Guarded against the CURRENT state (not blind-toggled):
            // toggleScreenShare() flips whatever state it's already in, so
            // if the user says "PC access lo" while sharing is somehow
            // already on, blindly toggling would incorrectly turn it OFF.
            const wantsSharing = msg.action === 'start';
            console.log(`[PC ACCESS] Server requested: ${msg.action}. Currently sharing: ${this.isScreenSharing()}`);
            if (wantsSharing !== this.isScreenSharing()) {
              this.toggleScreenShare();
            }
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
        this.callbacks.onError("Connection failed to Aanya Live Assistant.");
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

  public sendTextMessage(text: string, attachmentIds: string[] = []): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log(`[USER TEXT RECEIVED] Outgoing user typed text: "${text}"`);
      this.player?.stopAll();
      this.isModelResponding = true;
      this.callbacks.onTextReceived(text, true);
      this.setState('thinking');
      this.ws.send(JSON.stringify({ type: 'text', text, attachmentIds }));
    }
  }

  public uploadAttachment(attachment: ChatAttachment, data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'attachment', attachment, data }));
    }
  }

  public readWorkspaceFile(file: WorkspaceFile, mode: 'view' | 'download'): Promise<WorkspaceFileReadResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Aanya is not connected.'));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.workspaceFileRequests.set(requestId, { resolve, reject });
      this.ws?.send(JSON.stringify({ type: 'workspaceFileRequest', requestId, path: file.path, mode }));
      window.setTimeout(() => {
        const pending = this.workspaceFileRequests.get(requestId);
        if (pending) {
          this.workspaceFileRequests.delete(requestId);
          pending.reject(new Error('The file request timed out.'));
        }
      }, 15000);
    });
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

  // FIX (confirm-before-act popup): call this when the user taps Allow/Deny
  // on a confirmRequired card. If approved but more approvals are still
  // needed, the server will send another confirmRequired (handled above)
  // instead of running the tool — it does NOT run after just one call here
  // unless approvalsNeeded was 1.
  public respondToConfirmation(id: string, approved: boolean): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log(`[TOOL CONFIRM] Sending user answer for ${id}: ${approved ? 'approved' : 'denied'}`);
      this.ws.send(JSON.stringify({ type: 'toolConfirmation', id, approved }));
    }
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
    for (const pending of this.workspaceFileRequests.values()) {
      pending.reject(new Error('Aanya disconnected before the file could be read.'));
    }
    this.workspaceFileRequests.clear();
  }

  public destroy(): void {
    this.disconnect();
    this.player?.destroy();
  }
}
