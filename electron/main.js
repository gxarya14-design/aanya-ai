import { app, BrowserWindow, desktopCapturer, ipcMain, shell, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // FIX (window-identification bug): index.html previously had
    // <title>My Google AI Studio App</title> (a scaffolding leftover), so
    // Zoya's own window never actually had "zoya" in its title despite
    // every focusTargetWindow() exclusion check in server.ts assuming it
    // would. This `title` option is only what shows before the page loads
    // — once index.html's <title> tag is read, Electron's
    // 'page-title-updated' event fires and the PAGE's title wins on the
    // native window, not this one. The real, lasting fix is index.html's
    // own <title> tag now also saying "Zoya" (see index.html) — that's
    // what nut-js's getWindows()/getActiveWindow() actually reports.
    // Keeping this option too just avoids a flash of "Zoya" -> "Electron"
    // -> "Zoya" while the page is still loading.
    title: 'Zoya',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  if (!app.isPackaged) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

ipcMain.handle('get-screen-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
      thumbnailSize: {
        width: 1280,
        height: 720,
      },
    });

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      appIcon: source.appIcon ?? null,
      display_id: source.display_id ?? null,
    }));
  } catch (error) {
    console.error('[ElectronMain] getScreenSources failed:', error);
    return [];
  }
});

// FIX (clicks/scroll landing in the wrong place — see the import comment
// above for the full root cause): gives the renderer the REAL primary
// display resolution, straight from the OS via Electron's screen module.
// This is independent of whatever resolution the desktopCapturer stream
// itself is downscaled to, so ScreenSharer.ts can send the server the
// correct real size to scale clickAt coordinates against — no more hardcoded
// or stream-derived guesses.
ipcMain.handle('get-real-screen-size', () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    // .size is the display's actual resolution in pixels (not the
    // DPI-scaled .workAreaSize), which is what real screen coordinates for
    // mouse.setPosition need to match.
    return { width: primaryDisplay.size.width, height: primaryDisplay.size.height };
  } catch (error) {
    console.error('[ElectronMain] getRealScreenSize failed:', error);
    return null;
  }
});

// FIX (browser window not visibly appearing): server.ts used to shell out
// to "start <url>" from its own separate Node process, which could open a
// browser window somewhere the user never saw (a different desktop/session
// context, or minimized behind the Electron window) or silently fail.
// shell.openExternal runs inside Electron's own main process and is the
// OS-native, guaranteed-visible way to open a URL — so the renderer (App.tsx)
// now asks for this via IPC instead, after server.ts tells it (over the
// existing WebSocket) which URL to open.
//
// Revalidated here (not just trusting the caller) since any renderer script
// could otherwise invoke this to launch arbitrary protocol handlers.
ipcMain.handle('open-external-url', async (_event, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(`[ElectronMain] Refused to open non-http(s) URL: ${url}`);
      return { ok: false, error: 'Only http/https URLs are allowed.' };
    }

    await shell.openExternal(url);
    console.log(`[ElectronMain] Opened external URL: ${url}`);
    return { ok: true };
  } catch (error) {
    console.error('[ElectronMain] openExternalUrl failed:', error);
    return { ok: false, error: String(error?.message || error) };
  }
});

// FEATURE (open existing files on the PC, e.g. by voice — "open my
// resume", "open that photo"): mirrors open-external-url above exactly,
// but for local files. shell.openPath opens a file with the OS's default
// associated app — literally the same effect as the user double-clicking
// it themselves in File Explorer. Validates the path actually exists and
// is a file (not a folder) before attempting, same spirit as the protocol
// check on open-external-url — fail with a clear reason instead of a
// silent no-op or a confusing OS-level error surfacing later.
ipcMain.handle('open-file-path', async (_event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { ok: false, error: 'No file path was given.' };
    }

    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) {
      console.warn(`[ElectronMain] Refused to open — path does not exist: ${filePath}`);
      return { ok: false, error: 'That file does not exist.' };
    }
    if (!stats.isFile()) {
      console.warn(`[ElectronMain] Refused to open — path is not a file: ${filePath}`);
      return { ok: false, error: 'That path is a folder, not a file.' };
    }

    // shell.openPath resolves to an error STRING on failure (e.g. "no
    // associated application"), and an empty string on success -- unlike
    // shell.openExternal, it does not throw for this kind of failure.
    const result = await shell.openPath(filePath);
    if (result) {
      console.error(`[ElectronMain] openPath failed for ${filePath}:`, result);
      return { ok: false, error: result };
    }

    console.log(`[ElectronMain] Opened file: ${filePath}`);
    return { ok: true };
  } catch (error) {
    console.error('[ElectronMain] openFilePath failed:', error);
    return { ok: false, error: String(error?.message || error) };
  }
});

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});