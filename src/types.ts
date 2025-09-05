// Simplified types for Codex MCP server (cost tracking removed)

export interface CodexResponse {
  text: string;
  success: boolean;
  error?: string;
}

export interface Conversation {
  id: string;
  messages: ConversationMessage[];
  metadata: ConversationMetadata;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'developer';
  content: string;
  timestamp: Date;
}

export interface ConversationMetadata {
  created: Date;
  lastActive: Date;
  topic?: string;
  contextLimit?: number;
}

export interface ConsultParams {
  prompt: string;
  context?: string;
  model?: string;
  temperature?: number;
}

export interface ConversationStartParams {
  topic: string;
  instructions?: string;
}

export interface ConversationContinueParams {
  conversation_id: string;
  message: string;
}