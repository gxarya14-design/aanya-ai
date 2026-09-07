import React from 'react';
import { motion } from 'motion/react';
import { Mic, MicOff, Power, RefreshCw, Volume2, Monitor, MonitorOff } from 'lucide-react';
import { SessionState } from '../types';

interface VoiceControlsProps {
  sessionState: SessionState;
  isMuted: boolean;
  isScreenSharing: boolean;
  onToggleConnect: () => void;
  onToggleMute: () => void;
  onToggleScreenShare: () => void;
  themeColor: string;
}

export const VoiceControls: React.FC<VoiceControlsProps> = ({
  sessionState,
  isMuted,
  isScreenSharing,
  onToggleConnect,
  onToggleMute,
  onToggleScreenShare,
  themeColor,
}) => {
  const isConnected = sessionState !== 'disconnected' && sessionState !== 'error';
  const isConnecting = sessionState === 'connecting';

  return (
    <div className="flex flex-col items-center justify-center my-4 z-20 space-y-3">
      <div className="flex items-center justify-center space-x-4 sm:space-x-6">
        {/* Mute Mic Button */}
        <button
          onClick={onToggleMute}
          disabled={!isConnected}
          className={`p-3.5 rounded-full backdrop-blur-md border transition-all duration-300 shadow-lg ${
            !isConnected
              ? 'bg-slate-800/40 text-slate-600 border-slate-700 cursor-not-allowed'
              : isMuted
              ? 'bg-rose-500/20 text-rose-400 border-rose-500/50 hover:bg-rose-500/30'
              : 'bg-slate-800/80 text-cyan-400 border-slate-700 hover:border-cyan-500/50 hover:bg-slate-700/80'
          }`}
          title={isMuted ? 'Unmute Mic' : 'Mute Mic'}
        >
          {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>

        {/* Main Power / Connect Voice Button */}
        <motion.button
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          onClick={onToggleConnect}
          disabled={isConnecting}
          className="relative group p-6 rounded-full font-bold text-white shadow-2xl transition-all duration-300 flex items-center justify-center cursor-pointer"
          style={{
            background: isConnected
              ? `radial-gradient(circle, ${themeColor} 0%, #0f172a 100%)`
              : 'radial-gradient(circle, #334155 0%, #0f172a 100%)',
            boxShadow: isConnected
              ? `0 0 35px ${themeColor}88, inset 0 0 15px #ffffff44`
              : '0 0 15px rgba(0,0,0,0.5)',
            border: `2px solid ${isConnected ? themeColor : '#475569'}`,
          }}
          title={isConnected ? 'Disconnect Aanya' : 'Connect Aanya Live'}
        >
          {/* Glow Ring */}
          <span
            className="absolute inset-0 rounded-full opacity-40 group-hover:opacity-80 transition-opacity blur-md"
            style={{ backgroundColor: isConnected ? themeColor : '#64748b' }}
          />

          <div className="relative z-10 flex items-center justify-center">
            {isConnecting ? (
              <RefreshCw className="w-8 h-8 animate-spin text-cyan-300" />
            ) : isConnected ? (
              <Volume2 className="w-8 h-8 text-white animate-pulse" />
            ) : (
              <Power className="w-8 h-8 text-slate-300" />
            )}
          </div>
        </motion.button>

        {/* Share Screen Button */}
        <button
          onClick={onToggleScreenShare}
          disabled={!isConnected}
          className={`p-3.5 rounded-full backdrop-blur-md border transition-all duration-300 shadow-lg relative ${
            !isConnected
              ? 'bg-slate-800/40 text-slate-600 border-slate-700 cursor-not-allowed'
              : isScreenSharing
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/60 hover:bg-amber-500/30 shadow-amber-500/20'
              : 'bg-slate-800/80 text-pink-400 border-slate-700 hover:border-pink-500/50 hover:bg-slate-700/80'
          }`}
          title={isScreenSharing ? 'Stop Screen Sharing' : 'Share Screen with Aanya Vision'}
        >
          {isScreenSharing ? (
            <MonitorOff className="w-5 h-5 text-amber-300 animate-pulse" />
          ) : (
            <Monitor className="w-5 h-5" />
          )}

          {isScreenSharing && (
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-amber-400 rounded-full animate-ping" />
          )}
        </button>
      </div>

      {/* Screen Sharing Quick Toggle Bar */}
      {isConnected && (
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onToggleScreenShare}
          className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all duration-300 flex items-center space-x-2 border shadow-md ${
            isScreenSharing
              ? 'bg-amber-950/80 border-amber-500/60 text-amber-200 hover:bg-amber-900/90'
              : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:border-pink-500/50 hover:text-pink-300'
          }`}
        >
          {isScreenSharing ? (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <MonitorOff className="w-3.5 h-3.5 text-amber-300" />
              <span>Sharing Screen Live — Stop Sharing</span>
            </>
          ) : (
            <>
              <Monitor className="w-3.5 h-3.5 text-pink-400" />
              <span>Share Screen (AI Vision)</span>
            </>
          )}
        </motion.button>
      )}
    </div>
  );
};