declare global {
  interface Window {
    electronAPI?: {
      getScreenSources: () => Promise<Array<{
        id: string;
        name: string;
        appIcon?: string | null;
        display_id?: string | null;
      }>>;
      openExternalUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
      // FIX (clicks/scroll landing in the wrong place): real primary
      // display resolution from the OS, independent of whatever
      // resolution the screen-share capture stream is downscaled to.
      // Returns null if Electron's screen module couldn't be reached.
      getRealScreenSize: () => Promise<{ width: number; height: number } | null>;
    };
  }
}

export {};