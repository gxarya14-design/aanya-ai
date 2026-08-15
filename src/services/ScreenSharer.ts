import { AudioContextManager } from './AudioContextManager';

export class ScreenSharer {
  private mediaStream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private canvasElement: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;

  private workerTicker: Worker | null = null;
  private active: boolean = false;
  private isRequesting: boolean = false;
  private frameCount: number = 0;
  private droppedFrames: number = 0;
  private lastFrameTime: number = 0;
  private minFrameIntervalMs: number = 3000;

  private onFrame?: (base64Jpeg: string, metadata: any) => void;
  private onEnded?: () => void;
  private onError?: (errorMsg: string) => void;

  private isElectron(): boolean {
    return !!window.electronAPI && typeof window.electronAPI.getScreenSources === 'function';
  }

  private async requestDisplayStream(): Promise<MediaStream> {
    if (this.isElectron()) {
      const sources = await window.electronAPI!.getScreenSources();

      if (!sources || sources.length === 0) {
        throw new Error('No screen sources found in Electron.');
      }

      const source = sources[0];
      console.log('[ScreenSharer] Electron mode detected. Using desktopCapturer source:', source.name ?? source.id);

      const constraints: any = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            minWidth: 1280,
            minHeight: 720,
            maxWidth: 1280,
            maxHeight: 720,
          },
        },
      };

      return navigator.mediaDevices.getUserMedia(constraints);
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen capture is not supported in this browser.');
    }

    if (!window.isSecureContext) {
      throw new Error('Screen capture requires a secure context (HTTPS or localhost).');
    }

    console.log('[ScreenSharer] Browser fallback mode detected. Using getDisplayMedia().');
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'monitor',
        width: { max: 1280 },
        height: { max: 720 },
        frameRate: { max: 5 },
      },
      audio: false,
    });
  }

  public async start(
    onFrame: (base64Jpeg: string, metadata: any) => void,
    onEnded: () => void,
    onError: (errorMsg: string) => void,
    intervalMs: number = 3000
  ): Promise<boolean> {
    if (this.active) {
      console.log('[ScreenSharer] Screen capture session is already active.');
      return true;
    }

    if (this.isRequesting) {
      console.warn('[ScreenSharer] Screen share request already in progress. Ignoring duplicate trigger.');
      return false;
    }

    this.isRequesting = true;
    this.onFrame = onFrame;
    this.onEnded = onEnded;
    this.onError = onError;
    this.minFrameIntervalMs = Math.max(2000, intervalMs);
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.lastFrameTime = 0;

    if (!navigator.mediaDevices) {
      const msg = 'Screen capture is not supported on this platform.';
      console.error('[ScreenSharer]', msg);
      this.isRequesting = false;
      this.onError?.(msg);
      return false;
    }

    try {
      console.log('[ScreenSharer] Requesting screen capture stream...');
      this.mediaStream = await this.requestDisplayStream();

      const videoTrack = this.mediaStream.getVideoTracks()[0];
      if (!videoTrack) {
        throw new Error('No video track found in display stream.');
      }

      videoTrack.onended = () => {
        console.log('[ScreenSharer] Display track ended by user.');
        this.stop();
      };

      this.videoElement = document.createElement('video');
      this.videoElement.autoplay = true;
      this.videoElement.playsInline = true;
      this.videoElement.muted = true;
      this.videoElement.srcObject = this.mediaStream;

      await new Promise<void>((resolve) => {
        if (!this.videoElement) {
          resolve();
          return;
        }

        const onLoaded = () => {
          this.videoElement
            ?.play()
            .then(() => resolve())
            .catch((error) => {
              console.warn('[ScreenSharer] Video play warning:', error);
              resolve();
            });
        };

        this.videoElement.onloadedmetadata = onLoaded;
      });

      this.canvasElement = document.createElement('canvas');
      this.canvasCtx = this.canvasElement.getContext('2d', { willReadFrequently: true });

      this.active = true;
      this.isRequesting = false;

      await AudioContextManager.resumeAll();

      this.startWorkerTicker();
      setTimeout(() => this.captureFrame('initial_start'), 300);
      return true;
    } catch (error: any) {
      this.isRequesting = false;
      console.error('[ScreenSharer] Screen capture failed:', {
        name: error?.name,
        message: error?.message,
      });

      let userMsg = 'Could not start screen sharing.';
      switch (error?.name) {
        case 'NotAllowedError':
          userMsg = 'Screen sharing permission was denied or dismissed.';
          break;
        case 'AbortError':
          userMsg = 'Screen selection was cancelled.';
          break;
        case 'NotFoundError':
          userMsg = 'No screen display source found.';
          break;
        default:
          userMsg = error?.message || userMsg;
          break;
      }

      this.stop();
      if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
        this.onError?.(userMsg);
      }
      return false;
    }
  }

  private startWorkerTicker(): void {
    try {
      const workerCode = `
        let timer = null;
        self.onmessage = function(e) {
          if (e.data.action === 'start') {
            if (timer) clearInterval(timer);
            timer = setInterval(function() {
              self.postMessage('tick');
            }, e.data.interval || 3000);
          } else if (e.data.action === 'stop') {
            if (timer) clearInterval(timer);
            timer = null;
          }
        };
      `;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.workerTicker = new Worker(URL.createObjectURL(blob));

      this.workerTicker.onmessage = (event) => {
        if (event.data === 'tick' && this.active) {
          this.captureFrame('worker_tick');
        }
      };

      this.workerTicker.postMessage({ action: 'start', interval: this.minFrameIntervalMs });
    } catch (error) {
      console.warn('[ScreenSharer] Worker ticker failed, using fallback interval:', error);
      const intervalId = window.setInterval(() => {
        if (this.active) {
          this.captureFrame('interval_fallback');
        }
      }, this.minFrameIntervalMs);
      (this as any)._fallbackInterval = intervalId;
    }
  }

  public captureFrame(sourceTrigger: string = 'manual'): void {
    if (
      !this.active ||
      !this.videoElement ||
      !this.canvasElement ||
      !this.canvasCtx ||
      this.videoElement.readyState < 2
    ) {
      return;
    }

    const videoTrack = this.mediaStream?.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') {
      return;
    }

    const now = Date.now();
    if (this.lastFrameTime > 0 && now - this.lastFrameTime < this.minFrameIntervalMs - 100) {
      this.droppedFrames++;
      return;
    }

    const width = this.videoElement.videoWidth;
    const height = this.videoElement.videoHeight;

    if (!width || !height) {
      return;
    }

    const maxDimension = 800;
    let targetWidth = width;
    let targetHeight = height;

    if (width > maxDimension || height > maxDimension) {
      const scale = maxDimension / Math.max(width, height);
      targetWidth = Math.round(width * scale);
      targetHeight = Math.round(height * scale);
    }

    if (this.canvasElement.width !== targetWidth || this.canvasElement.height !== targetHeight) {
      this.canvasElement.width = targetWidth;
      this.canvasElement.height = targetHeight;
    }

    this.canvasCtx.clearRect(0, 0, targetWidth, targetHeight);
    this.canvasCtx.imageSmoothingEnabled = true;
    this.canvasCtx.imageSmoothingQuality = 'medium';
    this.canvasCtx.drawImage(this.videoElement, 0, 0, targetWidth, targetHeight);

    try {
      const dataUrl = this.canvasElement.toDataURL('image/jpeg', 0.5);
      const base64Data = dataUrl.split(',')[1];

      if (base64Data && this.onFrame) {
        this.frameCount++;
        this.lastFrameTime = now;

        const metadata = {
          frameCount: this.frameCount,
          trigger: sourceTrigger,
          capturedTimestamp: now,
          base64Bytes: base64Data.length,
        };

        this.onFrame(base64Data, metadata);
      }
    } catch (error) {
      console.error('[ScreenSharer] Frame encoding error:', error);
    }
  }

  public stop(): void {
    console.log('[ScreenSharer] Stopping screen capture...');
    this.active = false;
    this.isRequesting = false;

    if (this.workerTicker) {
      this.workerTicker.postMessage({ action: 'stop' });
      this.workerTicker.terminate();
      this.workerTicker = null;
    }

    if ((this as any)._fallbackInterval) {
      clearInterval((this as any)._fallbackInterval);
      (this as any)._fallbackInterval = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        try {
          track.onended = null;
          track.stop();
        } catch (error) {
          // ignore
        }
      });
      this.mediaStream = null;
    }

    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }

    this.canvasElement = null;
    this.canvasCtx = null;

    AudioContextManager.resumeAll();

    if (this.onEnded) {
      this.onEnded();
    }
  }

  public isSharing(): boolean {
    return this.active;
  }

  public isPending(): boolean {
    return this.isRequesting;
  }
}
