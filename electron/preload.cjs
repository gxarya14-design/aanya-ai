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
});