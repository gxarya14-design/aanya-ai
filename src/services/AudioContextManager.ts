/**
 * AudioContextManager manages the shared lifecycle and auto-recovery of Web Audio API contexts.
 * Prevents browser AudioContext suspension when switching tabs, windows, or initiating getDisplayMedia screen capture.
 */

class AudioContextManagerImpl {
  private sharedCtx: AudioContext | null = null;
  private contexts: Map<string, AudioContext> = new Map();
  private isListeningToEvents: boolean = false;

  constructor() {
    this.setupGlobalListeners();
  }

  public getSharedAudioContext(): AudioContext {
    if (!this.sharedCtx || this.sharedCtx.state === 'closed') {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      this.sharedCtx = new AudioCtxClass({ latencyHint: 'interactive' });
      this.register('shared', this.sharedCtx);
      console.log(`[AUDIO CONTEXT] Shared AudioContext initialized | SampleRate: ${this.sharedCtx.sampleRate}Hz | State: ${this.sharedCtx.state}`);
    }
    return this.sharedCtx;
  }

  public register(name: string, ctx: AudioContext): void {
    this.contexts.set(name, ctx);
    console.log(`[STAGE 2 AUDIO CONTEXT] Registered AudioContext '${name}' | State: ${ctx.state} | SampleRate: ${ctx.sampleRate}Hz`);

    ctx.onstatechange = () => {
      console.log(`[STAGE 2 AUDIO CONTEXT STATE CHANGE] Name: '${name}' | Previous/New State: ${ctx.state} | Success: ${ctx.state === 'running'}`);
      if ((ctx.state as string) !== 'running' && ctx.state !== 'closed') {
        this.ensureResumed(ctx, name);
      }
    };

    this.setupGlobalListeners();
  }

  public unregister(name: string): void {
    this.contexts.delete(name);
  }

  public async ensureResumed(ctx: AudioContext | null, name: string = 'unknown'): Promise<boolean> {
    if (!ctx || ctx.state === 'closed') {
      return false;
    }

    if ((ctx.state as string) === 'running') {
      return true;
    }

    console.log(`[AUDIO RESUME] Attempting to resume suspended AudioContext '${name}' (current state: ${ctx.state})...`);
    try {
      await ctx.resume();
      if ((ctx.state as string) === 'running') {
        console.log(`[AUDIO RESUME] AudioContext '${name}' successfully RESUMED and RUNNING!`);
        console.log(`[AUDIO OUTPUT READY] Audio context '${name}' is operational.`);
        return true;
      } else {
        console.warn(`[AUDIO RESUME WARNING] AudioContext '${name}' resume completed, but state is '${ctx.state}'`);
        return false;
      }
    } catch (err) {
      console.error(`[AUDIO RESUME FAILED] Could not resume AudioContext '${name}':`, err);
      return false;
    }
  }

  public async resumeAll(): Promise<void> {
    console.log("[AUDIO RESUME] Triggering resume on ALL registered AudioContext instances...");
    if (this.sharedCtx) {
      await this.ensureResumed(this.sharedCtx, 'shared');
    }
    for (const [name, ctx] of this.contexts.entries()) {
      await this.ensureResumed(ctx, name);
    }
  }

  private setupGlobalListeners(): void {
    if (this.isListeningToEvents || typeof window === 'undefined') return;
    this.isListeningToEvents = true;

    const handleFocusOrVisible = () => {
      console.log("[AUDIO CONTEXT STATE] Window focus / visibilitychange / tab switch detected. Verifying AudioContext states...");
      this.resumeAll();
    };

    window.addEventListener('focus', handleFocusOrVisible);
    window.addEventListener('pageshow', handleFocusOrVisible);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        handleFocusOrVisible();
      }
    });

    window.addEventListener('click', () => this.resumeAll(), { passive: true });
    window.addEventListener('touchstart', () => this.resumeAll(), { passive: true });
  }
}

export const AudioContextManager = new AudioContextManagerImpl();

