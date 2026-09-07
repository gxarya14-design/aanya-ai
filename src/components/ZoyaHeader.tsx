import React, { useState } from 'react';
import { Settings, Sparkles, Volume2, Palette, MessageSquare, Check } from 'lucide-react';
import { ZoyaConfig, ZoyaMood, ZoyaVoice } from '../types';

interface ZoyaHeaderProps {
  config: ZoyaConfig;
  onUpdateConfig: (newConfig: Partial<ZoyaConfig>) => void;
  mood: ZoyaMood;
  isConnected: boolean;
}

export const ZoyaHeader: React.FC<ZoyaHeaderProps> = ({
  config,
  onUpdateConfig,
  mood,
  isConnected,
}) => {
  const [showSettings, setShowSettings] = useState(false);

  const voices: { id: ZoyaVoice; label: string; desc: string }[] = [
    { id: 'Kore', label: 'Kore (Default)', desc: 'Warm, energetic & sassy' },
    { id: 'Aoede', label: 'Aoede', desc: 'Melodic, playful & smooth' },
    { id: 'Puck', label: 'Puck', desc: 'Cheeky & animated' },
    { id: 'Fenrir', label: 'Fenrir', desc: 'Bold & dramatic' },
    { id: 'Zephyr', label: 'Zephyr', desc: 'Soft & witty' },
  ];

  const themes: { id: ZoyaConfig['theme']; name: string; color: string }[] = [
    { id: 'neon-pink', name: 'Neon Pink', color: '#ec4899' },
    { id: 'cyber-purple', name: 'Cyber Purple', color: '#8b5cf6' },
    { id: 'emerald-glow', name: 'Emerald Glow', color: '#10b981' },
    { id: 'sunset-amber', name: 'Sunset Amber', color: '#f59e0b' },
    { id: 'midnight-blue', name: 'Midnight Blue', color: '#3b82f6' },
  ];

  return (
    <header className="relative z-30 flex items-center justify-between w-full max-w-2xl px-4 py-3 mx-auto border-b border-slate-800/80 bg-slate-950/40 backdrop-blur-md rounded-b-2xl">
      {/* Title & Brand */}
      <div className="flex items-center space-x-2.5">
        <div className="p-2 rounded-xl bg-gradient-to-tr from-pink-500 to-purple-600 text-white shadow-lg shadow-pink-500/30">
          <Sparkles className="w-5 h-5 animate-spin-slow" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-lg font-black tracking-wide bg-gradient-to-r from-pink-400 via-purple-300 to-cyan-400 bg-clip-text text-transparent">
              AANYA
            </h1>
            <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-pink-300 bg-pink-950/60 border border-pink-500/40 rounded-full">
              LIVE AI
            </span>
          </div>
          <p className="text-[11px] text-slate-400 font-medium">Your witty & sassy voice assistant</p>
        </div>
      </div>

      {/* Mood Badge & Settings Trigger */}
      <div className="flex items-center space-x-3">
        {/* Mood Pill */}
        <div className="hidden sm:flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-slate-900/80 border border-slate-700/80 text-pink-300 shadow-inner">
          <span className="w-1.5 h-1.5 rounded-full bg-pink-400 mr-1.5 animate-pulse" />
          Mood: {mood}
        </div>

        {/* Settings Toggle Button */}
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`p-2 rounded-xl border transition-all duration-300 ${
            showSettings
              ? 'bg-pink-500/20 border-pink-500/60 text-pink-300'
              : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:border-slate-700 hover:text-white'
          }`}
          title="Aanya Settings"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>

      {/* Settings Modal / Dropdown */}
      {showSettings && (
        <div className="absolute top-16 right-4 z-50 w-80 p-4 rounded-2xl bg-slate-900/95 border border-slate-700 shadow-2xl backdrop-blur-xl text-slate-200">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="font-bold text-sm text-pink-300 flex items-center">
              <Settings className="w-4 h-4 mr-2" /> Aanya Preferences
            </h3>
            <button
              onClick={() => setShowSettings(false)}
              className="text-xs text-slate-400 hover:text-white"
            >
              Close
            </button>
          </div>

          {/* Voice Selector */}
          <div className="mt-4">
            <label className="block text-xs font-semibold text-slate-400 mb-2 flex items-center">
              <Volume2 className="w-3.5 h-3.5 mr-1 text-cyan-400" /> Voice Profile
            </label>
            <div className="space-y-1.5">
              {voices.map((v) => (
                <button
                  key={v.id}
                  onClick={() => onUpdateConfig({ voice: v.id })}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-colors flex items-center justify-between ${
                    config.voice === v.id
                      ? 'bg-pink-500/20 border border-pink-500/50 text-pink-200 font-semibold'
                      : 'bg-slate-800/50 hover:bg-slate-800 text-slate-300'
                  }`}
                >
                  <div>
                    <div>{v.label}</div>
                    <div className="text-[10px] text-slate-400 font-normal">{v.desc}</div>
                  </div>
                  {config.voice === v.id && <Check className="w-4 h-4 text-pink-400" />}
                </button>
              ))}
            </div>
          </div>

          {/* Theme Accent Picker */}
          <div className="mt-4">
            <label className="block text-xs font-semibold text-slate-400 mb-2 flex items-center">
              <Palette className="w-3.5 h-3.5 mr-1 text-purple-400" /> Ambient Accent
            </label>
            <div className="flex items-center justify-between space-x-2">
              {themes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onUpdateConfig({ theme: t.id })}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-transform ${
                    config.theme === t.id ? 'scale-110 ring-2 ring-white' : 'hover:scale-105'
                  }`}
                  style={{ backgroundColor: t.color }}
                  title={t.name}
                >
                  {config.theme === t.id && <Check className="w-4 h-4 text-white" />}
                </button>
              ))}
            </div>
          </div>

          {/* Transcripts Toggle */}
          <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
            <label className="text-xs font-medium text-slate-300 flex items-center">
              <MessageSquare className="w-3.5 h-3.5 mr-1.5 text-emerald-400" /> Show Live Transcripts
            </label>
            <input
              type="checkbox"
              checked={config.enableTranscripts}
              onChange={(e) => onUpdateConfig({ enableTranscripts: e.target.checked })}
              className="w-4 h-4 rounded accent-pink-500 cursor-pointer"
            />
          </div>
        </div>
      )}
    </header>
  );
};