import { CodexProcess, CodexCommand, CodexResponse, StreamingEvent, CodexCapabilities } from './codex-process-simple.js';
import winston from 'winston';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

export interface SessionInfo {
  id: string;
  workspaceId: string; // Repository-specific identifier
  workspacePath: string;
  created: Date;
  lastActive: Date;
  status: 'starting' | 'ready' | 'error' | 'restarting';
  processId?: number;
  capabilities?: CodexCapabilities;
  requestCount: number;
}

export class SessionManager {
  private sessions: Map<string, CodexProcess> = new Map();
  private sessionInfo: Map<string, SessionInfo> = new Map();
  private logger: winston.Logger;
  private maxSessions: number;
  private maxIdleTime: number; // milliseconds

  constructor(
    logger: winston.Logger,
    maxSessions = 10,
    maxIdleTime = 30 * 60 * 1000 // 30 minutes
  ) {
    this.logger = logger;
    this.maxSessions = maxSessions;
    this.maxIdleTime = maxIdleTime;

    // Cleanup idle sessions periodically
    setInterval(() => {
      this.cleanupIdleSessions();
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  async getOrCreateSession(sessionId: string, workspacePath: string = process.cwd()): Promise<CodexProcess> {
    let process = this.sessions.get(sessionId);
    
    if (process && process.isHealthy()) {
      // Update last active time
      const info = this.sessionInfo.get(sessionId);
      if (info) {
        info.lastActive = new Date();
        info.requestCount++;
      }
      return process;
    }

    // Clean up old process if it exists
    if (process) {
      await this.destroySession(sessionId);
    }

    // Create new session
    return await this.createSession(sessionId, workspacePath);
  }

  async createSession(sessionId: string, workspacePath: string): Promise<CodexProcess> {
    // Check if we're at max capacity
    if (this.sessions.size >= this.maxSessions) {
      await this.cleanupOldestSession();
    }

    // Generate workspace-specific identifier
    const workspaceId = this.generateWorkspaceId(workspacePath);

    this.logger.info('Creating new Codex session', { 
      sessionId,
      workspaceId, 
      workspacePath 
    });

    const process = new CodexProcess(sessionId, workspacePath, this.logger);

    // Set up event handlers
    this.setupProcessEventHandlers(sessionId, process);

    // Store session info
    const info: SessionInfo = {
      id: sessionId,
      workspaceId,
      workspacePath,
      created: new Date(),
      lastActive: new Date(),
      status: 'starting',
      requestCount: 0
    };

    this.sessionInfo.set(sessionId, info);
    this.sessions.set(sessionId, process);

    try {
      await process.start();
      
      // Update session info
      info.status = 'ready';
      info.capabilities = process.getCapabilities() || undefined;
      
      this.logger.info('Codex session ready', { 
        sessionId, 
        capabilities: info.capabilities 
      });
      
      return process;

    } catch (error: any) {
      info.status = 'error';
      
      this.logger.error('Failed to start Codex session', {
        sessionId,
        error: error.message
      });

      // Clean up failed session
      this.sessions.delete(sessionId);
      this.sessionInfo.delete(sessionId);
      
      throw error;
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const process = this.sessions.get(sessionId);
    if (process) {
      this.logger.info('Destroying Codex session', { sessionId });
      
      try {
        await process.kill();
      } catch (error: any) {
        this.logger.warn('Error killing session process', {
          sessionId,
          error: error.message
        });
      }
      
      this.sessions.delete(sessionId);
      this.sessionInfo.delete(sessionId);
    }
  }

  async sendCommand(
    sessionId: string, 
    command: CodexCommand,
    workspacePath: string = process.cwd(),
    streamingCallback?: (event: StreamingEvent) => void
  ): Promise<CodexResponse> {
    const process = await this.getOrCreateSession(sessionId, workspacePath);

    // Set up streaming callback if provided
    if (streamingCallback) {
      const handler = (event: StreamingEvent) => streamingCallback(event);
      process.on('streaming', handler);
      
      // Remove handler after response (to prevent memory leaks)
      const originalSend = process.send.bind(process);
      return originalSend(command).finally(() => {
        process.off('streaming', handler);
      });
    }

    return process.send(command);
  }

  getSessionInfo(sessionId: string): SessionInfo | undefined {
    return this.sessionInfo.get(sessionId);
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessionInfo.values())
      .sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
  }

  async healthCheck(sessionId?: string): Promise<{ healthy: boolean; sessions: SessionInfo[] }> {
    if (sessionId) {
      const process = this.sessions.get(sessionId);
      const info = this.getSessionInfo(sessionId);
      
      return {
        healthy: process?.isHealthy() || false,
        sessions: info ? [info] : []
      };
    }

    // Check all sessions
    const sessions = this.getAllSessions();
    let healthyCount = 0;

    for (const session of sessions) {
      const process = this.sessions.get(session.id);
      if (process?.isHealthy()) {
        healthyCount++;
      }
    }

    return {
      healthy: healthyCount === sessions.length,
      sessions
    };
  }

  async restart(sessionId: string): Promise<void> {
    const process = this.sessions.get(sessionId);
    const info = this.sessionInfo.get(sessionId);
    
    if (!process || !info) {
      throw new Error(`Session ${sessionId} not found`);
    }

    this.logger.info('Restarting session', { sessionId });
    
    info.status = 'restarting';
    
    try {
      await process.restart();
      info.status = 'ready';
      info.lastActive = new Date();
      info.capabilities = process.getCapabilities() || undefined;
      
    } catch (error: any) {
      info.status = 'error';
      this.logger.error('Failed to restart session', {
        sessionId,
        error: error.message
      });
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down all sessions', {
      sessionCount: this.sessions.size
    });

    const shutdownPromises = Array.from(this.sessions.keys()).map(sessionId =>
      this.destroySession(sessionId).catch(error => {
        this.logger.warn('Error during session shutdown', {
          sessionId,
          error: error.message
        });
      })
    );

    await Promise.all(shutdownPromises);

    this.logger.info('All sessions shut down');
  }

  private setupProcessEventHandlers(sessionId: string, process: CodexProcess): void {
    process.on('exit', ({ code, signal }) => {
      const info = this.sessionInfo.get(sessionId);
      if (info) {
        info.status = code === 0 ? 'ready' : 'error';
      }
      
      this.logger.info('Session process exited', {
        sessionId,
        code,
        signal
      });
    });

    process.on('error', (error) => {
      const info = this.sessionInfo.get(sessionId);
      if (info) {
        info.status = 'error';
      }
      
      this.logger.error('Session process error', {
        sessionId,
        error: error.message
      });
    });

    process.on('streaming', (event: StreamingEvent) => {
      this.logger.debug('Session streaming event', {
        sessionId,
        eventType: event.type
      });
    });
  }

  private async cleanupIdleSessions(): Promise<void> {
    const now = Date.now();
    const sessionsToCleanup: string[] = [];

    for (const [sessionId, info] of this.sessionInfo.entries()) {
      if (now - info.lastActive.getTime() > this.maxIdleTime) {
        sessionsToCleanup.push(sessionId);
      }
    }

    if (sessionsToCleanup.length > 0) {
      this.logger.info('Cleaning up idle sessions', {
        sessionIds: sessionsToCleanup,
        count: sessionsToCleanup.length
      });

      for (const sessionId of sessionsToCleanup) {
        await this.destroySession(sessionId).catch(error => {
          this.logger.warn('Error cleaning up idle session', {
            sessionId,
            error: error.message
          });
        });
      }
    }
  }

  private async cleanupOldestSession(): Promise<void> {
    const sessions = this.getAllSessions();
    if (sessions.length === 0) return;

    const oldest = sessions[sessions.length - 1];
    this.logger.info('Cleaning up oldest session to make room', {
      sessionId: oldest.id,
      lastActive: oldest.lastActive
    });

    await this.destroySession(oldest.id);
  }

  private generateWorkspaceId(workspacePath: string): string {
    // Create a stable identifier for the workspace based on path and git repo (if any)
    
    try {
      // Try to get git repo info for more stable ID
      const gitPath = path.join(workspacePath, '.git');
      if (fs.existsSync(gitPath)) {
        const gitHeadPath = path.join(gitPath, 'HEAD');
        if (fs.existsSync(gitHeadPath)) {
          const headContent = fs.readFileSync(gitHeadPath, 'utf8').trim();
          const repoName = path.basename(workspacePath);
          return crypto.createHash('md5').update(`${repoName}:${headContent}:${workspacePath}`).digest('hex').substring(0, 12);
        }
      }
      
      // Fallback to path-based ID
      const repoName = path.basename(workspacePath);
      return crypto.createHash('md5').update(`${repoName}:${workspacePath}`).digest('hex').substring(0, 12);
      
    } catch (error) {
      // Final fallback
      return crypto.createHash('md5').update(workspacePath).digest('hex').substring(0, 12);
    }
  }

  getSessionsByWorkspace(workspaceId: string): SessionInfo[] {
    return Array.from(this.sessionInfo.values())
      .filter(info => info.workspaceId === workspaceId)
      .sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
  }

  async cleanupWorkspaceSessions(workspaceId: string): Promise<void> {
    const sessions = this.getSessionsByWorkspace(workspaceId);
    
    this.logger.info('Cleaning up workspace sessions', {
      workspaceId,
      sessionCount: sessions.length
    });

    for (const session of sessions) {
      await this.destroySession(session.id).catch(error => {
        this.logger.warn('Error cleaning up workspace session', {
          sessionId: session.id,
          workspaceId,
          error: error.message
        });
      });
    }
  }
}