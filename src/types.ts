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
  fileName?: string;
  fileSize?: number;
}

// The workspace path is the single source of truth. Chat cards keep only a
// reference; content is fetched afresh when View or Download is requested.
export interface WorkspaceFile {
  name: string;
  path: string;
  kind: 'file' | 'folder';
  size?: number;
}

export interface WorkspaceFileReadResult {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  previewAvailable: boolean;
  content?: string;
  data?: string;
  error?: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'uploading' | 'ready' | 'processing' | 'failed';
  error?: string;
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
