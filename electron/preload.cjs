const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getScreenSources: async () => {
    try {
      return await ipcRenderer.invoke('get-screen-sources');
    } catch (error) {
      console.error('[Preload] Error fetching screen sources:', error);
      return [];
    }
  },
  openExternalUrl: async (url) => {
    try {
      return await ipcRenderer.invoke('open-external-url', url);
    } catch (error) {
      console.error('[Preload] Error opening external URL:', error);
      return { ok: false, error: String(error?.message || error) };
    }
  },
  getRealScreenSize: async () => {
    try {
      return await ipcRenderer.invoke('get-real-screen-size');
    } catch (error) {
      console.error('[Preload] Error fetching real screen size:', error);
      return null;
    }
  },
  // FEATURE (open existing files on the PC, e.g. by voice): mirrors
  // openExternalUrl exactly, but for local files instead of URLs. Opens
  // with the OS's default app for that file type -- the same thing that
  // happens when the user double-clicks it themselves.
  openFilePath: async (filePath) => {
    try {
      return await ipcRenderer.invoke('open-file-path', filePath);
    } catch (error) {
      console.error('[Preload] Error opening file path:', error);
      return { ok: false, error: String(error?.message || error) };
    }
  },
  selectChatAttachment: async () => {
    try {
      return await ipcRenderer.invoke('select-chat-attachment');
    } catch (error) {
      console.error('[Preload] Error selecting chat attachment:', error);
      return null;
    }
  },
});
