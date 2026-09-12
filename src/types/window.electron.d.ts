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
      // FEATURE (open existing files on the PC by voice): mirrors
      // openExternalUrl, but for local files via shell.openPath.
      openFilePath: (path: string) => Promise<{ ok: boolean; error?: string }>;
      selectChatAttachment: () => Promise<{ name: string; size: number; mimeType: string; data?: string; filePath?: string; isLargeVideo?: boolean; error?: string } | null>;
      // FEATURE (large video uploads, 500MB-1GB+): streams the file to the
      // server's chunked-upload endpoints straight from disk in the main
      // process; the returned id doubles as an attachmentId for
      // sendTextMessage, exactly like a small attachment's id.
      uploadLargeVideo: (filePath: string, name: string, mimeType: string, size: number) => Promise<{ id: string; name: string; mimeType: string; size: number; error?: string }>;
      onVideoUploadProgress: (callback: (payload: { id: string; progress: number }) => void) => () => void;
    };
  }
}

export {};