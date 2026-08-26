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
});