import fs from 'fs/promises';
import path from 'path';
import winston from 'winston';

export interface StoredSession {
  id: string;
  workspaceId: string;
  workspacePath: string;
  created: string; // ISO string
  lastActive: string; // ISO string
  requestCount: number;
  conversationId?: string;
}

export interface StoredConversation {
  id: string;
  sessionId: string;
  topic?: string;
  instructions?: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string; // ISO string
  }>;
  created: string; // ISO string
  lastActive: string; // ISO string
}

export interface StorageData {
  sessions: StoredSession[];
  conversations: StoredConversation[];
  lastSaved: string; // ISO string
  version: string;
}

export class StorageManager {
  private storageFile: string;
  private logger: winston.Logger;
  private data: StorageData;
  private saveTimer: NodeJS.Timeout | null = null;
  private isDirty = false;

  constructor(
    logger: winston.Logger,
    storageDir: string = path.join(process.cwd(), '.codex-mcp')
  ) {
    this.logger = logger;
    this.storageFile = path.join(storageDir, 'sessions.json');
    this.data = {
      sessions: [],
      conversations: [],
      lastSaved: new Date().toISOString(),
      version: '1.0'
    };
  }

  async initialize(): Promise<void> {
    try {
      // Ensure storage directory exists
      const storageDir = path.dirname(this.storageFile);
      await fs.mkdir(storageDir, { recursive: true });

      // Load existing data if available
      await this.load();
      
      // Set up periodic saves
      this.startAutoSave();

      this.logger.info('Storage manager initialized', {
        storageFile: this.storageFile,
        sessions: this.data.sessions.length,
        conversations: this.data.conversations.length
      });

    } catch (error: any) {
      this.logger.warn('Failed to initialize storage', {
        error: error.message,
        storageFile: this.storageFile
      });
    }
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.storageFile, 'utf8');
      const loaded = JSON.parse(content);
      
      // Validate structure
      if (loaded.sessions && loaded.conversations && loaded.version) {
        this.data = loaded;
        
        // Clean up old sessions (older than 7 days)
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        const cutoffTime = cutoff.toISOString();
        
        const originalSessionCount = this.data.sessions.length;
        const originalConvCount = this.data.conversations.length;
        
        this.data.sessions = this.data.sessions.filter(
          session => session.lastActive > cutoffTime
        );
        
        const activeSessions = new Set(this.data.sessions.map(s => s.id));
        this.data.conversations = this.data.conversations.filter(
          conv => conv.lastActive > cutoffTime && 
                 (!conv.sessionId || activeSessions.has(conv.sessionId))
        );

        if (this.data.sessions.length < originalSessionCount || 
            this.data.conversations.length < originalConvCount) {
          this.logger.info('Cleaned up old storage entries', {
            sessionsRemoved: originalSessionCount - this.data.sessions.length,
            conversationsRemoved: originalConvCount - this.data.conversations.length
          });
          this.isDirty = true;
        }

        this.logger.info('Storage loaded successfully', {
          sessions: this.data.sessions.length,
          conversations: this.data.conversations.length,
          lastSaved: this.data.lastSaved
        });
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('Failed to load storage', {
          error: error.message,
          storageFile: this.storageFile
        });
      }
      // Continue with empty data on any load error
    }
  }

  async save(force = false): Promise<void> {
    if (!this.isDirty && !force) {
      return;
    }

    try {
      this.data.lastSaved = new Date().toISOString();
      
      const content = JSON.stringify(this.data, null, 2);
      await fs.writeFile(this.storageFile, content, 'utf8');
      
      this.isDirty = false;
      
      this.logger.debug('Storage saved successfully', {
        sessions: this.data.sessions.length,
        conversations: this.data.conversations.length,
        size: content.length
      });

    } catch (error: any) {
      this.logger.error('Failed to save storage', {
        error: error.message,
        storageFile: this.storageFile
      });
    }
  }

  // Session management
  saveSession(session: StoredSession): void {
    const index = this.data.sessions.findIndex(s => s.id === session.id);
    
    if (index >= 0) {
      this.data.sessions[index] = session;
    } else {
      this.data.sessions.push(session);
    }
    
    this.isDirty = true;
  }

  getSession(sessionId: string): StoredSession | undefined {
    return this.data.sessions.find(s => s.id === sessionId);
  }

  getSessions(workspaceId?: string): StoredSession[] {
    const sessions = workspaceId 
      ? this.data.sessions.filter(s => s.workspaceId === workspaceId)
      : this.data.sessions;
    
    return sessions.sort((a, b) => 
      new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
    );
  }

  removeSession(sessionId: string): boolean {
    const index = this.data.sessions.findIndex(s => s.id === sessionId);
    if (index >= 0) {
      this.data.sessions.splice(index, 1);
      this.isDirty = true;
      return true;
    }
    return false;
  }

  // Conversation management
  saveConversation(conversation: StoredConversation): void {
    const index = this.data.conversations.findIndex(c => c.id === conversation.id);
    
    if (index >= 0) {
      this.data.conversations[index] = conversation;
    } else {
      this.data.conversations.push(conversation);
    }
    
    this.isDirty = true;
  }

  getConversation(conversationId: string): StoredConversation | undefined {
    return this.data.conversations.find(c => c.id === conversationId);
  }

  getConversations(sessionId?: string): StoredConversation[] {
    const conversations = sessionId 
      ? this.data.conversations.filter(c => c.sessionId === sessionId)
      : this.data.conversations;
    
    return conversations.sort((a, b) => 
      new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
    );
  }

  removeConversation(conversationId: string): boolean {
    const index = this.data.conversations.findIndex(c => c.id === conversationId);
    if (index >= 0) {
      this.data.conversations.splice(index, 1);
      this.isDirty = true;
      return true;
    }
    return false;
  }

  // Workspace cleanup
  clearWorkspace(workspaceId: string): void {
    const sessionsBefore = this.data.sessions.length;
    const conversationsBefore = this.data.conversations.length;
    
    this.data.sessions = this.data.sessions.filter(s => s.workspaceId !== workspaceId);
    this.data.conversations = this.data.conversations.filter(c => {
      const session = this.data.sessions.find(s => s.id === c.sessionId);
      return session?.workspaceId !== workspaceId;
    });

    const sessionsRemoved = sessionsBefore - this.data.sessions.length;
    const conversationsRemoved = conversationsBefore - this.data.conversations.length;

    if (sessionsRemoved > 0 || conversationsRemoved > 0) {
      this.logger.info('Cleared workspace data', {
        workspaceId,
        sessionsRemoved,
        conversationsRemoved
      });
      this.isDirty = true;
    }
  }

  async shutdown(): Promise<void> {
    this.stopAutoSave();
    await this.save(true); // Force final save
    
    this.logger.info('Storage manager shut down', {
      storageFile: this.storageFile,
      finalSave: this.data.lastSaved
    });
  }

  getStats(): {
    sessions: number;
    conversations: number;
    totalMessages: number;
    oldestSession?: string;
    newestSession?: string;
  } {
    const totalMessages = this.data.conversations.reduce(
      (sum, conv) => sum + conv.messages.length, 0
    );

    const sessions = this.data.sessions.sort((a, b) => 
      new Date(a.created).getTime() - new Date(b.created).getTime()
    );

    return {
      sessions: this.data.sessions.length,
      conversations: this.data.conversations.length,
      totalMessages,
      oldestSession: sessions[0]?.created,
      newestSession: sessions[sessions.length - 1]?.created
    };
  }

  private startAutoSave(): void {
    // Save every 30 seconds if there are changes
    this.saveTimer = setInterval(() => {
      if (this.isDirty) {
        this.save().catch(error => {
          this.logger.warn('Auto-save failed', { error: error.message });
        });
      }
    }, 30000);
  }

  private stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }
}