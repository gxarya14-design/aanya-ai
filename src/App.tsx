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
} from "lucide-react";

import {
  SessionState,
  ZoyaConfig,
  ZoyaMood,
  ToolCallEvent,
  TranscriptItem,
} from "./types";

import { LiveSession } from "./services/LiveSession";

import zoyaAvatar from "./assets/zoya-avatar.jpg";

import "./zoya-ui.css";

export default function App() {
  const [sessionState, setSessionState] =
    useState<SessionState>("disconnected");

  const [isMuted, setIsMuted] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0);

  const [mood, setMood] = useState<ZoyaMood>("Sassy");

  const [toolEvent, setToolEvent] =
    useState<ToolCallEvent | null>(null);

  const [transcripts, setTranscripts] =
    useState<TranscriptItem[]>([]);

  const [errorMessage, setErrorMessage] =
    useState<string | null>(null);

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

          setTranscripts((previous) => {
            const now = Date.now();

            /*
             * Gemini sometimes sends the same assistant
             * response in multiple chunks.
             *
             * Join recent Zoya chunks together.
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

        onError: (error) => {
          setErrorMessage(error);
        },

        onScreenShareChange: (sharing) => {
          setIsScreenSharing(sharing);
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
   * whenever a new one arrives, or an existing Zoya message
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
          : "Unable to connect to Zoya."
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

  const handleSendMessage = (text: string) => {
    const message = text.trim();

    if (!message) {
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
        text: message,
        timestamp: Date.now(),
      },
    ]);

    sessionRef.current.sendTextMessage(message);
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
          ZOYA
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
            LEFT / MAIN ZOYA AREA
        ================================================= */}

        <section className="zoya-visual">
          <div className="zoya-picture-frame">
            <img
              src={zoyaAvatar}
              alt="Zoya"
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
                    ? "Zoya is speaking"
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
                    ? "Disconnect Zoya"
                    : "Start Zoya"
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
                alt="Zoya"
              />
            </div>

            <div>
              <div className="zoya-chat-name">
                Zoya
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
                  You can speak with Zoya or type
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
          />
        </aside>
      </main>

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
}

function ChatMessage({
  message,
  avatar,
  onCopy,
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
            alt="Zoya"
          />
        </div>
      )}

      <div className="zoya-message-wrapper">
        <div className="zoya-message">
          {message.text}
        </div>

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


/* =========================================================
   CHAT INPUT
   ========================================================= */

interface ChatInputProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

function ChatInput({
  disabled,
  onSend,
}: ChatInputProps) {
  const [value, setValue] =
    useState("");

  const send = () => {
    const message = value.trim();

    if (!message || disabled) {
      return;
    }

    onSend(message);

    setValue("");
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
        <input
          value={value}
          onChange={(event) =>
            setValue(event.target.value)
          }
          onKeyDown={handleKeyDown}
          placeholder={
            disabled
              ? "Start Zoya first..."
              : "Message Zoya..."
          }
          disabled={disabled}
        />

        <button
          type="button"
          onClick={send}
          disabled={
            disabled ||
            !value.trim()
          }
          title="Send message"
        >
          <Send size={17} />
        </button>
      </div>

      <div className="zoya-chat-hint">
        Press Enter to send
      </div>
    </div>
  );
}
