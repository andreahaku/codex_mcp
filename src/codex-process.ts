import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import winston from 'winston';

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
  private process: ChildProcess | null = null;
  private sessionId: string;
  private workingDirectory: string;
  private logger: winston.Logger;
  private isRestarting = false;
  private requestQueue: Array<{
    command: CodexCommand;
    resolve: (response: CodexResponse) => void;
    reject: (error: Error) => void;
    requestId: string;
  }> = [];
  private currentRequest: string | null = null;
  private restartCount = 0;
  private maxRestarts = 3;
  private capabilities: CodexCapabilities | null = null;

  constructor(sessionId: string, workingDirectory = process.cwd(), logger: winston.Logger) {
    super();
    this.sessionId = sessionId;
    this.workingDirectory = workingDirectory;
    this.logger = logger;
  }

  async start(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.logger.warn('Process already running', { sessionId: this.sessionId });
      return;
    }

    try {
      this.logger.info('Starting Codex process', { 
        sessionId: this.sessionId,
        workingDirectory: this.workingDirectory 
      });

      // Detect capabilities first
      await this.detectCapabilities();

      // Start the persistent process
      this.process = spawn('codex', ['repl', '--json'], {
        cwd: this.workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.setupProcessHandlers();
      
      // Wait for process to be ready
      await this.waitForReady();
      
      this.logger.info('Codex process started successfully', { 
        sessionId: this.sessionId,
        pid: this.process.pid,
        capabilities: this.capabilities
      });

    } catch (error: any) {
      this.logger.error('Failed to start Codex process', { 
        sessionId: this.sessionId,
        error: error.message 
      });
      throw new Error(`Failed to start Codex process: ${error.message}`);
    }
  }

  async send(command: CodexCommand): Promise<CodexResponse> {
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    
    return new Promise((resolve, reject) => {
      // Add timeout handling
      const timeoutMs = command.timeout || 120000; // 2 minutes default
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Add abort signal handling
      if (command.signal) {
        command.signal.addEventListener('abort', () => {
          clearTimeout(timeoutHandle);
          reject(new Error('Request was aborted'));
        });
      }

      const wrappedResolve = (response: CodexResponse) => {
        clearTimeout(timeoutHandle);
        resolve(response);
      };

      const wrappedReject = (error: Error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      };

      this.requestQueue.push({
        command,
        resolve: wrappedResolve,
        reject: wrappedReject,
        requestId
      });

      this.processQueue();
    });
  }

  async restart(): Promise<void> {
    if (this.isRestarting) {
      this.logger.warn('Already restarting', { sessionId: this.sessionId });
      return;
    }

    if (this.restartCount >= this.maxRestarts) {
      throw new Error(`Maximum restart attempts (${this.maxRestarts}) exceeded`);
    }

    this.isRestarting = true;
    this.restartCount++;
    
    try {
      this.logger.info('Restarting Codex process', { 
        sessionId: this.sessionId,
        restartCount: this.restartCount 
      });

      await this.kill();
      
      // Exponential backoff
      const delay = Math.min(1000 * Math.pow(2, this.restartCount - 1), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      await this.start();
      
      this.logger.info('Codex process restarted successfully', { 
        sessionId: this.sessionId 
      });

    } finally {
      this.isRestarting = false;
    }
  }

  async kill(): Promise<void> {
    if (!this.process) return;

    try {
      this.logger.info('Killing Codex process', { 
        sessionId: this.sessionId,
        pid: this.process.pid 
      });

      // Graceful shutdown first
      if (!this.process.killed) {
        this.process.kill('SIGTERM');
        
        // Wait up to 5 seconds for graceful shutdown
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (this.process && !this.process.killed) {
              this.logger.warn('Force killing Codex process', { 
                sessionId: this.sessionId,
                pid: this.process.pid 
              });
              this.process.kill('SIGKILL');
            }
            resolve(void 0);
          }, 5000);

          if (this.process) {
            this.process.once('exit', () => {
              clearTimeout(timeout);
              resolve(void 0);
            });
          }
        });
      }

      // Reject any pending requests
      this.requestQueue.forEach(({ reject, requestId }) => {
        reject(new Error(`Process killed while request ${requestId} was pending`));
      });
      this.requestQueue = [];

    } catch (error: any) {
      this.logger.error('Error killing Codex process', { 
        sessionId: this.sessionId,
        error: error.message 
      });
    } finally {
      this.process = null;
    }
  }

  getCapabilities(): CodexCapabilities | null {
    return this.capabilities;
  }

  isHealthy(): boolean {
    return this.process !== null && !this.process.killed && !this.isRestarting;
  }

  private async detectCapabilities(): Promise<void> {
    try {
      // Run codex --version to detect capabilities
      const versionProcess = spawn('codex', ['--version'], {
        cwd: this.workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      versionProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      versionProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      await new Promise((resolve, reject) => {
        versionProcess.on('exit', (code) => {
          if (code === 0) {
            resolve(void 0);
          } else {
            reject(new Error(`Version check failed with code ${code}: ${stderr}`));
          }
        });

        versionProcess.on('error', reject);
      });

      // Parse version and detect capabilities
      const version = stdout.trim();
      const supportsJson = version.includes('json') || true; // Assume modern version
      const supportsStreaming = version.includes('streaming') || true; // Assume modern version
      const supportsPlanApi = version.includes('plan') || false; // Conservative assumption

      this.capabilities = {
        supportsJson,
        supportsStreaming,
        supportsPlanApi,
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
      
      // Fallback capabilities
      this.capabilities = {
        supportsJson: false,
        supportsStreaming: false,
        supportsPlanApi: false,
        version: 'unknown'
      };
    }
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on('exit', (code, signal) => {
      this.logger.info('Codex process exited', {
        sessionId: this.sessionId,
        code,
        signal
      });

      this.emit('exit', { code, signal });

      // Auto-restart on unexpected exit if not manually killed
      if (!this.isRestarting && code !== 0) {
        this.logger.info('Attempting auto-restart after unexpected exit', {
          sessionId: this.sessionId
        });
        this.restart().catch((error) => {
          this.logger.error('Auto-restart failed', {
            sessionId: this.sessionId,
            error: error.message
          });
          this.emit('error', error);
        });
      }
    });

    this.process.on('error', (error) => {
      this.logger.error('Codex process error', {
        sessionId: this.sessionId,
        error: error.message
      });
      this.emit('error', error);
    });

    // Handle streaming output
    if (this.process.stdout) {
      this.setupStreamingHandlers(this.process.stdout);
    }

    if (this.process.stderr) {
      this.process.stderr.on('data', (data) => {
        const text = data.toString();
        this.logger.warn('Codex stderr', {
          sessionId: this.sessionId,
          text: text.trim()
        });
      });
    }
  }

  private setupStreamingHandlers(stdout: Readable): void {
    let buffer = '';

    stdout.on('data', (data) => {
      buffer += data.toString();
      
      // Process complete JSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            this.handleStreamingEvent(event);
          } catch (error) {
            // Not JSON, treat as regular output
            this.handleTextOutput(line);
          }
        }
      }
    });
  }

  private handleStreamingEvent(event: any): void {
    const streamingEvent: StreamingEvent = {
      type: event.type || 'result',
      data: event.data || event,
      timestamp: new Date()
    };

    this.logger.debug('Streaming event', {
      sessionId: this.sessionId,
      event: streamingEvent
    });

    this.emit('streaming', streamingEvent);

    // Handle completion events
    if (event.type === 'completion' || event.type === 'result') {
      this.handleRequestCompletion(event);
    }
  }

  private handleTextOutput(text: string): void {
    this.logger.debug('Text output', {
      sessionId: this.sessionId,
      text: text.trim()
    });

    // Emit as streaming event for non-JSON output
    const streamingEvent: StreamingEvent = {
      type: 'result',
      data: { text: text.trim() },
      timestamp: new Date()
    };

    this.emit('streaming', streamingEvent);
  }

  private handleRequestCompletion(event: any): void {
    const current = this.requestQueue.shift();
    if (current) {
      const response: CodexResponse = {
        text: event.text || event.data?.text || '',
        success: !event.error,
        error: event.error,
        exitCode: event.code
      };

      current.resolve(response);
      this.currentRequest = null;
      
      // Process next request in queue
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.currentRequest || this.requestQueue.length === 0) {
      return;
    }

    if (!this.isHealthy()) {
      this.logger.warn('Process not healthy, attempting restart', {
        sessionId: this.sessionId
      });
      
      try {
        await this.restart();
      } catch (error: any) {
        // Reject all queued requests
        this.requestQueue.forEach(({ reject }) => {
          reject(new Error('Failed to restart Codex process'));
        });
        this.requestQueue = [];
        return;
      }
    }

    const request = this.requestQueue[0];
    if (!request) return;

    this.currentRequest = request.requestId;

    try {
      // Send command to process
      if (this.process?.stdin) {
        const command = {
          id: request.requestId,
          args: request.command.args,
          input: request.command.input
        };

        this.process.stdin.write(JSON.stringify(command) + '\n');
      }
    } catch (error: any) {
      const current = this.requestQueue.shift();
      if (current) {
        current.reject(new Error(`Failed to send command: ${error.message}`));
      }
      this.currentRequest = null;
    }
  }

  private async waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Codex process failed to become ready within timeout'));
      }, 10000); // 10 second timeout

      const onReady = () => {
        clearTimeout(timeout);
        resolve();
      };

      // For now, assume ready immediately
      // TODO: Wait for actual ready signal from Codex
      setTimeout(onReady, 1000);
    });
  }
}