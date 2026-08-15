import React, { useState, useEffect, useRef } from 'react';
import { Send, MessageSquare, ChevronUp, ChevronDown, Copy, Check, Share2, Sparkles, User, Bot, Volume2 } from 'lucide-react';
import { TranscriptItem } from '../types';

interface VoiceChatProps {
  transcripts: TranscriptItem[];
  onSendText: (text: string) => void;
  isConnected: boolean;
  selectedVoice?: string;
}

export const VoiceChat: React.FC<VoiceChatProps> = ({
  transcripts,
  onSendText,
  isConnected,
  selectedVoice = 'Kore',
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const [inputText, setInputText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever transcripts or current text updates
  useEffect(() => {
    if (transcripts.length > 0) {
      console.log(`[VOICE CHAT UI UPDATED] Rendered ${transcripts.length} messages in Voice Chat panel`);
    }
    if (isOpen) {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcripts, isOpen, transcripts[transcripts.length - 1]?.text]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !isConnected) return;
    onSendText(inputText.trim());
    setInputText('');
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCopyAll = () => {
    if (transcripts.length === 0) return;
    const conversationText = transcripts
      .map((t) => {
        const timeStr = new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const sender = t.sender === 'user' ? 'You' : 'Zoya AI';
        return `[${timeStr}] ${sender}: ${t.text}`;
      })
      .join('\n\n');

    navigator.clipboard.writeText(conversationText);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const formatTimestamp = (ts: number) => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const latestTranscript = transcripts[transcripts.length - 1];

  return (
    <div className="w-full max-w-2xl mx-auto my-3 px-4 z-20">
      {/* Live Active Voice Speech Bubble */}
      {latestTranscript && (
        <div className="mb-3 p-3.5 rounded-2xl bg-slate-900/90 border border-pink-500/30 backdrop-blur-md shadow-2xl relative group transition-all">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-pink-400 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-pink-400 animate-pulse" />
              {latestTranscript.sender === 'zoya' ? 'Zoya AI Speaking...' : 'You Said'}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">
              {formatTimestamp(latestTranscript.timestamp)}
            </span>
          </div>
          <p className="text-sm font-medium text-slate-100 pr-8 leading-relaxed select-text">
            "{latestTranscript.text}"
          </p>
          <button
            onClick={() => handleCopy(latestTranscript.id, latestTranscript.text)}
            className="absolute right-3 bottom-3 p-1.5 rounded-lg text-slate-400 hover:text-pink-300 hover:bg-slate-800 transition-colors"
            title="Copy text"
          >
            {copiedId === latestTranscript.id ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      )}

      {/* Main ChatGPT-Voice Style Panel */}
      <div className="rounded-2xl border border-slate-800/80 bg-slate-950/90 backdrop-blur-xl overflow-hidden shadow-2xl">
        {/* Header Bar */}
        <div className="px-4 py-3 flex items-center justify-between border-b border-slate-800/80 bg-slate-900/60">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center space-x-2 text-xs font-bold text-slate-200 hover:text-pink-400 transition-colors"
          >
            <div className="p-1 rounded-lg bg-pink-500/10 border border-pink-500/20 text-pink-400">
              <MessageSquare className="w-4 h-4" />
            </div>
            <span>Voice Chat ({transcripts.length})</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-pink-500/20 text-pink-300 border border-pink-500/30 flex items-center gap-1">
              <Volume2 className="w-3 h-3 text-pink-400" />
              {selectedVoice}
            </span>
            {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronUp className="w-4 h-4 text-slate-400" />}
          </button>

          {transcripts.length > 0 && (
            <button
              onClick={handleCopyAll}
              className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors border border-slate-700/50"
              title="Copy entire conversation history"
            >
              {copiedAll ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-400">Copied All</span>
                </>
              ) : (
                <>
                  <Share2 className="w-3 h-3 text-pink-400" />
                  <span>Copy All</span>
                </>
              )}
            </button>
          )}
        </div>

        {isOpen && (
          <div className="p-4">
            {/* Conversation Log Stream */}
            <div
              ref={scrollContainerRef}
              className="max-h-72 overflow-y-auto space-y-3 pr-1 scrollbar-thin scrollbar-thumb-slate-800 select-text"
            >
              {transcripts.length === 0 ? (
                <div className="text-center py-8 px-4 border border-dashed border-slate-800/80 rounded-2xl bg-slate-900/30">
                  <div className="w-10 h-10 rounded-full bg-pink-500/10 text-pink-400 flex items-center justify-center mx-auto mb-2">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <p className="text-xs font-semibold text-slate-300 mb-1">
                    ChatGPT Voice Mode Active
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Press microphone to talk or type a message below.
                  </p>
                </div>
              ) : (
                transcripts.map((t) => (
                  <div
                    key={t.id}
                    className={`flex flex-col ${
                      t.sender === 'user' ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div className="flex items-center space-x-1.5 mb-1 px-1">
                      {t.sender === 'user' ? (
                        <User className="w-3 h-3 text-purple-400" />
                      ) : (
                        <Bot className="w-3 h-3 text-pink-400" />
                      )}
                      <span className="text-[10px] font-bold text-slate-400 flex items-center gap-1">
                        {t.sender === 'user' ? (
                          'You'
                        ) : (
                          <>
                            <span>Zoya AI</span>
                            <span className="text-[9px] font-normal text-pink-400/90">({selectedVoice} Voice)</span>
                          </>
                        )}
                      </span>
                      <span className="text-[9px] text-slate-600 font-mono">
                        {formatTimestamp(t.timestamp)}
                      </span>
                    </div>

                    <div
                      className={`group relative px-4 py-2.5 rounded-2xl text-xs max-w-[90%] shadow-md leading-relaxed ${
                        t.sender === 'user'
                          ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-tr-xs'
                          : 'bg-slate-900 border border-slate-800 text-slate-100 rounded-tl-xs'
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words pr-6">{t.text}</p>
                      <button
                        onClick={() => handleCopy(t.id, t.text)}
                        className="absolute right-2 top-2 opacity-60 group-hover:opacity-100 p-1 rounded hover:bg-black/20 text-slate-300 transition-opacity"
                        title="Copy text"
                      >
                        {copiedId === t.id ? (
                          <Check className="w-3 h-3 text-emerald-300" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Quick Text Input Form */}
            <form onSubmit={handleSend} className="mt-3.5 flex items-center space-x-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={isConnected ? 'Type or speak to Zoya...' : 'Connect Zoya to start conversation...'}
                disabled={!isConnected}
                className="flex-1 px-4 py-2.5 rounded-xl text-xs bg-slate-900/90 border border-slate-700/80 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-pink-500/80 transition-colors shadow-inner"
              />
              <button
                type="submit"
                disabled={!isConnected || !inputText.trim()}
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 text-white font-bold text-xs disabled:opacity-40 hover:from-pink-600 hover:to-purple-700 transition-all flex items-center space-x-1.5 shadow-lg shadow-pink-500/20"
              >
                <span>Send</span>
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
