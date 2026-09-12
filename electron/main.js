import { app, BrowserWindow, desktopCapturer, ipcMain, shell, screen, dialog } from 'electron';
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
    // Aanya's own window never actually had "aanya" in its title despite
    // every focusTargetWindow() exclusion check in server.ts assuming it
    // would. This `title` option is only what shows before the page loads
    // — once index.html's <title> tag is read, Electron's
    // 'page-title-updated' event fires and the PAGE's title wins on the
    // native window, not this one. The real, lasting fix is index.html's
    // own <title> tag now also saying "Aanya" (see index.html) — that's
    // what nut-js's getWindows()/getActiveWindow() actually reports.
    // Keeping this option too just avoids a flash of "Aanya" -> "Electron"
    // -> "Aanya" while the page is still loading.
    title: 'Aanya',
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

// The renderer never receives arbitrary filesystem paths directly.  The
// native picker is kept in the main process and only returns a user-selected
// file, which is then read by the renderer for the current chat turn.
ipcMain.handle('select-chat-attachment', async (event) => {
  try {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Attach a file to Aanya',
      properties: ['openFile'],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return { error: 'Please select a file.' };

    // FEATURE (large video uploads, 500MB-1GB+): reading the whole file
    // into memory and base64-encoding it for the small-attachment path
    // (below) does not scale past a few tens of MB. A video, up to the
    // server's chunked-upload cap, is instead handed back as a bare
    // filePath -- the renderer calls uploadLargeVideo, which streams it to
    // the server in 8MB chunks straight from disk, never holding the whole
    // file in memory at once.
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const maxVideoBytes = 2 * 1024 * 1024 * 1024;
    const videoMimeByExtension = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
    if (videoMimeByExtension[extension]) {
      if (stats.size > maxVideoBytes) return { error: 'Videos must be 2 GB or smaller.' };
      return {
        name: path.basename(filePath),
        size: stats.size,
        mimeType: videoMimeByExtension[extension],
        filePath,
        isLargeVideo: true,
      };
    }

    const maxBytes = 25 * 1024 * 1024;
    if (stats.size > maxBytes) {
      return { error: 'Files must be 25 MB or smaller.' };
    }
    const data = await fs.readFile(filePath);
    return {
      name: path.basename(filePath),
      size: stats.size,
      // The server determines supported handling from content/type safely;
      // Electron deliberately does not infer an executable MIME type here.
      mimeType: 'application/octet-stream',
      data: data.toString('base64'),
    };
  } catch (error) {
    console.error('[ElectronMain] selectChatAttachment failed:', error);
    return null;
  }
});

app.whenReady().then(() => {
  createWindow();
});

// FEATURE (large video uploads, 500MB-1GB+): does the entire chunked-upload
// loop here in the main process, reading fixed-size slices straight from
// disk via a file handle. Nothing about the video ever crosses the
// Electron IPC boundary as base64 -- only small JSON status/progress
// messages do. Server-side endpoints already existed
// (/api/video-uploads/...); this is the first real caller of them.
const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
const SERVER_BASE_URL = 'http://localhost:3000';

ipcMain.handle('upload-large-video', async (event, { filePath, name, mimeType, size }) => {
  let fileHandle;
  try {
    const totalChunks = Math.ceil(size / VIDEO_CHUNK_BYTES);
    const createRes = await fetch(`${SERVER_BASE_URL}/api/video-uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: name, mimeType, size, totalChunks }),
    });
    if (!createRes.ok) {
      const body = await createRes.json().catch(() => ({}));
      throw new Error(body.error || `Could not start the upload (HTTP ${createRes.status}).`);
    }
    const { id } = await createRes.json();

    fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(VIDEO_CHUNK_BYTES);
    for (let index = 0; index < totalChunks; index++) {
      const position = index * VIDEO_CHUNK_BYTES;
      const { bytesRead } = await fileHandle.read(buffer, 0, VIDEO_CHUNK_BYTES, position);
      const chunk = buffer.subarray(0, bytesRead);
      const chunkRes = await fetch(`${SERVER_BASE_URL}/api/video-uploads/${id}/chunks/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.length) },
        body: chunk,
        duplex: 'half',
      });
      if (!chunkRes.ok) {
        const body = await chunkRes.json().catch(() => ({}));
        throw new Error(body.error || `Chunk ${index + 1}/${totalChunks} failed to upload.`);
      }
      event.sender.send('video-upload-progress', { id, progress: Math.round(((index + 1) / totalChunks) * 100) });
    }

    const completeRes = await fetch(`${SERVER_BASE_URL}/api/video-uploads/${id}/complete`, { method: 'POST' });
    if (!completeRes.ok) {
      const body = await completeRes.json().catch(() => ({}));
      throw new Error(body.error || 'Could not finalize the upload.');
    }
    return { id, name, mimeType, size };
  } catch (error) {
    console.error('[ElectronMain] uploadLargeVideo failed:', error);
    return { error: error?.message || 'Video upload failed.' };
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
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