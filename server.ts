import express from "express";
import http from "http";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality, Type, Session } from "@google/genai";
import { createServer as createViteServer } from "vite";

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

const execAsync = promisify(exec);

function openInSystemBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "win32" ? `start "" "${url}"` :
    platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  // Fire-and-forget is fine here — searchWeb/openWebsite already validate
  // the URL first, and a browser is essentially always launchable.
  return execAsync(cmd).then(() => {});
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
    await openInSystemBrowser(url);
    console.log(`[SEARCH WEB] Opened: ${url}`);
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

async function handleOpenWebsite(call: any, session: Session, clientWs: WebSocket) {
  const url = String(call.args?.url || "");
  const siteName = call.args?.siteName ? String(call.args.siteName) : url;

  if (!isSafeUrl(url)) {
    console.warn(`[OPEN WEBSITE] Rejected unsafe/invalid URL: "${url}"`);
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: "Invalid URL" } }]
    });
    notifyClient(clientWs, call, `Couldn't open that link`);
    return;
  }

  try {
    await openInSystemBrowser(url);
    console.log(`[OPEN WEBSITE] Opened: ${url}`);
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: { result: "ok", url, siteName }
      }]
    });
    notifyClient(clientWs, call, `Opened ${siteName}`);
  } catch (err: any) {
    console.error(`[OPEN WEBSITE] Failed:`, err);
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: `Could not open ${siteName}` } }]
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

  if (!isSafeAppName(appName)) {
    console.warn(`[OPEN APP] Rejected invalid app name: "${appName}"`);
    session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response: { result: "error", message: "Invalid app name" } }]
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
      session.sendToolResponse({
        functionResponses: [{ id: call.id, name: call.name, response: { result: "ok", appName } }]
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
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: { result: "ok", appName }
      }]
    });
    notifyClient(clientWs, call, `Opening ${appName}`);
  } catch (err: any) {
    // 3) Genuinely can't find it — this is the honest, common case for
    // software that isn't on PATH. Ask to be taught the exact path once.
    console.error(`[OPEN APP] Failed to launch '${appName}':`, err?.message || err);
    session.sendToolResponse({
      functionResponses: [{
        id: call.id,
        name: call.name,
        response: {
          result: "error",
          message: `Could not find "${appName}" by name — it isn't on PATH. Ask the user for the exact .exe file location (e.g. by right-clicking its shortcut → Properties → Target), then call rememberAppLocation with that exact path so it opens instantly every time after this.`
        }
      }]
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
                    console.log(`[STAGE 5 GEMINI AUDIO OUT] Success: true | Packet #${geminiAudioCount} | Bytes Received from Gemini: ${part.inlineData.data.length} | Client WS State: ${clientWs.readyState}`);
                    if (clientWs.readyState === WebSocket.OPEN) {
                      clientWs.send(JSON.stringify({
                        type: "audio",
                        audio: part.inlineData.data
                      }));
                    }
                  }
                  if (part.text) {
                    console.log(`[GEMINI TEXT RECEIVED] Text chunk received from Gemini: "${part.text}"`);
                    console.log(`[Server] Forwarding text: "${part.text}" (Client WS State: ${clientWs.readyState})`);
                    if (clientWs.readyState === WebSocket.OPEN) {
                      clientWs.send(JSON.stringify({
                        type: "text",
                        text: part.text
                      }));
                      console.log(`[WebSocket] Sending text: "${part.text}"`);
                    }
                  }
                }
              }

              // Handle Output Audio Transcription (Zoya's spoken output converted to text)
              const outputTranscriptionText = (message.serverContent as any)?.outputTranscription?.text;
              if (outputTranscriptionText) {
                console.log(`[GEMINI TRANSCRIPTION RECEIVED] Zoya spoken output transcription: "${outputTranscriptionText}"`);
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    type: "text",
                    text: outputTranscriptionText
                  }));
                }
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

                    if (call.name === "createFile") {
                      handleCreateFile(call, session, clientWs);
                    } else if (call.name === "createFolder") {
                      handleCreateFolder(call, session, clientWs);
                    } else if (call.name === "searchWeb") {
                      handleSearchWeb(call, session, clientWs);
                    } else if (call.name === "openWebsite") {
                      handleOpenWebsite(call, session, clientWs);
                    } else if (call.name === "openApplication") {
                      handleOpenApplication(call, session, clientWs);
                    } else if (call.name === "rememberAppLocation") {
                      handleRememberAppLocation(call, session, clientWs);
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
          liveSession.sendRealtimeInput({
            video: {
              data: dataObj.image,
              mimeType: dataObj.mimeType || "image/jpeg"
            }
          });
          console.log(`[STAGE 5 GEMINI VISION IN] Success: true | Bytes Sent: ${dataObj.image.length} base64 chars | Mime: ${dataObj.mimeType || "image/jpeg"}`);
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