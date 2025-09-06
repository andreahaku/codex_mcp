import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import winston from 'winston';

const execAsync = promisify(exec);

export interface CodexCommand {
  args: string[];
  input?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface CodexResponse {
  text: string;
  success: boolean;
  error?: string;
  exitCode?: number;
}

export interface StreamingEvent {
  type: 'progress' | 'thinking' | 'plan_update' | 'result' | 'error';
  data: any;
  timestamp: Date;
}

export interface CodexCapabilities {
  supportsJson: boolean;
  supportsStreaming: boolean;
  supportsPlanApi: boolean;
  version: string;
}

export class CodexProcess extends EventEmitter {
  private sessionId: string;
  private workingDirectory: string;
  private logger: winston.Logger;
  private capabilities: CodexCapabilities | null = null;
  private isReady = false;

  constructor(sessionId: string, workingDirectory = process.cwd(), logger: winston.Logger) {
    super();
    this.sessionId = sessionId;
    this.workingDirectory = workingDirectory;
    this.logger = logger;
  }

  async start(): Promise<void> {
    try {
      this.logger.info('Initializing Codex session', { 
        sessionId: this.sessionId,
        workingDirectory: this.workingDirectory 
      });

      // Detect capabilities
      await this.detectCapabilities();
      
      this.isReady = true;
      
      this.logger.info('Codex session initialized successfully', { 
        sessionId: this.sessionId,
        capabilities: this.capabilities
      });

    } catch (error: any) {
      this.logger.error('Failed to initialize Codex session', { 
        sessionId: this.sessionId,
        error: error.message 
      });
      throw new Error(`Failed to initialize Codex session: ${error.message}`);
    }
  }

  async send(command: CodexCommand): Promise<CodexResponse> {
    if (!this.isReady) {
      throw new Error('Session not ready. Call start() first.');
    }

    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    
    try {
      this.logger.debug('Executing Codex command', {
        sessionId: this.sessionId,
        requestId,
        args: command.args
      });

      // Build the command - use the last arg as the prompt
      const prompt = command.args[command.args.length - 1];
      const flags = command.args.slice(0, -1);
      
      // Build full command
      const cmdArgs = ['codex', ...flags, `"${prompt.replace(/"/g, '\\"')}"`];
      const fullCommand = cmdArgs.join(' ');

      this.logger.debug('Executing command', {
        sessionId: this.sessionId,
        requestId,
        command: fullCommand
      });

      // Execute with timeout
      const timeoutMs = command.timeout || 120000;
      const result = await execAsync(fullCommand, {
        cwd: this.workingDirectory,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: timeoutMs,
        signal: command.signal
      });

      // Parse output to extract just the response content
      let responseText = result.stdout.trim();
      
      // Try to extract just the codex response part
      const lines = responseText.split('\n');
      let codexStartIndex = -1;
      
      // Look for the line that starts with timestamp and "codex"
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('codex') && lines[i].includes(']')) {
          codexStartIndex = i + 1;
          break;
        }
      }
      
      if (codexStartIndex > 0 && codexStartIndex < lines.length) {
        // Extract from codex response to before "tokens used"
        const responseLines = [];
        for (let i = codexStartIndex; i < lines.length; i++) {
          if (lines[i].includes('tokens used:')) {
            break;
          }
          responseLines.push(lines[i]);
        }
        responseText = responseLines.join('\n').trim();
      }

      this.logger.debug('Codex command completed', {
        sessionId: this.sessionId,
        requestId,
        responseLength: responseText.length
      });

      return {
        text: responseText,
        success: true,
        exitCode: 0
      };

    } catch (error: any) {
      this.logger.error('Codex command failed', {
        sessionId: this.sessionId,
        requestId,
        error: error.message
      });

      return {
        text: '',
        success: false,
        error: error.message,
        exitCode: error.code || 1
      };
    }
  }

  async restart(): Promise<void> {
    this.logger.info('Restarting Codex session', { sessionId: this.sessionId });
    
    // Simple restart - just reset ready state and re-detect capabilities
    this.isReady = false;
    await this.start();
    
    this.logger.info('Codex session restarted successfully', { sessionId: this.sessionId });
  }

  async kill(): Promise<void> {
    this.logger.info('Shutting down Codex session', { sessionId: this.sessionId });
    this.isReady = false;
    // Nothing to kill for exec-based approach
  }

  getCapabilities(): CodexCapabilities | null {
    return this.capabilities;
  }

  isHealthy(): boolean {
    return this.isReady;
  }

  private async detectCapabilities(): Promise<void> {
    try {
      this.logger.debug('Detecting Codex capabilities', { sessionId: this.sessionId });
      
      const result = await execAsync('codex --version', {
        cwd: this.workingDirectory,
        timeout: 10000
      });

      const version = result.stdout.trim();
      
      this.capabilities = {
        supportsJson: false, // v0.16.0 doesn't seem to have JSON mode
        supportsStreaming: false, // No real streaming in exec mode
        supportsPlanApi: false, // No plan API detected
        version
      };

      this.logger.info('Detected Codex capabilities', {
        sessionId: this.sessionId,
        capabilities: this.capabilities
      });

    } catch (error: any) {
      this.logger.warn('Could not detect Codex capabilities', {
        sessionId: this.sessionId,
        error: error.message
      });
      
      this.capabilities = {
        supportsJson: false,
        supportsStreaming: false,
        supportsPlanApi: false,
        version: 'unknown'
      };
    }
  }
}