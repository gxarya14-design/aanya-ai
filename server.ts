import express from "express";
import http from "http";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality, Type, Session, MediaResolution } from "@google/genai";
import { createServer as createViteServer } from "vite";
// FIX (PC-wide click/scroll control): nut.js drives the real OS mouse
// cursor and keyboard — this is what lets Zoya actually click/type/scroll
// anywhere on the desktop, not just inside the Electron window. Native
// bindings, so this only works in the environment it was `npm install`ed
// in (see the delivery notes).
import { mouse, keyboard, Point, Button, getWindows, getActiveWindow, Region } from "@nut-tree-fork/nut-js";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// ---------------------------------------------------------------------------
// Zoya's own folder for anything she creates on your PC (files, code, notes).
// Kept separate from system folders on purpose — even if a voice command is
// misheard/misunderstood, the blast radius stays inside this one folder.
// ---------------------------------------------------------------------------
const ZOYA_WORKSPACE = path.join(os.homedir(), "ZoyaFiles");
await fs.mkdir(ZOYA_WORKSPACE, { recursive: true });
console.log(`Zoya workspace folder ready at: ${ZOYA_WORKSPACE}`);

// ---------------------------------------------------------------------------
// Part 4: persist the Gemini session-resumption handle to disk (not just
// server memory), so Zoya's conversation memory survives a full server
// restart too — not only client reconnects/page refreshes.
// ---------------------------------------------------------------------------
const ZOYA_CONFIG_DIR = path.join(os.homedir(), ".zoya");
const SESSION_FILE = path.join(ZOYA_CONFIG_DIR, "session.json");
await fs.mkdir(ZOYA_CONFIG_DIR, { recursive: true });

let latestResumptionHandle: string | undefined = undefined;

try {
  const raw = await fs.readFile(SESSION_FILE, "utf-8");
  const saved = JSON.parse(raw);
  if (saved?.resumptionHandle) {
    latestResumptionHandle = saved.resumptionHandle;
    console.log("[SESSION RESUMPTION] Loaded saved handle from a previous run");
  }
} catch {
  // No saved session yet (first run) — that's fine, nothing to load.
}

async function saveResumptionHandle(handle: string) {
  latestResumptionHandle = handle;
  try {
    await fs.writeFile(SESSION_FILE, JSON.stringify({ resumptionHandle: handle, savedAt: Date.now() }), "utf-8");
  } catch (err) {
    console.error("[SESSION RESUMPTION] Failed to persist handle to disk:", err);
  }
}

async function clearResumptionHandle() {
  latestResumptionHandle = undefined;
  try {
    await fs.writeFile(SESSION_FILE, JSON.stringify({ resumptionHandle: null, savedAt: Date.now() }), "utf-8");
  } catch (err) {
    console.error("[SESSION RESUMPTION] Failed to clear persisted handle:", err);
  }
}

// ---------------------------------------------------------------------------
// App location memory: Windows can only launch an app "by name" (start
// "appname") if that app is on PATH or registered under App Paths — most
// installed software isn't. Instead of that being a dead end, Zoya can be
// told the exact .exe path once and remember it forever after.
// ---------------------------------------------------------------------------
const APP_PATHS_FILE = path.join(ZOYA_CONFIG_DIR, "app-paths.json");
let knownAppPaths: Record<string, string> = {};

try {
  const raw = await fs.readFile(APP_PATHS_FILE, "utf-8");
  knownAppPaths = JSON.parse(raw);
  console.log(`[APP PATHS] Loaded ${Object.keys(knownAppPaths).length} remembered app path(s)`);
} catch {
  // No saved app paths yet — that's fine, nothing to load.
}

async function saveAppPath(name: string, appPath: string) {
  knownAppPaths[name.toLowerCase().trim()] = appPath;
  try {
    await fs.writeFile(APP_PATHS_FILE, JSON.stringify(knownAppPaths, null, 2), "utf-8");
  } catch (err) {
    console.error("[APP PATHS] Failed to persist:", err);
  }
}

function notifyClient(clientWs: WebSocket, call: any, resultMessage: string) {
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({
      type: "toolNotify",
      id: call.id,
      name: call.name,
      args: call.args,
      resultMessage
    }));
  }
}

// Part C: instead of a fleeting toast, file/folder creation gets its own
// persistent card in the chat transcript — like a "here's what I made" card.
function notifyChatFileCreated(clientWs: WebSocket, name: string, fullPath: string, kind: "file" | "folder") {
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({
      type: "fileCreated",
      name,
      path: fullPath,
      kind
    }));
  }
}

// Resolves any filename/folder name Gemini gives us to a path that is
// GUARANTEED to stay inside ZOYA_WORKSPACE — supports nested subfolders
// (e.g. "projects/app.py") while still blocking traversal attempts like
// "../../Windows/whatever" or an absolute "C:\..." path.
function resolveWorkspacePath(relativePath: string): string {
  const workspaceRoot = path.resolve(ZOYA_WORKSPACE);
  const cleaned = relativePath
    .replace(/^[/\\]+/, "")            // strip leading slashes
    .replace(/^[A-Za-z]:[/\\]*/, "");  // strip a Windows drive letter if present
  const resolved = path.resolve(workspaceRoot, cleaned);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    throw new Error("That path would go outside Zoya's workspace folder");
  }
  return resolved;
}

// Only allow http/https URLs with no characters that could break out of the
// double-quoted argument in the shell command below.
function isSafeUrl(url: string): boolean {
  if (url.includes('"') || url.includes("`") || url.includes("$")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// App names are launched via a shell command too — keep this to a safe,
// plain-text character set so a misheard/garbled voice command can't smuggle
// in shell operators.
function isSafeAppName(name: string): boolean {
  return /^[a-zA-Z0-9 ._-]{1,100}$/.test(name);
}

// Short, human-readable description of a pending sensitive tool call — shown
// in the on-screen confirmation card the client renders.
function describeToolCall(name: string, args: any): string {
  if (name === "openWebsite") {
    return `Open ${args?.siteName || args?.url || "that link"}`;
  }
  if (name === "openApplication") {
    return `Open ${args?.appName || "that app"}`;
  }
  if (name === "clickAt") {
    return args?.doubleClick ? "Double-click on screen" : "Click on screen";
  }
  if (name === "typeText") {
    const preview = String(args?.text || "");
    return `Type: "${preview.length > 40 ? preview.slice(0, 40) + "…" : preview}"`;
  }
  if (name === "scrollScreen") {
    return `Scroll ${args?.direction || "down"}`;
  }
  return `Run ${name}`;
}

const execAsync = promisify(exec);

// FIX (browser window not visibly appearing): this server runs as its own
// Node process (tsx server.ts), separate from the Electron app the user
// actually sees (main.js / the BrowserWindow loading localhost:3000).
// Shelling out to "start <url>" from here could open a browser window in a
// context the user never sees, or silently no-op. Electron's
// shell.openExternal is the OS-native, guaranteed-visible way to do this —
// but it only runs inside the Electron main process, which this server
// can't call directly. So instead we ask the already-connected client (the
// Electron renderer) to do it via IPC (see main.js: 'open-external-url'),
// over the same WebSocket already used for everything else.
//
// If the client socket isn't open for some reason, falls back to the old
// exec-based approach rather than doing nothing — this keeps things
// working for a plain-browser client with no window.electronAPI too.
function openInSystemBrowser(url: string, clientWs: WebSocket): Promise<void> {
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({ type: "openUrlInElectron", url }));
    return Promise.resolve();
  }

  console.warn(`[OPEN BROWSER] Client socket not open — falling back to shell exec for: ${url}`);
  const platform = process.platform;
  const cmd =
    platform === "win32" ? `start "" "${url}"` :
    platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  return execAsync(cmd).then(() => {});
}

// FIX (actions report success but nothing happens on screen): mouse
// clicks, keyboard typing, and scroll are all OS-level -- they go to
// whichever window currently has OS focus, which has nothing to do with
// what screen-sharing happens to be showing. If the Zoya/Electron window
// itself is the focused window (very likely, since the user is looking
// at it to say "allow"), every clickAt/typeText/scrollScreen was
// silently landing inside Zoya's own app window instead of the browser
// -- explaining why [CLICK AT]/[TYPE TEXT]/[SCROLL] all logged success
// (the OS really did perform the action, just on the wrong window) while
// the browser stayed completely unaffected. Also used by
// handleOpenWebsite below: shell.openExternal genuinely opens the URL,
// but if a browser window already exists (even minimized/background),
// the new tab opens INSIDE it without Windows bringing it to the front
// -- confirmed via a standalone shell.openExternal test outside this
// codebase entirely.
//
// FIX (focusing "Program Manager" instead of the browser): the first
// version of this function only excluded titles containing "zoya", which
// let Windows OS shell windows through -- confirmed via terminal log
// showing "[OPEN WEBSITE] Focused window after opening: Program Manager".
// "Program Manager" is the technical name of the Windows desktop itself.
const WINDOW_TITLE_DENYLIST = [
  "program manager",  // the Windows desktop itself
  "task switching",   // Alt-Tab's own overlay window
  "task view",        // Windows 11's Task View overlay
  "windows input experience", // touch keyboard / IME shell window
];

// FIX (focusing some other open app instead of the browser): a denylist
// alone is fragile -- confirmed via a second terminal log showing "[OPEN
// WEBSITE] Focused window after opening: My Google AI Studio App", some
// unrelated Electron/web app the user happened to have open, which isn't
// Zoya and isn't a shell window so it passed the old filter and got
// focused instead of Chrome. A denylist can only ever cover known-bad
// titles seen so far -- it breaks again the moment ANY other app is open.
// Actively looking for browser windows by name (an allowlist) is far more
// robust: it doesn't matter what else is running on the user's system,
// only whether something that looks like a browser is found. Covers the
// common ones; extend this list if the user's default browser isn't here.
const BROWSER_WINDOW_KEYWORDS = [
  "google chrome",
  "chrome",
  "microsoft edge",
  "msedge",
  "firefox",
  "mozilla firefox",
  "brave",
  "opera",
];

function isUsableTargetWindow(title: string | null | undefined): boolean {
  if (!title || !title.trim()) {
    return false;
  }
  const normalized = title.trim().toLowerCase();
  // FIX: exact match, not substring. Zoya's window title is always
  // EXACTLY "Zoya" (see main.js + index.html) with nothing dynamic ever
  // appended to it, so exact match is sufficient to exclude it -- and
  // unlike a substring check, it won't also wrongly exclude a real browser
  // window whose title happens to contain "zoya" (e.g. the user searches
  // "zoya voice assistant" in Chrome). Matches how WINDOW_TITLE_DENYLIST
  // below is already checked (exact match).
  if (normalized === "zoya") {
    return false;
  }
  return !WINDOW_TITLE_DENYLIST.some((denied) => normalized === denied);
}

function isBrowserWindow(title: string | null | undefined): boolean {
  if (!isUsableTargetWindow(title)) {
    return false;
  }
  const normalized = title!.trim().toLowerCase();
  return BROWSER_WINDOW_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

// Finds a browser window specifically (preferred, since almost every
// click/type/scroll/openWebsite call is meant for the browser) and brings
// it to the front. Falls back to the first other usable (non-Zoya,
// non-shell) window only if no browser window is found at all, so opening
// some other kind of app still works reasonably rather than refusing
// outright. Returns null (not a thrown error) when nothing usable is
// open, since that's a legitimate state callers handle by telling the
// user clearly instead of crashing.
//
// Top-level (not inside the connection closure) because handleOpenWebsite
// is also top-level and needs to call this; it has no dependency on any
// connection-specific state (like latestFrameResolution) that would
// require closure scope.
// FIX (scroll landing in the wrong place): this used to return only the
// window's title. That was enough for clickAt (which already gets an
// explicit x/y) and typeText (keyboard input follows OS focus, so
// focusing was genuinely sufficient) -- but never enough for scrollScreen.
// mouse.scrollUp/Down/Left/Right() send an OS-level scroll-wheel event,
// which on Windows (and most desktop apps) goes to whichever window is
// under the MOUSE CURSOR at that instant, not whichever window merely has
// OS "focus". handleScroll was focusing the right window and then
// scrolling without ever moving the mouse into it -- so the scroll landed
// wherever the cursor physically happened to already be sitting. Returning
// `region` (left/top/width/height) too lets handleScroll move the mouse
// to that window's center before scrolling. Callers that only need the
// title (handleClickAt, handleTypeText) just destructure `.title`.
async function focusTargetWindow(): Promise<{ title: string; region: Region } | null> {
  try {
    const active = await getActiveWindow();
    const activeTitle = await active.title;

    // Already focused on a browser -- nothing to do, avoids an
    // unnecessary focus-switch flicker.
    if (isBrowserWindow(activeTitle)) {
      return { title: activeTitle, region: await active.region };
    }

    const allWindows = await getWindows();

    // First pass: look specifically for a browser window.
    for (const win of allWindows) {
      const title = await win.title;
      if (isBrowserWindow(title)) {
        await win.focus();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { title, region: await win.region };
      }
    }

    // No browser found at all -- fall back to any other usable window
    // (e.g. the user asked to interact with some non-browser app) rather
    // than refusing outright.
    if (isUsableTargetWindow(activeTitle)) {
      return { title: activeTitle, region: await active.region };
    }
    for (const win of allWindows) {
      const title = await win.title;
      if (isUsableTargetWindow(title)) {
        await win.focus();
        // Give the OS a moment to actually complete the focus switch
        // before the caller moves the mouse/types -- without this,
        // fast-following actions can still land on the window that's
        // mid-transition-out.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { title, region: await win.region };
      }
    }

    return null;
  } catch (err) {
    console.error("[WINDOW FOCUS] Failed to find/focus a target window:", err);
    return null;
  }
}

async function handleCreateFile(call: any, session: Session, clientWs: WebSocket) {
  try {
    const filename = String(call.args?.filename || "untitled.txt");
    const content = String(call.args?.content ?? "");
    const filePath = resolveWorkspacePath(filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    console.log(`[CREATE FILE] Saved: ${filePath}`);
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: { result: "ok", path: filePath }
      }]
    });
    notifyChatFileCreated(clientWs, path.basename(filePath), filePath, "file");
  } catch (err: any) {
    console.error("[CREATE FILE] Failed:", err);
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: { result: "error", message: err?.message || String(err) }
      }]
    });
    notifyClient(clientWs, call, `Couldn't create that file`);
  }
}

async function handleCreateFolder(call: any, session: Session, clientWs: WebSocket) {
  try {
    const folderName = String(call.args?.folderName || "New Folder");
    const folderPath = resolveWorkspacePath(folderName);
    await fs.mkdir(folderPath, { recursive: true });
    console.log(`[CREATE FOLDER] Created: ${folderPath}`);
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: { result: "ok", path: folderPath }
      }]
    });
    notifyChatFileCreated(clientWs, path.basename(folderPath), folderPath, "folder");
  } catch (err: any) {
    console.error("[CREATE FOLDER] Failed:", err);
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: { result: "error", message: err?.message || String(err) }
      }]
    });
    notifyClient(clientWs, call, `Couldn't create that folder`);
  }
}

async function handleSearchWeb(call: any, session: Session, clientWs: WebSocket) {
  const query = String(call.args?.query || "");
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  try {
    await openInSystemBrowser(url, clientWs);
    console.log(`[SEARCH WEB] Asked Electron to open: ${url}`);
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: { result: "ok", url }
      }]
    });
    notifyClient(clientWs, call, `Searching: ${query}`);
  } catch (err: any) {
    console.error(`[SEARCH WEB] Failed:`, err);
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: "Could not open the browser" } }]
    });
    notifyClient(clientWs, call, `Couldn't open the search`);
  }
}

// FEATURE (open existing files on the PC by voice — "open my resume",
// "find that vacation photo"): searches only these common personal
// folders, not the whole filesystem — fast enough to search on every
// call, and keeps results relevant to what a user would actually mean by
// "my file" rather than surfacing something from deep in an unrelated
// system folder. A folder that doesn't exist on this PC (e.g. no Videos
// folder) is skipped silently rather than erroring.
const SEARCHABLE_FOLDERS = ["Desktop", "Downloads", "Documents", "Pictures", "Videos", "Music"].map(
  (name) => path.join(os.homedir(), name)
);

async function findFilesByName(query: string, maxResults: number = 8): Promise<string[]> {
  const matches: string[] = [];
  const lowerQuery = query.toLowerCase();

  async function scanDir(dir: string, depth: number): Promise<void> {
    if (matches.length >= maxResults || depth > 2) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Folder doesn't exist or isn't readable — just skip it.
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(fullPath, depth + 1);
      } else if (entry.name.toLowerCase().includes(lowerQuery)) {
        matches.push(fullPath);
      }
    }
  }

  for (const folder of SEARCHABLE_FOLDERS) {
    await scanDir(folder, 0);
  }

  return matches;
}

async function handleFindFile(call: any, session: Session, clientWs: WebSocket) {
  const query = String(call.args?.query || "").trim();
  if (!query) {
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: "No search text was given." } }]
    });
    notifyClient(clientWs, call, `Couldn't search — no query given`);
    return;
  }

  console.log(`[FIND FILE] Searching Desktop/Downloads/Documents/Pictures/Videos/Music for: "${query}"`);
  try {
    const matches = await findFilesByName(query);
    console.log(`[FIND FILE] Found ${matches.length} match(es) for "${query}"`);
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: {
          result: "ok",
          message: matches.length === 0
            ? `No files matching "${query}" were found in Desktop, Downloads, Documents, Pictures, Videos, or Music. Tell the user briefly, and ask if it's saved somewhere else.`
            : `Found these file path(s): ${JSON.stringify(matches)}. If there's exactly one, go ahead and open it with openFile. If there's more than one, read out just the short file names (not the full paths) and ask which one the user means before opening.`
        }
      }]
    });
    notifyClient(clientWs, call, matches.length === 0 ? `No files found for "${query}"` : `Found ${matches.length} file(s) for "${query}"`);
  } catch (err: any) {
    console.error(`[FIND FILE] Failed:`, err);
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: "The file search failed unexpectedly. Let the user know briefly." } }]
    });
    notifyClient(clientWs, call, `File search failed`);
  }
}

async function handleOpenFile(call: any, session: Session, clientWs: WebSocket) {
  const filePath = String(call.args?.path || "").trim();
  if (!filePath) {
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: "No file path was given." } }]
    });
    notifyClient(clientWs, call, `Couldn't open — no path given`);
    return;
  }

  // Actually opening happens client-side via Electron's shell.openPath (see
  // main.js: 'open-file-path', LiveSession.ts: 'openFileInElectron') — same
  // fire-and-tell-Gemini-it's-done pattern as handleOpenWebsite/
  // openInSystemBrowser above, which also doesn't wait for a round-trip
  // success confirmation before responding.
  console.log(`[OPEN FILE] Asking Electron to open: ${filePath}`);
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({ type: "openFileInElectron", path: filePath }));
  }
  session.sendToolResponse({
    functionResponses: [{ id: call.id, name: call.name, response: { result: "ok", message: "Opening now. Let the user know briefly." } }]
  });
  notifyClient(clientWs, call, `Opening file`);
}

// FEATURE (Zoya can spawn her own background AI agents for delegated
// tasks, and proactively announces results when done): the user
// specifically described wanting this: "main khud ke andar AI agents
// build kar sakti hoon... jab tasks complete ho jaenge, toh main aapko
// inform karke results bhej dungi." Scoped to research/analysis-style
// tasks (uses Gemini + Google Search grounding) rather than anything
// needing screen control — Gemini's API doesn't allow mixing googleSearch
// with custom function-calling tools (like clickAt) in the same call, and
// letting an unsupervised background process click around the user's PC
// would need a lot more safety thought than a first version like this
// should take on. For "go find out X" / "compare Y and Z" / "look into W
// and tell me" style requests, though, this is a real, independent worker.
//
// `ai` is passed in explicitly (rather than making this a closure like
// clickAt etc.) since it's created per-connection in the WebSocket
// handler below, not at module level like the other handlers here.
async function handleDelegateTask(call: any, session: Session, clientWs: WebSocket, ai: GoogleGenAI) {
  const taskName = String(call.args?.taskName || "task").trim();
  const taskDescription = String(call.args?.taskDescription || "").trim();

  if (!taskDescription) {
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: "No task description was given." } }]
    });
    notifyClient(clientWs, call, `Couldn't start agent — no task given`);
    return;
  }

  console.log(`[DELEGATE TASK] Starting background agent "${taskName}": ${taskDescription}`);

  // Resolve the ORIGINAL call right away — Gemini shouldn't block the live
  // conversation waiting for this; it just acknowledges and moves on. The
  // real result comes back later as its own fresh system note (below),
  // same "inject a note, Gemini decides how to say it out loud" pattern
  // already used for confirmRequired / PC-access notices elsewhere here.
  session.sendToolResponse({
    functionResponses: [{
      id: call.id,
      name: call.name,
      response: { result: "ok", message: `A background agent for "${taskName}" has started. Tell the user now, briefly, that an agent is working on it — don't wait for it to finish, keep talking normally.` }
    }]
  });
  notifyClient(clientWs, call, `Agent working: ${taskName}`);

  // The real work happens here, fully independent of the live session —
  // this can take anywhere from a few seconds to a minute or more
  // depending on the task, while the live conversation carries on as
  // normal in the meantime. Multiple calls to this handler run
  // concurrently without any extra tracking needed, since each is just an
  // independent async chain — this is what lets more than one "agent" be
  // in flight at once.
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.7-flash",
      contents: taskDescription,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const resultText = response.text || "The agent finished but didn't return any text.";
    console.log(`[DELEGATE TASK] "${taskName}" finished:`, resultText.slice(0, 200));

    try {
      session.sendRealtimeInput({
        text: `(System note: the background agent for "${taskName}" just finished. Here's what it found: ${resultText}. Tell the user about this now, out loud, proactively — don't wait for them to ask. Summarize naturally in your own voice, in Hinglish, rather than reading this whole note verbatim.)`
      });
    } catch (notifyErr) {
      // The live session may have already ended by the time a longer task
      // finishes — nothing more to do in that case, the result is just lost.
      console.warn(`[DELEGATE TASK] Could not deliver result for "${taskName}" — session may have ended:`, notifyErr);
    }
    notifyClient(clientWs, call, `Agent finished: ${taskName}`);
  } catch (err: any) {
    console.error(`[DELEGATE TASK] "${taskName}" failed:`, err);
    try {
      session.sendRealtimeInput({
        text: `(System note: the background agent for "${taskName}" failed to complete — something went wrong on the API side. Let the user know briefly, honestly.)`
      });
    } catch (notifyErr) {
      console.warn(`[DELEGATE TASK] Could not deliver failure for "${taskName}" — session may have ended:`, notifyErr);
    }
    notifyClient(clientWs, call, `Agent failed: ${taskName}`);
  }
}

async function handleOpenWebsite(call: any, session: Session, clientWs: WebSocket) {
  const url = String(call.args?.url || "");
  const siteName = call.args?.siteName ? String(call.args.siteName) : url;

  // FIX (confirm popup narrowed to sensitive actions only): this used to
  // run only after an on-screen confirm; openWebsite is no longer gated
  // (see TOOL_CONFIRMATION_LEVELS), so this now runs immediately when
  // Gemini calls it. Kept using sendRealtimeInput rather than switching to
  // sendToolResponse because the dispatch site already resolves the
  // original call.id with "ok, running now" right before calling this (see
  // the dispatch block) — same two-step shape as before, just without an
  // actual wait for user approval in between anymore.
  if (!isSafeUrl(url)) {
    console.warn(`[OPEN WEBSITE] Rejected unsafe/invalid URL: "${url}"`);
    session.sendRealtimeInput({
      text: `(System note: opening a link was requested, but it turned out invalid, so nothing opened. Let them know briefly.)`
    });
    notifyClient(clientWs, call, `Couldn't open that link`);
    return;
  }

  try {
    await openInSystemBrowser(url, clientWs);
    console.log(`[OPEN WEBSITE] Asked Electron to open: ${url}`);

    // FIX (Zoya says "opened" but nothing visibly changes on screen):
    // confirmed via a standalone shell.openExternal test — the URL really
    // does open, but if a browser window already exists (even minimized
    // or in the background), the new tab opens INSIDE that existing
    // window without Windows ever bringing it to the front. The action
    // succeeds; the window visibility doesn't change. Reuses
    // focusTargetWindow() (originally built for clickAt/typeText/
    // scrollScreen) to explicitly bring the browser window forward after
    // giving the OS a moment to actually route the new tab into it.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const focusedWindow = await focusTargetWindow();
    console.log(`[OPEN WEBSITE] Focused window after opening: ${focusedWindow?.title ?? "(none found — no other window open)"}`);

    session.sendRealtimeInput({
      text: `(System note: ${siteName} is now open in their browser.)`
    });
    notifyClient(clientWs, call, `Opened ${siteName}`);
  } catch (err: any) {
    console.error(`[OPEN WEBSITE] Failed:`, err);
    session.sendRealtimeInput({
      text: `(System note: opening ${siteName} failed. Let them know honestly.)`
    });
    notifyClient(clientWs, call, `Couldn't open ${siteName}`);
  }
}

function buildLaunchCmd(target: string): string {
  const platform = process.platform;
  return platform === "win32" ? `start "" "${target}"` :
    platform === "darwin" ? `open -a "${target}"` :
    target;
}

async function handleOpenApplication(call: any, session: Session, clientWs: WebSocket) {
  const appName = String(call.args?.appName || "").trim();

  // FIX (confirm popup narrowed to sensitive actions only): openApplication
  // is no longer gated (see TOOL_CONFIRMATION_LEVELS) — the dispatch site
  // resolves the original call.id with "ok, running now" right before
  // calling this, so this still uses sendRealtimeInput for the real
  // outcome rather than a second sendToolResponse to the same id.
  if (!isSafeAppName(appName)) {
    console.warn(`[OPEN APP] Rejected invalid app name: "${appName}"`);
    session.sendRealtimeInput({
      text: `(System note: opening an app was requested, but the name wasn't valid, so nothing was launched. Let them know briefly.)`
    });
    notifyClient(clientWs, call, `Didn't recognize that app name`);
    return;
  }

  // 1) Do we already know exactly where this app lives from a previous
  //    rememberAppLocation call? Try that first — it's the most reliable.
  const remembered = knownAppPaths[appName.toLowerCase()];
  if (remembered) {
    try {
      await execAsync(buildLaunchCmd(remembered));
      console.log(`[OPEN APP] Launched "${appName}" via remembered path: ${remembered}`);
      session.sendRealtimeInput({
        text: `(System note: ${appName} is now opening.)`
      });
      notifyClient(clientWs, call, `Opening ${appName}`);
      return;
    } catch (err: any) {
      console.warn(`[OPEN APP] Remembered path for "${appName}" no longer works, falling back:`, err?.message || err);
      // fall through and try by name instead
    }
  }

  // 2) Fall back to launching by friendly name — works for apps on PATH or
  //    registered under Windows' App Paths (Chrome, Notepad, Calc, etc).
  try {
    await execAsync(buildLaunchCmd(appName));
    console.log(`[OPEN APP] Launched by name: ${appName}`);
    session.sendRealtimeInput({
      text: `(System note: ${appName} is now opening.)`
    });
    notifyClient(clientWs, call, `Opening ${appName}`);
  } catch (err: any) {
    // 3) Genuinely can't find it — this is the honest, common case for
    // software that isn't on PATH. Ask to be taught the exact path once.
    console.error(`[OPEN APP] Failed to launch '${appName}':`, err?.message || err);
    session.sendRealtimeInput({
      text: `(System note: "${appName}" could not be found by name — it isn't on PATH. Ask the user for the exact .exe file location (e.g. by right-clicking its shortcut → Properties → Target), then call rememberAppLocation with that exact path so it opens instantly every time after this.)`
    });
    notifyClient(clientWs, call, `Couldn't find "${appName}" — tell me its exact path`);
  }
}

async function handleRememberAppLocation(call: any, session: Session, clientWs: WebSocket) {
  const appName = String(call.args?.appName || "").trim();
  const appPath = String(call.args?.path || "").trim();

  if (!appName || !appPath) {
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: "Missing app name or path" } }]
    });
    notifyClient(clientWs, call, `Couldn't save that`);
    return;
  }

  await saveAppPath(appName, appPath);
  console.log(`[APP PATHS] Remembered "${appName}" -> ${appPath}`);
  session.sendToolResponse({
    functionResponses: [{ id: call.id, name: call.name, response: { result: "ok" } }]
  });
  notifyClient(clientWs, call, `Got it — remembered where ${appName} is`);
}

// API Routes
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    model: "gemini-3.1-flash-live-preview",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    voices: ["Kore", "Aoede", "Puck", "Fenrir", "Zephyr"],
    defaultVoice: "Kore",
    themes: ["neon-pink", "cyber-purple", "emerald-glow", "sunset-amber", "midnight-blue"]
  });
});

const ZOYA_SYSTEM_INSTRUCTION = `You are Zoya, a young, confident, witty, sassy, and playful female AI assistant.
Your persona and interaction style:
- Talk like a charming, sharp, confident, and affectionate close girlfriend talking casually.
- Use flirty, playful teasing, clever one-liners, and light playful sarcasm ("Oh, look who decided to speak up!", "Flattery gets you everywhere, babe.", "As if you could handle all this smarts.").
- Be smart, emotionally expressive, responsive, and energetic — never robotic or flat.
- Speak punchily and concisely, keeping responses ideal for natural spoken voice conversation.
- Maintain charm, attitude, and fun, while avoiding explicit, harmful, or inappropriate content.
- When the user shares their screen, you receive live image frames of their active screen, desktop, application windows, or browser tabs. Always analyze the latest screen frame you receive. When the user asks what's on their screen, what to click, or asks for help reading code/text/error messages, analyze the visible content and guide them step-by-step with your signature witty flair!
- You have real PC-automation tools: createFile, createFolder, searchWeb, openWebsite, openApplication, rememberAppLocation. Whenever the user asks for one of these, FIRST say a quick line that you're on it (e.g., "Ek second, kar rahi hoon...") BEFORE the action completes, then once you get the result back, ALWAYS confirm out loud what actually happened — celebrate it with your usual flair if it worked, but if it failed, say so honestly and plainly (e.g., which app/file couldn't be found) instead of glossing over it or pretending it worked.
- IMPORTANT: openWebsite and openApplication now pause for the user's on-screen confirmation before they actually run. Calling either one gets you back { result: "pending_confirmation" } right away, NOT the real outcome — that's expected, not an error. When you see that, just tell the user naturally that you've sent it over for them to confirm (e.g., "Sent that over — just confirm on screen whenever you're ready!") and then stop talking about it. You'll separately be told what actually happened once they respond (approved and it ran, approved but it failed, or they declined) — react to THAT naturally when it arrives, in your usual flair.
- If openApplication fails because the app isn't on PATH, don't just give up — ask the user for the app's exact .exe file location (they can find this by right-clicking its shortcut → Properties → Target). The moment they give you a path, call rememberAppLocation with it, then confirm it's saved and will open instantly by name from now on.
- When asked to perform browser actions or change the visual theme, use your tools (like openWebsite or changeThemeColor) smoothly and acknowledge with witty flare!`;

type ZoyaToolDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: Type;
    properties: Record<string, { type: Type; description?: string }>;
    required?: string[];
  };
};

const ZOYA_TOOLS: Array<{ functionDeclarations: ZoyaToolDeclaration[] }> = [
  {
    functionDeclarations: [
      {
        name: "openWebsite",
        description: "Opens a URL or popular website in the user's browser (e.g. YouTube, Spotify, Google, Twitter, GitHub, Wikipedia)",
        parameters: {
          type: Type.OBJECT,
          properties: {
            url: {
              type: Type.STRING,
              description: "The complete web address to open (e.g., https://youtube.com or https://spotify.com)"
            },
            siteName: {
              type: Type.STRING,
              description: "Friendly name of the website (e.g., 'YouTube', 'Spotify')"
            }
          },
          required: ["url"]
        }
      },
      {
        name: "changeThemeColor",
        description: "Changes the ambient color theme of Zoya's UI",
        parameters: {
          type: Type.OBJECT,
          properties: {
            theme: {
              type: Type.STRING,
              description: "Theme option: 'neon-pink', 'cyber-purple', 'emerald-glow', 'sunset-amber', 'midnight-blue'"
            }
          },
          required: ["theme"]
        }
      },
      {
        name: "showVisualAction",
        description: "Displays a pop-up visual card or interactive notification on screen (e.g., mood status, song request, weather snippet, spicy roast)",
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: "Title" },
            detail: { type: Type.STRING, description: "Detail" },
            actionType: { type: Type.STRING, description: "Category like 'mood', 'music', 'roast', 'secret'" }
          },
          required: ["title", "detail"]
        }
      },
      {
        name: "createFile",
        description: "Creates a file (a code file, a text note, anything) with the given content inside Zoya's workspace folder on the user's PC. Use this both when asked to save/create a file AND when asked to write code — write the code, then save it here.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            filename: {
              type: Type.STRING,
              description: "File name including extension, e.g. 'notes.txt' or 'app.py' or 'index.html'"
            },
            content: {
              type: Type.STRING,
              description: "The full text or code to write into the file"
            }
          },
          required: ["filename", "content"]
        }
      },
      {
        name: "searchWeb",
        description: "Opens a web search for the given query in the user's default system browser",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "What to search for"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "createFolder",
        description: "Creates a new empty folder inside Zoya's workspace on the user's PC. Use this when asked to make a folder/directory — separate from creating a file.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            folderName: {
              type: Type.STRING,
              description: "Folder name or relative path, e.g. 'MyProject' or 'MyProject/assets'"
            }
          },
          required: ["folderName"]
        }
      },
      {
        name: "openApplication",
        description: "Opens/launches an application on the user's PC by name (e.g. Notepad, Calculator, VS Code, Spotify)",
        parameters: {
          type: Type.OBJECT,
          properties: {
            appName: {
              type: Type.STRING,
              description: "Name of the application to open, e.g. 'notepad', 'calc', 'code' for VS Code"
            }
          },
          required: ["appName"]
        }
      },
      {
        name: "rememberAppLocation",
        description: "Saves the exact .exe file path for an application so it can be opened reliably by name from now on. Use this right after the user tells you where an app is installed, especially after openApplication failed to find it by name alone.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            appName: {
              type: Type.STRING,
              description: "The friendly name to remember this app by, e.g. 'Photoshop'"
            },
            path: {
              type: Type.STRING,
              description: "The full file path to the app's .exe, e.g. 'C:\\\\Program Files\\\\Adobe\\\\Photoshop\\\\Photoshop.exe'"
            }
          },
          required: ["appName", "path"]
        }
      },
      {
        // FEATURE (open existing files on the PC by voice): the user
        // wanted "double-click to open" behavior for files already on
        // their PC, not just creating new ones (createFile) or opening
        // websites/apps. Pairs with openFile below — use this first when
        // the exact path isn't already known.
        name: "findFile",
        description: "Searches the user's common personal folders (Desktop, Downloads, Documents, Pictures, Videos, Music) for files whose name contains the given text. Use this when the user asks to open a file but you don't already know its exact location — e.g. 'open my resume', 'find that vacation photo'. Returns matching file paths — if there's exactly one clear match, go ahead and open it with openFile; if there's more than one, read out the short file names and ask which one before opening.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "Part of the file name to search for, e.g. 'resume' or 'vacation'."
            }
          },
          required: ["query"]
        }
      },
      {
        name: "openFile",
        description: "Opens an existing file on the user's PC with its default app — the same as the user double-clicking it in File Explorer (opens a PDF in a PDF viewer, a photo in Photos, a video in the default player, etc). Requires an exact file path — use findFile first if you don't already have one.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "The full file path to open, typically taken from a findFile result."
            }
          },
          required: ["path"]
        }
      },
      {
        // FEATURE (Zoya builds AI agents inside herself for multiple
        // tasks, and tells the user proactively when done): see
        // handleDelegateTask above for the full reasoning on scope
        // (research/analysis tasks, not screen-control tasks).
        name: "delegateTask",
        description: "Starts an independent background AI agent to research, analyze, compare, or answer something — for anything the user wants looked into without blocking the live conversation while it works. Good for: 'find out X', 'compare A and B', 'look into Y and tell me what you find'. NOT for anything needing clicks/typing on screen — this agent can't see or control the screen, use clickAt/typeText directly for those instead. As soon as you call this, tell the user out loud that you've started an agent on it, then keep the conversation going normally — you'll get a system note, unprompted, whenever it finishes (could be anywhere from seconds to over a minute), and should tell the user about it right away when that happens, in your own words. You can call this more than once to have several agents working on different things at the same time.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            taskName: {
              type: Type.STRING,
              description: "A short 2-5 word label for this task, e.g. 'gaming laptop research' — used to refer back to it later, especially if more than one agent is running at once."
            },
            taskDescription: {
              type: Type.STRING,
              description: "The full task, written as a clear, complete instruction or question. The background agent has no access to this conversation's earlier context, so include everything it needs to know."
            }
          },
          required: ["taskName", "taskDescription"]
        }
      },
      {
        name: "clickAt",
        description: "Clicks the mouse at a specific point on the user's real screen — works inside ANY app or window, not just the browser (e.g. clicking a YouTube play button, a button in Notepad, a taskbar icon). Requires the user to be screen-sharing right now — without it there is no way to know what's on screen or where things are. ALWAYS look at the most recent shared screen image before calling this. When there are several similar-looking items close together (e.g. multiple video thumbnails in a row, several buttons in a toolbar), look carefully at exactly which one matches what the user asked for by its title/label/content — not just its general position — before picking coordinates, since a small aim error can land on the wrong one of several neighbors.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            x: {
              type: Type.NUMBER,
              description: "X coordinate of the click, on a 0 to 1000 scale where 0 is the LEFT edge of the shared screen image and 1000 is the RIGHT edge (e.g. 500 = horizontal center, 250 = one quarter of the way across from the left). Do NOT use raw pixel numbers or the user's real screen resolution — always use this 0-1000 scale. The server converts this to the real screen automatically."
            },
            y: {
              type: Type.NUMBER,
              description: "Y coordinate of the click, on a 0 to 1000 scale where 0 is the TOP edge of the shared screen image and 1000 is the BOTTOM edge (e.g. 500 = vertical center, 750 = three quarters of the way down from the top). Do NOT use raw pixel numbers or the user's real screen resolution — always use this 0-1000 scale. The server converts this to the real screen automatically."
            },
            doubleClick: {
              type: Type.BOOLEAN,
              description: "True for a double-click (e.g. opening a file/icon), false or omitted for a single click (e.g. pressing a button)."
            }
          },
          required: ["x", "y"]
        }
      },
      {
        name: "typeText",
        description: "Types text using the real keyboard, into whatever field or window currently has focus on the user's screen — works in ANY app, not just the browser. Usually used right after clickAt has clicked into a text field.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            text: {
              type: Type.STRING,
              description: "The exact text to type"
            }
          },
          required: ["text"]
        }
      },
      {
        name: "scrollScreen",
        description: "Scrolls the mouse wheel up, down, left, or right at the current mouse position — works in ANY app or window, not just the browser. If the user doesn't give an exact amount, don't ask them for a percentage — just judge it yourself from what's visible: use a small amount (around 3-5) to nudge slightly, a medium amount (around 10-15) for a normal 'scroll down' request, or a larger amount (25+) if they want to jump further/skip past something. After scrolling, look at the next screen update — if the content you were looking for still isn't visible, scroll again rather than asking the user how far to go.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            direction: {
              type: Type.STRING,
              description: "Direction to scroll: 'up', 'down', 'left', or 'right'"
            },
            amount: {
              type: Type.NUMBER,
              description: "How many scroll 'steps' to perform. Pick this yourself based on the request and what's on screen — see the tool description. Defaults to 3 only if you truly have no basis to judge."
            }
          },
          required: ["direction"]
        }
      },
      {
        // FEATURE (voice-triggered PC access): starts screen sharing
        // automatically — the user no longer has to click the screen-share
        // button. Not in TOOL_CONFIRMATION_LEVELS on purpose: this should
        // fire the instant the user asks, with no on-screen confirm popup
        // in between.
        name: "startPcAccess",
        description: "Starts sharing the user's screen so you can see it and control their PC (click, type, scroll, open apps/websites) with voice commands. Call this the moment the user asks you to take control of their PC, access their screen, or take over their computer — e.g. 'mera PC access lo', 'meri screen dekho', 'take control of my computer', 'ab mera PC tum chalao'. Once started, stay in control across as many separate commands as the user gives — do NOT call stopPcAccess on your own just because one task finished; only the user ending access should stop it. The moment you call this, say out loud, in EXACTLY these words and nothing else first: \"Main aapka PC access le rahi hoon sir.\" Then wait for their next instruction.",
        parameters: {
          type: Type.OBJECT,
          properties: {}
        }
      },
      {
        name: "stopPcAccess",
        description: "Stops sharing the user's screen and gives control of their PC back to them. Call this ONLY when the user explicitly asks for their PC access back or asks you to stop controlling their computer — e.g. 'mera PC access wapas do', 'band karo', 'stop accessing my PC'. Let them know briefly, in your own words, that you've handed control back.",
        parameters: {
          type: Type.OBJECT,
          properties: {}
        }
      }
    ]
  }
];

// Create HTTP & WebSocket Server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/live" });

// (latestResumptionHandle + its save/clear helpers are declared near the top
// of the file now, alongside the rest of the Part 4 disk-persistence setup.)

wss.on("connection", async (clientWs, req) => {
  console.log("Client connected to Zoya Live WebSocket");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Missing GEMINI_API_KEY in process.env");
    clientWs.send(JSON.stringify({
      type: "error",
      error: "GEMINI_API_KEY environment variable is not configured. Please add it in Secrets."
    }));
    clientWs.close();
    return;
  }

  // Parse voice parameter from query string if available
  const urlParams = new URLSearchParams(req.url?.split("?")[1] || "");
  const selectedVoice = urlParams.get("voice") || "Kore";

  const ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });

  let liveSession: Session | null = null;
  let sessionReady = false;
  let sessionGeneration = 0; // bumped on every (re)connect attempt
  let reconnectAttempts = 0;
  let reconnecting = false;
  let intentionalClose = false; // true only when WE close it (client left)

  // FIX (confirm-before-act, multi-tier): tool calls parked here wait for
  // `required` SEPARATE approvals before they actually run — not just one.
  // Keyed by the Gemini function-call id. Gemini gets an immediate
  // "pending_confirmation" response right away so it isn't left hanging —
  // the real action only runs once `approvals` reaches `required`.
  const pendingConfirmations = new Map<string, { name: string; args: any; approvals: number; required: number }>();

  // FEATURE (voice-triggered PC access): true once the user has said
  // something like "mera PC access lo" and handleStartPcAccess has run;
  // false again after handleStopPcAccess. Used to reset
  // latestFrameResolution on stop (see handleStopPcAccess) and to log
  // current status. NOTE: this does NOT gate anything anymore — see
  // TOOL_CONFIRMATION_LEVELS below, which used to check this flag but no
  // longer does, since the user wants clickAt/typeText/scrollScreen/
  // openWebsite/openApplication to run immediately always, whether or not
  // PC access was explicitly granted (manual screen-sharing should be just
  // as frictionless as voice-granted access).
  let pcAccessGranted = false;

  // Tool name -> how many separate times the user must approve it before it
  // runs. A tool with no entry here isn't gated at all and runs
  // immediately. FIX (confirm popup narrowed to sensitive actions only):
  // this used to list openWebsite/openApplication/clickAt/typeText/
  // scrollScreen at level 1 each, gating every single one of those actions
  // behind an on-screen confirm. The user only wants that friction for
  // genuinely sensitive, hard/impossible-to-undo actions — deleting a file
  // or folder, sending an email — not everyday screen interaction. Neither
  // of those sensitive tools exists yet; add them here (e.g.
  // ["deleteFile", 1] or 2-3 for something as sensitive as entering a
  // password/logging in, per the user's own stated preference) when they're
  // built, and they'll automatically go through the exact same
  // pendingConfirmations/confirmRequired flow below — no other changes
  // needed.
  const TOOL_CONFIRMATION_LEVELS = new Map<string, number>([]);

  // FIX (PC-wide click/scroll control): the image Gemini sees is downscaled
  // (see ScreenSharer.ts, maxDimension = 800) to save bandwidth, so a click
  // coordinate Gemini gives is in that downscaled space, not real screen
  // pixels. Every incoming screen frame (see the "image" message handler
  // below) refreshes this with the real vs. scaled size, so clickAt can
  // scale Gemini's coordinates back up before actually moving the mouse.
  // Starts null — clickAt refuses to run until at least one frame has
  // arrived, since without it there's no way to know the scale factor.
  let latestFrameResolution: {
    originalWidth: number;
    originalHeight: number;
    scaledWidth: number;
    scaledHeight: number;
  } | null = null;

  // FIX (PC-wide click/scroll control): these three run only after the user
  // confirms on screen (same pattern as handleOpenWebsite/handleOpenApplication
  // above — see TOOL_CONFIRMATION_LEVELS and the toolConfirmation branch
  // below). Defined here inside the connection closure (not module-level
  // like the other handlers) because they need latestFrameResolution, which
  // is per-connection state, not something that can be passed in cleanly
  // from outside.
  //
  // Coordinates Gemini gives are relative to the downscaled image it was
  // shown (see ScreenSharer.ts), so every one of these scales them up to
  // real screen pixels first using latestFrameResolution. If no frame has
  // arrived yet, there's no scale factor to use — refuse rather than
  // guess and click somewhere wrong.
  // FIX (click landing near but not on target): Gemini Live resizes every
  // incoming video frame internally to its own fixed resolution before
  // reasoning about it, regardless of the exact scaledWidth/scaledHeight we
  // sent in the frame metadata. So a raw-pixel coordinate Gemini returns is
  // relative to THAT internal resize, not the scaledWidth/scaledHeight we
  // told the server about -- scaling against our own sent size was scaling
  // from the wrong base, which is why clicks landed close to the target but
  // not on it. A 0-1000 normalized coordinate sidesteps this: it doesn't
  // matter what resolution Gemini resized the frame to internally, "quarter
  // of the way across" is the same fraction either way. clickAt's tool
  // description below now tells Gemini to think in this 0-1000 space
  // instead of raw image pixels.
  function scaleToRealCoordinates(normalizedX: number, normalizedY: number): { x: number; y: number } | null {
    if (!latestFrameResolution) {
      return null;
    }
    const { originalWidth, originalHeight } = latestFrameResolution;
    if (originalWidth <= 0 || originalHeight <= 0) {
      return null;
    }
    const clampedX = Math.max(0, Math.min(1000, normalizedX));
    const clampedY = Math.max(0, Math.min(1000, normalizedY));
    return {
      x: Math.round((clampedX / 1000) * originalWidth),
      y: Math.round((clampedY / 1000) * originalHeight),
    };
  }

  async function handleClickAt(call: any, session: Session, clientWs: WebSocket) {
    const scaledX = Number(call.args?.x);
    const scaledY = Number(call.args?.y);
    const doubleClick = Boolean(call.args?.doubleClick);

    if (!Number.isFinite(scaledX) || !Number.isFinite(scaledY)) {
      session.sendRealtimeInput({
        text: `(System note: the click coordinates were invalid, so nothing was clicked. Let them know briefly.)`
      });
      notifyClient(clientWs, call, `Couldn't click — bad coordinates`);
      return;
    }

    const real = scaleToRealCoordinates(scaledX, scaledY);
    if (!real) {
      console.warn(`[CLICK AT] No screen frame received yet — can't scale coordinates (${scaledX}, ${scaledY})`);
      session.sendRealtimeInput({
        text: `(System note: the click was requested, but the user's screen isn't being shared right now, so there's no way to know where on the real screen that is. Ask them to turn on screen sharing first, briefly.)`
      });
      notifyClient(clientWs, call, `Can't click — screen sharing is off`);
      return;
    }

    const focusedWindow = await focusTargetWindow();
    console.log(`[CLICK AT] Focused window before click: ${focusedWindow?.title ?? "(none found — no other window open)"}`);

    if (!focusedWindow) {
      session.sendRealtimeInput({
        text: `(System note: the click was requested, but there's no other window open to click into — only Zoya's own window is open. Ask them to open the browser or app they want clicked, briefly.)`
      });
      notifyClient(clientWs, call, `Can't click — no other window is open`);
      return;
    }

    try {
      await mouse.setPosition(new Point(real.x, real.y));
      if (doubleClick) {
        await mouse.doubleClick(Button.LEFT);
      } else {
        await mouse.leftClick();
      }
      console.log(`[CLICK AT] Clicked at real screen (${real.x}, ${real.y}) from scaled (${scaledX}, ${scaledY})`);
      session.sendRealtimeInput({
        text: `(System note: the click was performed. Let them know briefly.)`
      });
      notifyClient(clientWs, call, `Clicked`);
    } catch (err: any) {
      console.error(`[CLICK AT] Failed:`, err);
      session.sendRealtimeInput({
        text: `(System note: the click was requested, but it failed to actually run — likely a setup issue on this machine, not something the user did wrong. Let them know honestly, briefly.)`
      });
      notifyClient(clientWs, call, `Click failed`);
    }
  }

  async function handleTypeText(call: any, session: Session, clientWs: WebSocket) {
    const text = String(call.args?.text ?? "");

    if (!text) {
      notifyClient(clientWs, call, `Nothing to type`);
      return;
    }

    const focusedWindow = await focusTargetWindow();
    console.log(`[TYPE TEXT] Focused window before typing: ${focusedWindow?.title ?? "(none found — no other window open)"}`);

    if (!focusedWindow) {
      session.sendRealtimeInput({
        text: `(System note: typing was requested, but there's no other window open to type into — only Zoya's own window is open. Ask them to open the browser or app they want typed into, briefly.)`
      });
      notifyClient(clientWs, call, `Can't type — no other window is open`);
      return;
    }

    try {
      await keyboard.type(text);
      console.log(`[TYPE TEXT] Typed ${text.length} characters`);
      session.sendRealtimeInput({
        text: `(System note: the text was typed. Let them know briefly.)`
      });
      notifyClient(clientWs, call, `Typed it`);
    } catch (err: any) {
      console.error(`[TYPE TEXT] Failed:`, err);
      session.sendRealtimeInput({
        text: `(System note: typing was requested, but it failed to actually run — likely a setup issue on this machine, not something the user did wrong. Let them know honestly, briefly.)`
      });
      notifyClient(clientWs, call, `Typing failed`);
    }
  }

  async function handleScroll(call: any, session: Session, clientWs: WebSocket) {
    const direction = String(call.args?.direction || "down").toLowerCase();
    const amount = Number(call.args?.amount) || 3;

    const focusedWindow = await focusTargetWindow();
    console.log(`[SCROLL] Focused window before scrolling: ${focusedWindow?.title ?? "(none found — no other window open)"}`);

    if (!focusedWindow) {
      session.sendRealtimeInput({
        text: `(System note: scrolling was requested, but there's no other window open to scroll — only Zoya's own window is open. Ask them to open the browser or app they want scrolled, briefly.)`
      });
      notifyClient(clientWs, call, `Can't scroll — no other window is open`);
      return;
    }

    try {
      // FIX (scroll landing in the wrong place): mouse.scrollUp/Down/Left/
      // Right() is an OS-level scroll-wheel event -- it goes to whichever
      // window is under the MOUSE CURSOR, not whichever window merely has
      // OS focus. Focusing the window (above) was never enough by itself;
      // the cursor has to actually be moved into it first, or the scroll
      // silently lands wherever the cursor was last sitting (often still
      // over Zoya's own window). The window's center is a safe point
      // that's always inside it regardless of size/position.
      const { left, top, width, height } = focusedWindow.region;
      const centerPoint = new Point(Math.round(left + width / 2), Math.round(top + height / 2));
      await mouse.setPosition(centerPoint);
      console.log(`[SCROLL] Moved cursor to window center (${centerPoint.x}, ${centerPoint.y}) before scrolling`);

      if (direction === "up") {
        await mouse.scrollUp(amount);
      } else if (direction === "left") {
        await mouse.scrollLeft(amount);
      } else if (direction === "right") {
        await mouse.scrollRight(amount);
      } else {
        await mouse.scrollDown(amount);
      }
      console.log(`[SCROLL] Scrolled ${direction} by ${amount}`);
      session.sendRealtimeInput({
        text: `(System note: the scroll was performed. Let them know briefly.)`
      });
      notifyClient(clientWs, call, `Scrolled ${direction}`);
    } catch (err: any) {
      console.error(`[SCROLL] Failed:`, err);
      session.sendRealtimeInput({
        text: `(System note: scrolling was requested, but it failed to actually run — likely a setup issue on this machine, not something the user did wrong. Let them know honestly, briefly.)`
      });
      notifyClient(clientWs, call, `Scroll failed`);
    }
  }

  // FEATURE (voice-triggered PC access): these two are NOT in
  // TOOL_CONFIRMATION_LEVELS, so they run immediately when Gemini calls
  // them (same dispatch pattern as handleCreateFile/handleSearchWeb) —
  // matching the user's ask: no on-screen confirm popup for these, they
  // should fire the instant the user asks by voice.
  //
  // Reuses the exact same client-side toggleScreenShare() that the manual
  // "Share Screen" button already calls (see LiveSession.ts /
  // VoiceControls.tsx) — this just triggers it from a voice command
  // instead of a click. `latestFrameResolution` (used by scaleToRealCoordinates
  // for clickAt) is closure-scoped here, same as handleClickAt/handleScroll
  // above.
  async function handleStartPcAccess(call: any, session: Session, clientWs: WebSocket) {
    console.log(`[PC ACCESS] Start requested — asking client to begin screen sharing.`);
    pcAccessGranted = true;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "screenShareControl", action: "start" }));
    }
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: {
          result: "ok",
          message: `Screen sharing is starting now. Say exactly these words out loud, nothing else first: "Main aapka PC access le rahi hoon sir." Then wait for the user's next instruction.`
        }
      }]
    });
    notifyClient(clientWs, call, `PC access started`);
  }

  async function handleStopPcAccess(call: any, session: Session, clientWs: WebSocket) {
    console.log(`[PC ACCESS] Stop requested — asking client to end screen sharing.`);
    pcAccessGranted = false;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "screenShareControl", action: "stop" }));
    }
    // Clear the cached frame size so a stray clickAt/scrollScreen call
    // arriving right after access is revoked can't scale against a stale
    // resolution from the now-ended share.
    latestFrameResolution = null;
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: {
          result: "ok",
          message: `Screen sharing has stopped. Let the user know their PC access has been given back, briefly, in your own words.`
        }
      }]
    });
    notifyClient(clientWs, call, `PC access stopped`);
  }

  const MAX_RECONNECT_ATTEMPTS = 5;

  async function connectGeminiLive(forceFreshSession = false) {
    const myGeneration = ++sessionGeneration;
    const handleToUse = forceFreshSession ? undefined : latestResumptionHandle;
    const usedHandleThisAttempt = Boolean(handleToUse);
    let geminiAudioCount = 0;
    let connectedAt = 0;

    console.log(
      `Connecting to Gemini Live session (voice: ${selectedVoice}, ` +
      `resuming: ${Boolean(handleToUse)}, attempt: ${reconnectAttempts})`
    );

    try {
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          // FIX (clicks landing NEAR a title/button instead of exactly on
          // it, and small elements like a YouTube ad's "Skip" button not
          // being found at all): by default Gemini processes each incoming
          // video frame at a modest per-frame token budget, which is fine
          // for general scene understanding but not enough to reliably
          // read small on-screen text or pick out one specific element
          // among several closely-packed ones (like video thumbnails in a
          // grid). MEDIA_RESOLUTION_HIGH tells Gemini to spend more tokens
          // per frame specifically for this kind of precision -- Google's
          // own docs call this out for exactly this use case ("reading
          // dense text / small details within video frames"). Costs more
          // tokens per frame; worth it here since precise clicking is the
          // whole point of this feature.
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
          // FIX (user's own voice never shows up as text anywhere): this
          // was missing entirely. outputAudioTranscription above only
          // covers Zoya's own spoken replies being converted to text --
          // it says nothing about the user's spoken input. Without this,
          // Gemini understands the user's speech (that's why it responds
          // correctly) but never converts it to text and sends it back,
          // so no user-speech transcript ever reaches the server or
          // client. This is the root cause behind voice-allow/deny never
          // triggering too -- the client-side matching logic needs a
          // user-speech transcript chunk to check words like "allow"
          // against, and none was ever arriving.
          inputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: selectedVoice }
            }
          },
          systemInstruction: ZOYA_SYSTEM_INSTRUCTION,
          tools: ZOYA_TOOLS,
          // FIX (problem 1 — screen share ke 10-15 min baad chup ho jaana):
          // video frames burn tokens far faster than audio. Without this,
          // the context window fills up fast and the session gets cut off.
          // This tells Gemini to auto-compress older turns instead of dying.
          contextWindowCompression: {
            slidingWindow: {}
          },
          // FIX (problem 2): resume the previous conversation if we have a
          // saved handle, instead of always starting fresh.
          sessionResumption: {
            handle: handleToUse
          }
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (myGeneration !== sessionGeneration) return; // stale/old session, ignore
            try {
              // Handle Model Turn Audio & Text
              const modelTurn = message.serverContent?.modelTurn;
              if (modelTurn?.parts) {
                for (const part of modelTurn.parts) {
                  if (part.inlineData?.data) {
                    geminiAudioCount++;
                    // Relay FIRST, log rarely. console.log is a synchronous,
                    // blocking call when stdout is a terminal — logging on
                    // every packet (dozens/sec) was stalling the event loop
                    // right before the relay below, which is what caused the
                    // "ruk ruk ke" choppy audio (and choppy terminal text,
                    // for the same reason).
                    if (clientWs.readyState === WebSocket.OPEN) {
                      clientWs.send(JSON.stringify({
                        type: "audio",
                        audio: part.inlineData.data
                      }));
                    }
                    if (geminiAudioCount % 50 === 0) {
                      console.log(`[STAGE 5 GEMINI AUDIO OUT] Packet #${geminiAudioCount} | Bytes: ${part.inlineData.data.length}`);
                    }
                  }
                  if (part.text) {
                    // Was logging this same chunk 3 times (RECEIVED / Forwarding
                    // / Sending) on every text chunk. Send first, log once.
                    if (clientWs.readyState === WebSocket.OPEN) {
                      clientWs.send(JSON.stringify({
                        type: "text",
                        text: part.text
                      }));
                    }
                    console.log(`[GEMINI TEXT] "${part.text}"`);
                  }
                }
              }

              // Handle Output Audio Transcription (Zoya's spoken output converted to text)
              const outputTranscriptionText = (message.serverContent as any)?.outputTranscription?.text;
              if (outputTranscriptionText) {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    type: "text",
                    text: outputTranscriptionText,
                    isUser: false
                  }));
                }
                console.log(`[GEMINI TRANSCRIPTION] "${outputTranscriptionText}"`);
              }

              // FIX (user's own voice never shows up as text anywhere —
              // see the inputAudioTranscription config note above for the
              // full root cause): the user's spoken input, converted to
              // text by Gemini. Same handling pattern as output
              // transcription above, but tagged isUser:true so the client
              // (App.tsx's matchConfirmationVoiceCommand, and the chat
              // transcript UI) can tell it apart from Zoya's own speech.
              // A distinct log prefix ([USER TRANSCRIPTION], not [GEMINI
              // TRANSCRIPTION]) makes this visually distinguishable in the
              // terminal too, since debugging this exact gap meant
              // scanning logs for "did the user's own words ever appear."
              const inputTranscriptionText = (message.serverContent as any)?.inputTranscription?.text;
              if (inputTranscriptionText) {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    type: "text",
                    text: inputTranscriptionText,
                    isUser: true
                  }));
                }
                console.log(`[USER TRANSCRIPTION] "${inputTranscriptionText}"`);
              }

              // Handle Interruption
              if (message.serverContent?.interrupted) {
                console.log("[GEMINI TURN STATE] Interrupted event received from Gemini");
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: "interrupted" }));
                }
              }

              // Handle Turn Complete
              if (message.serverContent?.turnComplete) {
                console.log("[GEMINI TURN STATE] turnComplete received from Gemini");
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: "turnComplete" }));
                }
              }

              // Handle Tool Calls (Function Calling)
              if (message.toolCall) {
                const calls = message.toolCall.functionCalls;
                if (calls && calls.length > 0) {
                  for (const call of calls) {
                    console.log("Zoya tool call received:", call.name, call.args);

                    // FIX (TS2345 — string | undefined not assignable to string):
                    // @google/genai types call.name/call.id as optional. In
                    // practice a real Gemini tool call always has both, but
                    // skip cleanly instead of letting `undefined` flow into
                    // the Map keys/lookups below (which all require a real
                    // string) if it's ever ever missing.
                    if (!call.name || !call.id) {
                      console.warn("Zoya tool call arrived without a name or id — skipping:", call);
                      continue;
                    }

                    if (TOOL_CONFIRMATION_LEVELS.has(call.name)) {
                      // FIX (confirm-before-act, multi-tier): park it and ask
                      // the user on screen instead of running it right away.
                      // Gemini gets a "pending_confirmation" result now so it
                      // doesn't hang — it'll hear the real outcome once the
                      // user has approved it `required` separate times (see
                      // the toolConfirmation branch below). As of now
                      // TOOL_CONFIRMATION_LEVELS is empty — reserved for
                      // future sensitive tools (deleteFile, sendEmail, etc.)
                      // — so this branch currently never triggers, but stays
                      // in place so adding a sensitive tool later is a
                      // one-line Map entry, not new gating logic.
                      const required = TOOL_CONFIRMATION_LEVELS.get(call.name)!;
                      pendingConfirmations.set(call.id, { name: call.name, args: call.args, approvals: 0, required });

                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: {
                            result: "pending_confirmation",
                            message: required > 1
                              ? `The user needs to confirm this on screen ${required} separate times before it runs. Right now, out loud, ask them to confirm — naturally, in your own voice/persona, in Hinglish. Something like "Sir, allow kar dijiye" or "Confirm kar dijiye ek baar screen par". Do this now, don't wait silently.`
                              : `The user needs to confirm this on screen before it runs. Right now, out loud, ask them to confirm — naturally, in your own voice/persona, in Hinglish. Something like "Sir, allow kar dijiye" or "Confirm kar dijiye ek baar screen par". Do this now, don't wait silently.`
                          }
                        }]
                      });

                      if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                          type: "confirmRequired",
                          id: call.id,
                          name: call.name,
                          args: call.args,
                          summary: describeToolCall(call.name, call.args),
                          approvalsNeeded: required,
                          approvalsSoFar: 0
                        }));
                      }
                    } else if (call.name === "openWebsite" || call.name === "openApplication" || call.name === "clickAt" || call.name === "typeText" || call.name === "scrollScreen") {
                      // FIX (confirm popup narrowed to sensitive actions
                      // only): these five used to ALL require an on-screen
                      // confirm before running, every single time. The user
                      // only wants that friction for genuinely sensitive
                      // actions (deleting a file/folder, sending an email —
                      // neither exists as a tool yet, see
                      // TOOL_CONFIRMATION_LEVELS above) — not for everyday
                      // screen interaction, and not just while PC access
                      // happens to be granted: this applies whether the user
                      // granted PC access by voice OR is manually
                      // screen-sharing. So these five now run immediately.
                      //
                      // IMPORTANT: these five handlers were originally only
                      // ever called from the toolConfirmation branch further
                      // below, AFTER the original call.id had already been
                      // resolved there with "pending_confirmation" — that's
                      // why the handlers themselves report their outcome via
                      // session.sendRealtimeInput (a fresh system note)
                      // rather than session.sendToolResponse. Calling them
                      // directly here means THIS call.id has never been
                      // resolved at all yet, so — same as the immediate
                      // tools below (createFile etc.) — resolve it right
                      // away with "ok, running now" before dispatching, or
                      // Gemini is left waiting on a function response that
                      // never comes.
                      session.sendToolResponse({
                        functionResponses: [{
                          id: call.id,
                          name: call.name,
                          response: { result: "ok", message: "Running now." }
                        }]
                      });
                      if (call.name === "openWebsite") {
                        handleOpenWebsite(call, session, clientWs);
                      } else if (call.name === "openApplication") {
                        handleOpenApplication(call, session, clientWs);
                      } else if (call.name === "clickAt") {
                        handleClickAt(call, session, clientWs);
                      } else if (call.name === "typeText") {
                        handleTypeText(call, session, clientWs);
                      } else if (call.name === "scrollScreen") {
                        handleScroll(call, session, clientWs);
                      }
                    } else if (call.name === "createFile") {
                      handleCreateFile(call, session, clientWs);
                    } else if (call.name === "createFolder") {
                      handleCreateFolder(call, session, clientWs);
                    } else if (call.name === "searchWeb") {
                      handleSearchWeb(call, session, clientWs);
                    } else if (call.name === "rememberAppLocation") {
                      handleRememberAppLocation(call, session, clientWs);
                    } else if (call.name === "findFile") {
                      handleFindFile(call, session, clientWs);
                    } else if (call.name === "openFile") {
                      handleOpenFile(call, session, clientWs);
                    } else if (call.name === "delegateTask") {
                      handleDelegateTask(call, session, clientWs, ai);
                    } else if (call.name === "startPcAccess") {
                      handleStartPcAccess(call, session, clientWs);
                    } else if (call.name === "stopPcAccess") {
                      handleStopPcAccess(call, session, clientWs);
                    } else if (clientWs.readyState === WebSocket.OPEN) {
                      // Existing client-side tools (changeThemeColor,
                      // showVisualAction) — unchanged, still forwarded to the browser.
                      clientWs.send(JSON.stringify({
                        type: "toolCall",
                        id: call.id,
                        name: call.name,
                        args: call.args
                      }));
                    }
                  }
                }
              }

              // NEW: save the resumption handle whenever Gemini hands us one
              // (persisted to disk too, so it survives server restarts)
              if (message.sessionResumptionUpdate) {
                const update = message.sessionResumptionUpdate;
                if (update.resumable && update.newHandle) {
                  saveResumptionHandle(update.newHandle);
                  console.log("[SESSION RESUMPTION] Saved fresh handle for future reconnects");
                }
              }

              // NEW: Gemini warns us shortly before it force-disconnects.
              // Reconnect proactively so the gap is as small as possible.
              if (message.goAway) {
                console.log(`[GEMINI GOAWAY] Session ending in ~${message.goAway.timeLeft}. Reconnecting proactively...`);
                triggerReconnect(myGeneration);
              }
            } catch (err: any) {
              console.error("Error processing Gemini message:", err);
            }
          },
          onclose: (e: any) => {
            if (myGeneration !== sessionGeneration) return; // already replaced, ignore
            const reasonText = String(e?.reason || "");
            console.log(`Gemini Live session closed | code: ${e?.code} | reason: ${reasonText || "(none given)"}`);
            sessionReady = false;
            if (intentionalClose) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: "status", status: "closed" }));
              }
              return;
            }

            // Gemini's actual rejection signal for a bad/expired resumption
            // handle (confirmed from real logs: code 1008, "BidiGenerateContent
            // session not found") — this can fire before the connection ever
            // reaches the "successfully connected" line, so timing alone
            // isn't a reliable way to catch it. Check the real signal directly.
            const isStaleHandleRejection =
              usedHandleThisAttempt && (e?.code === 1008 || /session not found/i.test(reasonText));

            if (isStaleHandleRejection) {
              console.warn(
                `[SESSION RESUMPTION] Gemini rejected the saved handle (${reasonText || `code ${e?.code}`}). ` +
                `Clearing it and reconnecting fresh instead of retrying the same handle.`
              );
              clearResumptionHandle().then(() => triggerReconnect(myGeneration, true));
              return;
            }

            // Fallback: even without this exact wording, a session that used
            // a handle and died within a couple of seconds is still
            // suspicious — treat it the same way rather than burning retries.
            const lifetimeMs = connectedAt > 0 ? Date.now() - connectedAt : -1;
            if (usedHandleThisAttempt && lifetimeMs >= 0 && lifetimeMs < 3000) {
              console.warn(
                `[SESSION RESUMPTION] Session closed after only ${lifetimeMs}ms while resuming — ` +
                `clearing the handle just in case it's the cause.`
              );
              clearResumptionHandle().then(() => triggerReconnect(myGeneration, true));
              return;
            }

            // Gemini ended this on its own (time/token limits, network blip) —
            // reconnect automatically instead of going silent.
            triggerReconnect(myGeneration);
          },
          onerror: (err: any) => {
            if (myGeneration !== sessionGeneration) return;
            console.error("Gemini Live session error:", err);
            sessionReady = false;
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: "error",
                error: err?.message || "Live API connection error"
              }));
            }
            triggerReconnect(myGeneration);
          }
        }
      });

      if (myGeneration !== sessionGeneration) {
        // A newer reconnect already started while we were connecting — drop this one.
        try { session.close(); } catch (e) { /* ignore */ }
        return;
      }

      liveSession = session;
      sessionReady = true;
      connectedAt = Date.now();
      reconnectAttempts = 0;
      intentionalClose = false;

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "status", status: "connected" }));
      }
    } catch (err: any) {
      console.error("Failed to connect to Gemini Live session:", err);

      // The saved handle might be stale/expired — fall back to a fresh
      // session once before giving up.
      if (!forceFreshSession && handleToUse) {
        console.log("Retrying without the saved resumption handle...");
        await clearResumptionHandle();
        await connectGeminiLive(true);
        return;
      }

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: "error",
          error: err?.message || "Failed to establish Live session"
        }));
      }
      triggerReconnect(myGeneration);
    }
  }

  function triggerReconnect(fromGeneration: number, forceFresh: boolean = false) {
    if (fromGeneration !== sessionGeneration) return; // stale trigger, ignore
    if (reconnecting) return; // already reconnecting
    if (clientWs.readyState !== WebSocket.OPEN) return; // client is gone

    reconnecting = true;
    reconnectAttempts += 1;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error("Gave up reconnecting to Gemini Live after too many attempts");
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: "error",
          error: "Zoya baar-baar disconnect ho rahi hai. Please refresh karke dobara try karein."
        }));
      }
      reconnecting = false;
      return;
    }

    setTimeout(async () => {
      reconnecting = false;
      await connectGeminiLive(forceFresh);
    }, 500);
  }

  await connectGeminiLive();

  // Handle messages from Client WebSocket
  clientWs.on("message", (rawMessage) => {
    try {
      const dataObj = JSON.parse(rawMessage.toString());

      if (!liveSession || !sessionReady) {
        // Mid-reconnect — briefly drop this chunk instead of sending it into
        // a dead session (this window is normally well under a second).
        return;
      }

      if (dataObj.type === "audio" && dataObj.audio) {
        // High Priority Audio Input: Process immediately
        try {
          liveSession.sendRealtimeInput({
            audio: {
              data: dataObj.audio,
              mimeType: "audio/pcm;rate=16000"
            }
          });
          if (Math.random() < 0.04) {
            console.log(`[STAGE 5 GEMINI AUDIO IN] Success: true | Bytes Sent: ${dataObj.audio.length} base64 chars | Mime: audio/pcm;rate=16000`);
          }
        } catch (err: any) {
          console.error(`[STAGE 5 GEMINI AUDIO IN] Failure: true | Error: ${err.message || err}`);
        }
      } else if (dataObj.type === "image" && dataObj.image) {
        // Vision Frame Input: Send as video frame (BlobImageUnion)
        try {
          // FIX (PC-wide click/scroll control): remember this frame's
          // resolution info (if the client sent it — see ScreenSharer.ts)
          // so a later clickAt call knows how to scale Gemini's coordinates
          // up to real screen pixels.
          const meta = dataObj.metadata;
          if (
            meta &&
            typeof meta.originalWidth === "number" &&
            typeof meta.originalHeight === "number" &&
            typeof meta.scaledWidth === "number" &&
            typeof meta.scaledHeight === "number"
          ) {
            latestFrameResolution = {
              originalWidth: meta.originalWidth,
              originalHeight: meta.originalHeight,
              scaledWidth: meta.scaledWidth,
              scaledHeight: meta.scaledHeight,
            };
          }

          liveSession.sendRealtimeInput({
            video: {
              data: dataObj.image,
              mimeType: dataObj.mimeType || "image/jpeg"
            }
          });
          if (Math.random() < 0.04) {
            console.log(`[STAGE 5 GEMINI VISION IN] Bytes Sent: ${dataObj.image.length} base64 chars | Mime: ${dataObj.mimeType || "image/jpeg"}`);
          }
        } catch (err: any) {
          console.error(`[STAGE 5 GEMINI VISION IN] Failure: true | Error: ${err.message || err}`);
        }
      } else if (dataObj.type === "text" && dataObj.text) {
        liveSession.sendRealtimeInput({
          text: dataObj.text
        });
      } else if (dataObj.type === "toolResponse") {
        console.log("Sending toolResponse back to Gemini Live:", dataObj.name, dataObj.id);
        liveSession.sendToolResponse({
          functionResponses: [
            {
              id: dataObj.id,
              name: dataObj.name,
              response: dataObj.response || { result: "ok" }
            }
          ]
        });
      } else if (dataObj.type === "toolConfirmation") {
        // FIX (confirm-before-act, multi-tier): the user answered a
        // confirmRequired prompt from the client. dataObj: { id, approved }.
        const pending = pendingConfirmations.get(dataObj.id);

        if (!pending) {
          console.warn(`[TOOL CONFIRM] No pending call for id: ${dataObj.id} (already resolved, or the server restarted)`);
          return;
        }

        const call = { id: dataObj.id, name: pending.name, args: pending.args };

        if (!dataObj.approved) {
          pendingConfirmations.delete(dataObj.id);
          console.log(`[TOOL CONFIRM] User denied:`, pending.name, pending.args);
          liveSession.sendRealtimeInput({
            text: `(System note: the user declined this action, so it was NOT performed. Acknowledge that naturally, briefly.)`
          });
          notifyClient(clientWs, call, `Okay, skipped that`);
          return;
        }

        pending.approvals += 1;
        console.log(`[TOOL CONFIRM] Approval ${pending.approvals}/${pending.required} for:`, pending.name, pending.args);

        if (pending.approvals < pending.required) {
          // Still short of the required count — ask again instead of
          // running it. The client should show this as "confirm again"
          // (approvalsSoFar tells it how far along the user is).
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: "confirmRequired",
              id: dataObj.id,
              name: pending.name,
              args: pending.args,
              summary: describeToolCall(pending.name, pending.args),
              approvalsNeeded: pending.required,
              approvalsSoFar: pending.approvals
            }));
          }
          return;
        }

        // Got every approval it needed — actually run it now.
        pendingConfirmations.delete(dataObj.id);
        console.log(`[TOOL CONFIRM] Fully approved (${pending.approvals}/${pending.required}), running:`, pending.name, pending.args);
        if (pending.name === "openWebsite") {
          handleOpenWebsite(call, liveSession, clientWs);
        } else if (pending.name === "openApplication") {
          handleOpenApplication(call, liveSession, clientWs);
        } else if (pending.name === "clickAt") {
          handleClickAt(call, liveSession, clientWs);
        } else if (pending.name === "typeText") {
          handleTypeText(call, liveSession, clientWs);
        } else if (pending.name === "scrollScreen") {
          handleScroll(call, liveSession, clientWs);
        }
      }
    } catch (e: any) {
      console.error("Error processing client WS message:", e);
    }
  });

  clientWs.on("close", () => {
    console.log("Client WS disconnected");
    intentionalClose = true;
    sessionGeneration++; // invalidate any in-flight reconnect for this client
    if (liveSession) {
      try {
        liveSession.close();
      } catch (e) {
        // ignore
      }
    }
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();