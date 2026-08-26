export type SessionState = 'disconnected' | 'connecting' | 'idle' | 'listening' | 'speaking' | 'thinking' | 'error';

export type ZoyaVoice = 'Kore' | 'Aoede' | 'Puck' | 'Fenrir' | 'Zephyr';

export type ZoyaMood = 'Sassy' | 'Flirty' | 'Teasing' | 'Playful' | 'Smart' | 'Charming';

export interface ToolCallEvent {
  id: string;
  name: string;
  args: Record<string, any>;
  timestamp: number;
  status: 'executing' | 'completed' | 'failed';
  resultMessage?: string;
}

export interface TranscriptItem {
  id: string;
  sender: 'user' | 'zoya' | 'system';
  text: string;
  timestamp: number;
  filePath?: string;
  fileKind?: 'file' | 'folder';
}

export interface ZoyaConfig {
  voice: ZoyaVoice;
  enableTranscripts: boolean;
  theme: 'neon-pink' | 'cyber-purple' | 'emerald-glow' | 'sunset-amber' | 'midnight-blue';
}

// FIX (confirm-before-act popup): shape of the "confirmRequired" message the
// server sends when a gated tool call (openWebsite, openApplication, and
// anything added to TOOL_CONFIRMATION_LEVELS later) is waiting on the user.
// If approvalsNeeded > 1, the server re-sends this with an incremented
// approvalsSoFar each time the user confirms, until it reaches approvalsNeeded.
export interface ConfirmRequiredEvent {
  id: string;
  name: string;
  args: Record<string, any>;
  summary: string;
  approvalsNeeded: number;
  approvalsSoFar: number;
}