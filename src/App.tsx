import React, { useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  Monitor,
  Power,
  Send,
  Copy,
  Check,
  Volume2,
  X,
  AlertCircle,
  ShieldAlert,
  Plus,
  FileText,
  Eye,
  Download,
} from "lucide-react";

import {
  SessionState,
  ZoyaConfig,
  ZoyaMood,
  ToolCallEvent,
  TranscriptItem,
  ConfirmRequiredEvent,
  ChatAttachment,
  WorkspaceFile,
  WorkspaceFileReadResult,
} from "./types";

import { LiveSession } from "./services/LiveSession";

import zoyaAvatar from "./assets/zoya-avatar.jpg";

import "./zoya-ui.css";

// FIX (voice allow/deny): word lists checked against a user speech chunk
// while a confirmation popup is pending. Kept loose/casual (Hinglish
// included) rather than exact phrases, since this is spoken conversation,
// not typed commands. \b word boundaries stop "allow" from matching inside
// an unrelated longer word.
//
// FIX (voice allow not triggering on full sentences): the original deny/
// allow lists only matched "kar do" as two separate words (or "kardo"
// joined), but NOT "karo" -- a different, extremely common inflection of
// the same verb. "play karo", "video play karo", "chalu karo" all use
// "karo", not "kar do", so a whole natural sentence like "video play karo"
// was silently failing to match at all. Widened to alternation covering
// the actual range of ways someone says yes/no in Hindi/Hinglish, so a
// bare "haan", a short "haan karo", and a full "video play karo" all match
// the same way.
const CONFIRM_ALLOW_WORDS =
  /\b(allow|confirm|yes|yeah|yep|sure|ok|okay|haan|haa|kar\s*do|karo|kardo|chalu\s*karo|chalao|chala\s*do|play\s*karo)\b/i;

const CONFIRM_DENY_WORDS =
  /\b(deny|denied|cancel|no|nope|nahi|mat\s*karo|matt\s*karo|rehne\s*do|ruk\s*jao|band\s*karo|rok\s*do)\b/i;

/**
 * Checks a single speech chunk for an allow/deny voice command.
 * Returns true (allow), false (deny), or null (no match / ambiguous).
 *
 * FIX (a spoken "mat karo" / "cancel kar do" was flipping to ALLOW): the
 * ALLOW list includes bare "karo"/"kar do" so full sentences like "video
 * play karo" match — but "karo"/"kar do" are also the tail end of common
 * DENY phrases ("mat karo", "cancel kar do", "band karo", "rok do"). The
 * old logic picked whichever match sat later in the text, so in "mat
 * karo" the ALLOW-list "karo" (sitting after "mat") beat the DENY-list
 * "mat karo", silently approving an action the user was trying to
 * decline. DENY is now checked FIRST and wins outright whenever any deny
 * phrase is present at all — position no longer matters for that case.
 * ALLOW is only checked when no deny phrase is found, which still covers
 * "haan", "allow", and full sentences like "video play karo" normally
 * (none of those contain a deny word to begin with).
 */
function matchConfirmationVoiceCommand(
  text: string
): boolean | null {
  const denyMatch = [...text.matchAll(
    new RegExp(CONFIRM_DENY_WORDS, "gi")
  )].pop();

  if (denyMatch) {
    return false;
  }

  const allowMatch = [...text.matchAll(
    new RegExp(CONFIRM_ALLOW_WORDS, "gi")
  )].pop();

  if (allowMatch) {
    return true;
  }

  return null;
}

export default function App() {
  const [sessionState, setSessionState] =
    useState<SessionState>("disconnected");

  const [isMuted, setIsMuted] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0);

  const [mood, setMood] = useState<ZoyaMood>("Sassy");

  const [toolEvent, setToolEvent] =
    useState<ToolCallEvent | null>(null);

  // FIX (confirm-before-act popup): the gated tool call currently waiting on
  // an Allow/Deny answer, if any. Only one shown at a time — if a second
  // confirmRequired arrives before this one is answered, it replaces this
  // (the server still remembers the first one; it just won't be on screen).
  const [pendingConfirmation, setPendingConfirmation] =
    useState<ConfirmRequiredEvent | null>(null);

  // FIX (voice allow/deny): mirrors pendingConfirmation so the
  // onTextReceived callback below — created once when the session is set up
  // — can always read the *current* pending confirmation instead of the
  // stale null it would see if it captured the state value directly.
  const pendingConfirmationRef =
    useRef<ConfirmRequiredEvent | null>(null);

  useEffect(() => {
    pendingConfirmationRef.current = pendingConfirmation;
  }, [pendingConfirmation]);

  const [transcripts, setTranscripts] =
    useState<TranscriptItem[]>([]);

  const [errorMessage, setErrorMessage] =
    useState<string | null>(null);

  const [workspaceViewer, setWorkspaceViewer] = useState<{
    file: WorkspaceFile;
    status: "loading" | "ready" | "unavailable" | "error";
    result?: WorkspaceFileReadResult;
    error?: string;
  } | null>(null);

  const [config, setConfig] = useState<ZoyaConfig>({
    voice: "Kore",
    enableTranscripts: true,
    theme: "neon-pink",
  });

  const sessionRef = useRef<LiveSession | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  const moods: ZoyaMood[] = [
    "Sassy",
    "Flirty",
    "Teasing",
    "Playful",
    "Smart",
    "Charming",
  ];

  const themeColors: Record<
    ZoyaConfig["theme"],
    string
  > = {
    "neon-pink": "#ec4899",
    "cyber-purple": "#8b5cf6",
    "emerald-glow": "#10b981",
    "sunset-amber": "#f59e0b",
    "midnight-blue": "#3b82f6",
  };

  const currentThemeColor =
    themeColors[config.theme] || "#ec4899";

  const isConnected =
    sessionState !== "disconnected" &&
    sessionState !== "error";

  /*
   * ---------------------------------------------------------
   * LIVE SESSION
   * ---------------------------------------------------------
   */

  useEffect(() => {
    const session = new LiveSession(
      {
        onStateChange: (newState) => {
          setSessionState(newState);

          if (newState === "speaking") {
            const randomMood =
              moods[Math.floor(Math.random() * moods.length)];

            setMood(randomMood);
          }

          if (
            newState === "disconnected" ||
            newState === "error"
          ) {
            setIsScreenSharing(false);
          }
        },

        onVolumeChange: (volume) => {
          setAudioVolume(volume);
        },

        onTextReceived: (text, isUser) => {
          if (!text || !text.trim()) {
            return;
          }

          // FIX (voice allow/deny): while a confirmation popup is on
          // screen, let the user answer it by voice instead of only by
          // clicking. Checked on every user speech chunk (Gemini streams
          // transcripts in pieces), so short words like "allow" or "haan"
          // are almost always caught in the chunk they arrive in. Uses the
          // ref (not the pendingConfirmation state) because this whole
          // callback object is created once on mount and would otherwise
          // only ever see the initial null value.
          if (isUser && pendingConfirmationRef.current) {
            // DEBUG (voice allow not firing): logs every user speech chunk
            // that arrives while a confirmation is pending, and whether it
            // matched allow/deny. If this never logs at all while testing,
            // user speech isn't reaching onTextReceived as isUser:true
            // during the confirmation wait (a mic/transcription issue, not
            // a matching-logic issue). If it logs but "matched: null" every
            // time, the transcript text itself isn't hitting the regex —
            // paste what it prints so the word list can be widened further.
            console.log('[VOICE CONFIRM DEBUG] chunk while pending:', JSON.stringify(text), '| matched:', matchConfirmationVoiceCommand(text));

            const matchedApproval =
              matchConfirmationVoiceCommand(text);

            if (matchedApproval !== null) {
              const confirmationId =
                pendingConfirmationRef.current.id;

              sessionRef.current?.respondToConfirmation(
                confirmationId,
                matchedApproval
              );

              pendingConfirmationRef.current = null;
              setPendingConfirmation(null);

              // Still show what the user said in the transcript below,
              // same as any other utterance — just don't also treat it
              // as a fresh message for Gemini to respond to in words,
              // since respondToConfirmation already told the server.
            }
          }

          setTranscripts((previous) => {
            const now = Date.now();

            /*
             * Gemini sometimes sends the same assistant
             * response in multiple chunks.
             *
             * Join recent Aanya chunks together.
             */

            if (
              !isUser &&
              previous.length > 0 &&
              previous[previous.length - 1].sender ===
                "zoya" &&
              now -
                previous[previous.length - 1].timestamp <
                10000
            ) {
              const updated = [...previous];

              const last =
                updated[updated.length - 1];

              updated[updated.length - 1] = {
                ...last,
                text: last.text + text,
              };

              return updated;
            }

            return [
              ...previous,
              {
                id: `${now}-${Math.random()}`,
                sender: isUser
                  ? "user"
                  : "zoya",
                text,
                timestamp: now,
              },
            ];
          });
        },

        onToolCall: (event) => {
          setToolEvent(event);

          if (
            event.name === "changeThemeColor" &&
            event.args?.theme
          ) {
            const validThemes: ZoyaConfig["theme"][] = [
              "neon-pink",
              "cyber-purple",
              "emerald-glow",
              "sunset-amber",
              "midnight-blue",
            ];

            if (
              validThemes.includes(
                event.args.theme
              )
            ) {
              setConfig((previous) => ({
                ...previous,
                theme: event.args.theme,
              }));
            }
          }
        },

        onConfirmRequired: (event) => {
          // Set the ref synchronously here (not just via the
          // pendingConfirmation useEffect below) so a voice-allow spoken
          // right as the popup appears is never missed to a state-update
          // timing race — see the FIX note above onTextReceived.
          pendingConfirmationRef.current = event;
          setPendingConfirmation(event);
        },

        onError: (error) => {
          setErrorMessage(error);
        },

        onScreenShareChange: (sharing) => {
          setIsScreenSharing(sharing);
        },
        onAttachmentStatus: () => {
          // ChatInput owns its attachment state. Server status is reflected
          // in the transcript/tool notification rather than duplicated here.
        },
        onFileCreated: (file) => {
          setTranscripts((previous) => [
            ...previous,
            {
              id: `file-${Date.now()}-${Math.random()}`,
              sender: "system",
              text: `${file.name} is ready in the workspace.`,
              timestamp: Date.now(),
              filePath: file.path,
              fileKind: file.kind,
              fileName: file.name,
              fileSize: file.size,
            },
          ]);
        },
      },
      config.voice
    );

    sessionRef.current = session;

    return () => {
      session.destroy();
      sessionRef.current = null;
    };
  }, []);

  /*
   * ---------------------------------------------------------
   * VOICE CHANGE
   * ---------------------------------------------------------
   */

  useEffect(() => {
    if (sessionRef.current) {
      sessionRef.current.setVoice(config.voice);
    }
  }, [config.voice]);

  /*
   * ---------------------------------------------------------
   * AUTO SCROLL CHAT
   * ---------------------------------------------------------
   * Keeps the messages panel pinned to the latest message
   * whenever a new one arrives, or an existing Aanya message
   * grows (streamed chunks get appended to the last item).
   */

  useEffect(() => {
    const container = messagesContainerRef.current;

    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [transcripts]);

  /*
   * ---------------------------------------------------------
   * CONNECT / DISCONNECT
   * ---------------------------------------------------------
   */

  const handleToggleConnect = async () => {
    setErrorMessage(null);

    if (!sessionRef.current) {
      return;
    }

    try {
      if (
        sessionState === "disconnected" ||
        sessionState === "error"
      ) {
        await sessionRef.current.connect();
      } else {
        sessionRef.current.disconnect();
      }
    } catch (error) {
      console.error(error);

      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to connect to Aanya."
      );
    }
  };

  /*
   * ---------------------------------------------------------
   * MUTE
   * ---------------------------------------------------------
   */

  const handleToggleMute = () => {
    const nextMuted = !isMuted;

    setIsMuted(nextMuted);

    if (sessionRef.current) {
      sessionRef.current.setMuted(nextMuted);
    }
  };

  /*
   * ---------------------------------------------------------
   * SCREEN SHARE
   * ---------------------------------------------------------
   */

  const handleToggleScreenShare = async () => {
    if (!sessionRef.current) {
      return;
    }

    setErrorMessage(null);

    try {
      const active =
        await sessionRef.current.toggleScreenShare();

      setIsScreenSharing(active);
    } catch (error) {
      console.error(error);

      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Screen sharing could not be started."
      );
    }
  };

  /*
   * ---------------------------------------------------------
   * TEXT MESSAGE
   * ---------------------------------------------------------
   */

  const handleSendMessage = (text: string, attachments: ChatAttachment[]) => {
    const message = text.trim();

    if (!message && attachments.length === 0) {
      return;
    }

    if (!sessionRef.current) {
      return;
    }

    /*
     * Keep the manually typed message visible
     * immediately in the chat.
     *
     * If LiveSession also reports the user transcript,
     * duplicate protection below prevents unnecessary
     * repeated messages in normal usage.
     */

    setTranscripts((previous) => [
      ...previous,
      {
        id: `${Date.now()}-${Math.random()}`,
        sender: "user",
        text: message || `Attached: ${attachments.map((attachment) => attachment.name).join(', ')}`,
        timestamp: Date.now(),
      },
    ]);

    sessionRef.current.sendTextMessage(message || "Please analyze the attached file.", attachments.map((attachment) => attachment.id));
  };

  /*
   * ---------------------------------------------------------
   * COPY MESSAGE
   * ---------------------------------------------------------
   */

  const handleCopyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error(
        "Unable to copy message:",
        error
      );
    }
  };

  const handleViewWorkspaceFile = async (file: WorkspaceFile) => {
    setWorkspaceViewer({ file, status: "loading" });
    try {
      const result = await sessionRef.current?.readWorkspaceFile(file, "view");
      if (!result) throw new Error("Aanya is not connected.");
      setWorkspaceViewer({
        file,
        status: result.previewAvailable ? "ready" : "unavailable",
        result,
      });
    } catch (error) {
      setWorkspaceViewer({
        file,
        status: "error",
        error: error instanceof Error ? error.message : "Unable to open this file.",
      });
    }
  };

  const handleDownloadWorkspaceFile = async (file: WorkspaceFile) => {
    try {
      const result = await sessionRef.current?.readWorkspaceFile(file, "download");
      if (!result?.data) throw new Error(result?.error || "Unable to download this file.");
      const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to download this file.");
    }
  };

  /*
   * ---------------------------------------------------------
   * CONFIRMATION (allow / deny a gated tool call)
   * ---------------------------------------------------------
   */

  const handleConfirmationResponse = (approved: boolean) => {
    if (!pendingConfirmation || !sessionRef.current) {
      return;
    }

    sessionRef.current.respondToConfirmation(
      pendingConfirmation.id,
      approved
    );

    // If more approvals were still needed, the server will send another
    // confirmRequired shortly and this will be set again — clearing it now
    // just closes the current card instead of leaving it stuck on stale counts.
    setPendingConfirmation(null);
  };

  /*
   * ---------------------------------------------------------
   * CLEAR ERROR
   * ---------------------------------------------------------
   */

  const clearError = () => {
    setErrorMessage(null);
  };

  /*
   * ---------------------------------------------------------
   * RENDER
   * ---------------------------------------------------------
   */

  return (
    <div
      className="zoya-screen"
      style={
        {
          "--zoya-theme": currentThemeColor,
        } as React.CSSProperties
      }
    >
      {/* ---------------------------------------------------
          TOP BAR
      --------------------------------------------------- */}

      <header className="zoya-topbar">
        <div className="zoya-logo">
          AANYA
        </div>

        <div className="zoya-status">
          <span
            className={
              isConnected
                ? "zoya-status-dot online"
                : "zoya-status-dot"
            }
          />

          {isConnected
            ? sessionState === "speaking"
              ? "SPEAKING"
              : "ONLINE"
            : "OFFLINE"}
        </div>
      </header>

      {/* ---------------------------------------------------
          ERROR
      --------------------------------------------------- */}

      {errorMessage && (
        <div className="zoya-error">
          <AlertCircle size={17} />

          <span>{errorMessage}</span>

          <button
            type="button"
            onClick={clearError}
            aria-label="Close error"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* ---------------------------------------------------
          MAIN AREA
      --------------------------------------------------- */}

      <main className="zoya-main">
        {/* =================================================
            LEFT / MAIN AANYA AREA
        ================================================= */}

        <section className="zoya-visual">
          <div className="zoya-picture-frame">
            <img
              src={zoyaAvatar}
              alt="Aanya"
              className="zoya-main-image"
            />

            <div className="zoya-image-overlay" />

            {/* ---------------------------------------------
                VOICE STATUS
            --------------------------------------------- */}

            <div className="zoya-speaking-status">
              <div
                className={
                  sessionState === "speaking"
                    ? "zoya-wave"
                    : "zoya-wave idle"
                }
              >
                {Array.from({
                  length: 17,
                }).map((_, index) => (
                  <span
                    key={index}
                    style={{
                      height:
                        sessionState === "speaking"
                          ? `${12 + Math.random() * 22}px`
                          : "8px",
                    }}
                  />
                ))}
              </div>

              <div className="zoya-listening-text">
                {!isConnected
                  ? "Tap power to start"
                  : sessionState === "speaking"
                    ? "Aanya is speaking"
                    : isMuted
                      ? "Microphone muted"
                      : "Listening"}
              </div>
            </div>

            {/* ---------------------------------------------
                THREE MAIN BUTTONS
            --------------------------------------------- */}

            <div className="zoya-controls">
              {/* MIC */}

              <button
                type="button"
                className={
                  isMuted
                    ? "zoya-control muted"
                    : "zoya-control"
                }
                onClick={handleToggleMute}
                title={
                  isMuted
                    ? "Unmute microphone"
                    : "Mute microphone"
                }
              >
                {isMuted ? (
                  <MicOff size={21} />
                ) : (
                  <Mic size={21} />
                )}

                <span>
                  {isMuted ? "MUTED" : "MIC"}
                </span>
              </button>

              {/* POWER */}

              <button
                type="button"
                className={
                  isConnected
                    ? "zoya-power active"
                    : "zoya-power"
                }
                onClick={handleToggleConnect}
                title={
                  isConnected
                    ? "Disconnect Aanya"
                    : "Start Aanya"
                }
              >
                <Power size={30} />
              </button>

              {/* SCREEN SHARE */}

              <button
                type="button"
                className={
                  isScreenSharing
                    ? "zoya-control screen-active"
                    : "zoya-control"
                }
                onClick={handleToggleScreenShare}
                title={
                  isScreenSharing
                    ? "Stop screen sharing"
                    : "Share screen"
                }
              >
                <Monitor size={21} />

                <span>
                  {isScreenSharing
                    ? "SHARING"
                    : "SCREEN"}
                </span>
              </button>
            </div>
          </div>
        </section>

        {/* =================================================
            RIGHT CHAT PANEL
        ================================================= */}

        <aside className="zoya-chat">
          {/* ---------------------------------------------
              CHAT HEADER
          --------------------------------------------- */}

          <div className="zoya-chat-header">
            <div className="zoya-chat-avatar">
              <img
                src={zoyaAvatar}
                alt="Aanya"
              />
            </div>

            <div>
              <div className="zoya-chat-name">
                Aanya
              </div>

              <div className="zoya-chat-state">
                <span
                  className={
                    isConnected
                      ? "zoya-online-dot"
                      : "zoya-offline-dot"
                  }
                />

                {isConnected
                  ? "Connected"
                  : "Not connected"}
              </div>
            </div>
          </div>

          {/* ---------------------------------------------
              MESSAGES
          --------------------------------------------- */}

          <div
            className="zoya-messages"
            ref={messagesContainerRef}
          >
            {transcripts.length === 0 ? (
              <div className="zoya-empty-chat">
                <div className="zoya-empty-icon">
                  <Volume2 size={28} />
                </div>

                <div>
                  Conversation will appear here.
                </div>

                <small>
                  You can speak with Aanya or type
                  a message below.
                </small>
              </div>
            ) : (
              transcripts.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  avatar={zoyaAvatar}
                  onCopy={handleCopyMessage}
                  onViewFile={handleViewWorkspaceFile}
                  onDownloadFile={handleDownloadWorkspaceFile}
                />
              ))
            )}
          </div>

          {/* ---------------------------------------------
              TEXT INPUT
          --------------------------------------------- */}

          <ChatInput
            disabled={!isConnected}
            onSend={handleSendMessage}
            onUpload={(attachment, data) => sessionRef.current?.uploadAttachment(attachment, data)}
          />
        </aside>
      </main>

      {workspaceViewer && (
        <WorkspaceViewer
          viewer={workspaceViewer}
          onClose={() => setWorkspaceViewer(null)}
          onDownload={handleDownloadWorkspaceFile}
        />
      )}

      {/* ---------------------------------------------------
          TOOL EVENT
      --------------------------------------------------- */}

      {toolEvent && (
        <div
          style={{
            position: "fixed",
            top: "82px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 90,
            padding: "9px 15px",
            borderRadius: "12px",
            background:
              "rgba(15,15,22,0.94)",
            border:
              "1px solid rgba(255,255,255,0.08)",
            color: "#cbd5e1",
            fontSize: "11px",
            backdropFilter: "blur(15px)",
          }}
        >
          {toolEvent.name}

          <button
            type="button"
            onClick={() => setToolEvent(null)}
            style={{
              marginLeft: "10px",
              border: 0,
              background: "transparent",
              color: "#64748b",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* ---------------------------------------------------
          CONFIRMATION POPUP (allow / deny a risky action)
      --------------------------------------------------- */}

      {pendingConfirmation && (
        <div className="zoya-confirm-overlay">
          <div className="zoya-confirm-modal">
            <div className="zoya-confirm-icon">
              <ShieldAlert size={22} />
            </div>

            <div className="zoya-confirm-title">
              {pendingConfirmation.summary}
            </div>

            <div className="zoya-confirm-subtext">
              Aanya is asking permission before doing this.
            </div>

            {pendingConfirmation.approvalsNeeded > 1 && (
              <div className="zoya-confirm-progress">
                Confirmed {pendingConfirmation.approvalsSoFar} of{" "}
                {pendingConfirmation.approvalsNeeded} times —
                confirm again to continue
              </div>
            )}

            <div className="zoya-confirm-actions">
              <button
                type="button"
                className="zoya-confirm-deny"
                onClick={() =>
                  handleConfirmationResponse(false)
                }
              >
                Deny
              </button>

              <button
                type="button"
                className="zoya-confirm-allow"
                onClick={() =>
                  handleConfirmationResponse(true)
                }
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* =========================================================
   CHAT MESSAGE
   ========================================================= */

interface ChatMessageProps {
  message: TranscriptItem;
  avatar: string;
  onCopy: (text: string) => void;
  onViewFile: (file: WorkspaceFile) => void;
  onDownloadFile: (file: WorkspaceFile) => void;
}

function ChatMessage({
  message,
  avatar,
  onCopy,
  onViewFile,
  onDownloadFile,
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);

  const isUser =
    message.sender === "user";

  const handleCopy = async () => {
    await onCopy(message.text);

    setCopied(true);

    setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  const time = new Date(
    message.timestamp
  ).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className={
        isUser
          ? "zoya-message-row user"
          : "zoya-message-row zoya"
      }
    >
      {!isUser && (
        <div className="zoya-small-avatar">
          <img
            src={avatar}
            alt="Aanya"
          />
        </div>
      )}

      <div className="zoya-message-wrapper">
        <div className="zoya-message">
          <MessageContent
            text={message.text}
            onCopy={onCopy}
          />
        </div>

        {message.filePath && message.fileKind === "file" && (
          <WorkspaceFileCard
            file={{ name: message.fileName || "Workspace file", path: message.filePath, kind: "file", size: message.fileSize }}
            onView={onViewFile}
            onDownload={onDownloadFile}
          />
        )}

        <div className="zoya-message-meta">
          <span>{time}</span>

          <button
            type="button"
            onClick={handleCopy}
            title="Copy message"
          >
            {copied ? (
              <Check size={13} />
            ) : (
              <Copy size={13} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceFileCard({
  file,
  onView,
  onDownload,
}: {
  file: WorkspaceFile;
  onView: (file: WorkspaceFile) => void;
  onDownload: (file: WorkspaceFile) => void;
}) {
  return (
    <div className="zoya-file-card">
      <FileText size={18} />
      <div className="zoya-file-card-info">
        <strong>{file.name}</strong>
        <small>{fileDetails(file)}</small>
      </div>
      <div className="zoya-file-card-actions">
        <button type="button" onClick={() => onView(file)} aria-label={`View or read ${file.name}`}>
          <Eye size={13} /> View / Read
        </button>
        <button type="button" onClick={() => onDownload(file)} aria-label={`Download ${file.name}`}>
          <Download size={13} /> Download
        </button>
      </div>
    </div>
  );
}

function fileDetails(file: WorkspaceFile) {
  const extension = file.name.includes(".") ? file.name.split(".").pop()?.toUpperCase() : "FILE";
  const size = typeof file.size === "number" ? ` · ${file.size < 1024 ? `${file.size} B` : `${Math.ceil(file.size / 1024)} KB`}` : "";
  return `${extension || "FILE"}${size} · Workspace file`;
}

function WorkspaceViewer({
  viewer,
  onClose,
  onDownload,
}: {
  viewer: {
    file: WorkspaceFile;
    status: "loading" | "ready" | "unavailable" | "error";
    result?: WorkspaceFileReadResult;
    error?: string;
  };
  onClose: () => void;
  onDownload: (file: WorkspaceFile) => void;
}) {
  return (
    <div className="zoya-workspace-overlay" role="dialog" aria-modal="true" aria-label={`Read ${viewer.file.name}`}>
      <section className="zoya-workspace-viewer">
        <header>
          <div><FileText size={17} /><span>{viewer.file.name}</span></div>
          <button type="button" onClick={onClose} aria-label="Close file viewer"><X size={17} /></button>
        </header>
        <div className="zoya-workspace-content">
          {viewer.status === "loading" && <p>Loading latest saved file…</p>}
          {viewer.status === "ready" && <pre><code>{viewer.result?.content}</code></pre>}
          {viewer.status === "unavailable" && <p>Preview unavailable for this binary or large file. You can still download the actual file.</p>}
          {viewer.status === "error" && <p>{viewer.error || "Unable to open this file."}</p>}
        </div>
        <footer>
          <span>{viewer.result ? `${Math.ceil(viewer.result.size / 1024)} KB` : ""}</span>
          <button type="button" onClick={() => onDownload(viewer.file)}><Download size={14} /> Download</button>
        </footer>
      </section>
    </div>
  );
}


/* =========================================================
   MESSAGE CONTENT
   ---------------------------------------------------------
   FIX (code should show as text in chat): splits a message on
   ```fenced``` code blocks and renders those as proper code
   blocks (monospace, own copy button) instead of everything
   being squashed into one plain paragraph. Runs on the FULL
   joined message text on every render, so it doesn't matter
   that Gemini's text arrives in streamed chunks — a fence
   split across chunks still parses correctly once joined.
   ========================================================= */

interface MessageContentProps {
  text: string;
  onCopy: (text: string) => void;
}

function MessageContent({
  text,
  onCopy,
}: MessageContentProps) {
  const parts = splitCodeBlocks(text);

  return (
    <>
      {parts.map((part, index) =>
        part.type === "code" ? (
          <CodeBlock
            key={index}
            language={part.language}
            code={part.content}
            onCopy={onCopy}
          />
        ) : (
          <div
            key={index}
            className="zoya-message-text"
          >
            {part.content}
          </div>
        )
      )}
    </>
  );
}

type MessagePart =
  | { type: "text"; content: string }
  | { type: "code"; language: string; content: string };

function splitCodeBlocks(text: string): MessagePart[] {
  const fenceRegex = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g;
  const result: MessagePart[] = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
      });
    }

    result.push({
      type: "code",
      language: match[1] || "",
      content: match[2].replace(/\n$/, ""),
    });

    lastIndex = fenceRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    result.push({
      type: "text",
      content: text.slice(lastIndex),
    });
  }

  if (result.length === 0) {
    result.push({ type: "text", content: text });
  }

  return result;
}


/* =========================================================
   CODE BLOCK
   ========================================================= */

interface CodeBlockProps {
  language: string;
  code: string;
  onCopy: (text: string) => void;
}

function CodeBlock({
  language,
  code,
  onCopy,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await onCopy(code);

    setCopied(true);

    setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  return (
    <div className="zoya-code-block">
      <div className="zoya-code-header">
        <span className="zoya-code-lang">
          {language || "code"}
        </span>

        <button
          type="button"
          onClick={handleCopy}
          title="Copy code"
        >
          {copied ? (
            <Check size={12} />
          ) : (
            <Copy size={12} />
          )}
        </button>
      </div>

      <pre className="zoya-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}


/* =========================================================
   CHAT INPUT
   ========================================================= */

interface ChatInputProps {
  disabled: boolean;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onUpload: (attachment: ChatAttachment, data: string) => void;
}

function ChatInput({
  disabled,
  onSend,
  onUpload,
}: ChatInputProps) {
  const [value, setValue] =
    useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const readAttachment = async (file: File) => {
    const maxSize = 25 * 1024 * 1024;
    if (file.size > maxSize) {
      setAttachment({ id: crypto.randomUUID(), name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, status: "failed", error: "Files must be 25 MB or smaller." });
      return;
    }
    const next: ChatAttachment = { id: crypto.randomUUID(), name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, status: "uploading" };
    setAttachment(next);
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      onUpload({ ...next, status: "ready" }, result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
      setAttachment({ ...next, status: "ready" });
    };
    reader.onerror = () => setAttachment({ ...next, status: "failed", error: "Could not read this file." });
    reader.readAsDataURL(file);
  };

  const chooseAttachment = async () => {
    // Electron uses the native picker; browsers retain the standard input.
    const nativeSelection = await window.electronAPI?.selectChatAttachment?.();
    if (nativeSelection?.error) {
      setAttachment({ id: crypto.randomUUID(), name: nativeSelection.name || "attachment", mimeType: nativeSelection.mimeType, size: nativeSelection.size || 0, status: "failed", error: nativeSelection.error });
      return;
    }
    if (nativeSelection) {
      const next: ChatAttachment = { id: crypto.randomUUID(), name: nativeSelection.name, mimeType: nativeSelection.mimeType, size: nativeSelection.size, status: "ready" };
      setAttachment(next);
      onUpload(next, nativeSelection.data);
      return;
    }
    if (!window.electronAPI) fileInputRef.current?.click();
  };

  const send = () => {
    const message = value.trim();

    if ((!message && !attachment) || disabled || attachment?.status === "uploading" || attachment?.status === "failed") {
      return;
    }

    onSend(message, attachment ? [attachment] : []);

    setValue("");
    setAttachment(null);
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="zoya-chat-bottom">
      <div className="zoya-input-box">
        <input ref={fileInputRef} type="file" className="zoya-file-picker" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readAttachment(file); event.currentTarget.value = ""; }} />
        <input
          value={value}
          onChange={(event) =>
            setValue(event.target.value)
          }
          onKeyDown={handleKeyDown}
          placeholder={
            disabled
              ? "Start Aanya first..."
              : "Message Aanya..."
          }
          disabled={disabled}
        />

        <button type="button" className="zoya-attachment-button" onClick={() => void chooseAttachment()} disabled={disabled} title="Attach a file" aria-label="Attach a file">
          <Plus size={17} />
        </button>
        <button
          type="button"
          onClick={send}
          disabled={
            disabled ||
            (!value.trim() && !attachment) || attachment?.status === "uploading" || attachment?.status === "failed"
          }
          title="Send message"
        >
          <Send size={17} />
        </button>
      </div>

      {attachment && <div className={`zoya-attachment ${attachment.status}`}><FileText size={13} /><span>{attachment.name}</span><small>{attachment.status === "uploading" ? "Uploading" : attachment.status === "ready" ? "Ready" : attachment.error || "Failed"}</small><button type="button" onClick={() => setAttachment(null)} aria-label="Remove attachment"><X size={13} /></button></div>}

      <div className="zoya-chat-hint">
        Press Enter to send
      </div>
    </div>
  );
}
