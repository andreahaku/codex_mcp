import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { StructuredLogger } from './logger.js';
import { categorizeError, createErrorContext } from './error-utils.js';
import { ErrorCategory } from './error-types.js';

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
  supportsModelSelection: boolean;
  supportsWorkspaceMode: boolean;
  supportsFileOperations: boolean;
  maxTokens?: number;
  availableModels: string[];
  version: string;
  features: string[];
}

export class CodexProcess extends EventEmitter {
  private sessionId: string;
  private workingDirectory: string;
  private logger: StructuredLogger;
  private capabilities: CodexCapabilities | null = null;
  private isReady = false;

  constructor(sessionId: string, workingDirectory = process.cwd(), logger: StructuredLogger) {
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
      
      // Properly escape the prompt for shell execution
      const escapedPrompt = this.escapeShellArgument(prompt);
      
      // Build full command array for execAsync (safer than string)
      const cmdArgs = ['codex', ...flags, escapedPrompt];
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
      // Create error context for structured logging
      const errorContext = createErrorContext(
        this.sessionId,
        undefined,
        this.workingDirectory,
        requestId,
        'codex_command',
        { command: command.args, timeout: command.timeout }
      );

      // Categorize the error for better handling
      const categorizedError = categorizeError(error, errorContext, ErrorCategory.CODEX_CLI);
      
      // Log with structured context
      this.logger.logError(categorizedError, {
        sessionId: this.sessionId,
        requestId,
        workspacePath: this.workingDirectory,
        duration: Date.now() - parseInt(requestId.split('_')[1], 36)
      });

      return {
        text: '',
        success: false,
        error: categorizedError.message,
        exitCode: error.code || 1
      };
    }
  }

  async restart(): Promise<void> {
    this.logger.logSessionEvent(this.sessionId, 'restart', {
      workspacePath: this.workingDirectory,
      previousCapabilities: this.capabilities
    });
    
    // Simple restart - just reset ready state and re-detect capabilities
    this.isReady = false;
    await this.start();
    
    this.logger.info('Codex session restarted successfully', { 
      sessionId: this.sessionId,
      newCapabilities: this.capabilities
    });
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

  private escapeShellArgument(arg: string): string {
    // Handle complex arguments by using single quotes and escaping single quotes within
    if (arg.includes("'")) {
      // If the argument contains single quotes, we need to handle them specially
      // Replace each single quote with '\'' (end quote, escaped quote, start quote)
      return `'${arg.replace(/'/g, "'\\''")}'`;
    }
    
    // For arguments without single quotes, just wrap in single quotes
    return `'${arg}'`;
  }

  private async detectCapabilities(): Promise<void> {
    try {
      this.logger.debug('Detecting Codex capabilities', { sessionId: this.sessionId });
      
      // Test 1: Get version information
      const versionResult = await execAsync('codex --version', {
        cwd: this.workingDirectory,
        timeout: 10000
      });
      const version = versionResult.stdout.trim();

      // Test 2: Get help information to detect available features
      let helpOutput = '';
      let availableModels: string[] = [];
      let features: string[] = [];
      
      try {
        const helpResult = await execAsync('codex --help', {
          cwd: this.workingDirectory,
          timeout: 5000
        });
        helpOutput = helpResult.stdout + helpResult.stderr;
      } catch (error) {
        this.logger.debug('Could not get help output', { sessionId: this.sessionId });
      }

      // Test 3: Check for JSON mode support
      let supportsJson = false;
      try {
        await execAsync('codex --help | grep -i json', {
          cwd: this.workingDirectory,
          timeout: 3000
        });
        supportsJson = true;
        features.push('json_mode');
      } catch (error) {
        // JSON mode not supported
      }

      // Test 4: Check for model selection support
      let supportsModelSelection = false;
      if (helpOutput.includes('--model') || helpOutput.includes('-m ')) {
        supportsModelSelection = true;
        features.push('model_selection');
        
        // Try to detect available models
        const modelPatterns = [
          /(?:model|models?):\s*([^\n]+)/gi,
          /available.*models?:\s*([^\n]+)/gi,
          /(?:-m|--model)\s+(?:\w+\s+)*\{([^}]+)\}/gi
        ];
        
        for (const pattern of modelPatterns) {
          const matches = helpOutput.matchAll(pattern);
          for (const match of matches) {
            if (match[1]) {
              const models = match[1]
                .split(/[,|\s]+/)
                .map(m => m.trim())
                .filter(m => m.length > 0 && !['or', 'and', '{', '}'].includes(m));
              availableModels.push(...models);
            }
          }
        }
        
        // Remove duplicates and common non-model words
        availableModels = [...new Set(availableModels)]
          .filter(model => !['default', 'latest', 'available', 'options'].includes(model.toLowerCase()));
      }

      // Test 5: Check for workspace/directory mode
      let supportsWorkspaceMode = false;
      if (helpOutput.includes('--workspace') || helpOutput.includes('--directory') || helpOutput.includes('--cwd')) {
        supportsWorkspaceMode = true;
        features.push('workspace_mode');
      }

      // Test 6: Check for file operation support
      let supportsFileOperations = false;
      const filePatterns = ['--file', '--read', '--write', '--edit'];
      if (filePatterns.some(pattern => helpOutput.includes(pattern))) {
        supportsFileOperations = true;
        features.push('file_operations');
      }

      // Test 7: Check for plan API support
      let supportsPlanApi = false;
      const planPatterns = ['plan', 'planning', '--plan', 'task'];
      if (planPatterns.some(pattern => helpOutput.toLowerCase().includes(pattern))) {
        supportsPlanApi = true;
        features.push('plan_api');
      }

      // Test 8: Estimate max tokens (heuristic based on version/help)
      let maxTokens: number | undefined;
      const tokenMatch = helpOutput.match(/(?:max|token|tokens?)[^\d]*(\d{3,})/i);
      if (tokenMatch) {
        maxTokens = parseInt(tokenMatch[1]);
        features.push('token_limits');
      }

      // Set streaming to false since we're using exec mode
      const supportsStreaming = false;

      this.capabilities = {
        supportsJson,
        supportsStreaming,
        supportsPlanApi,
        supportsModelSelection,
        supportsWorkspaceMode,
        supportsFileOperations,
        maxTokens,
        availableModels,
        version,
        features
      };

      this.logger.info('Detected Codex capabilities', {
        sessionId: this.sessionId,
        capabilities: this.capabilities,
        detectedFeatures: features.length,
        availableModelsCount: availableModels.length
      });

    } catch (error: any) {
      // Create error context for structured logging  
      const errorContext = createErrorContext(
        this.sessionId,
        undefined,
        this.workingDirectory,
        undefined,
        'capability_detection',
        { phase: 'version_detection' }
      );

      const categorizedError = categorizeError(error, errorContext, ErrorCategory.CODEX_CLI);
      
      this.logger.logError(categorizedError, {
        sessionId: this.sessionId,
        phase: 'capability_detection'
      });
      
      // Fallback capabilities
      this.capabilities = {
        supportsJson: false,
        supportsStreaming: false,
        supportsPlanApi: false,
        supportsModelSelection: false,
        supportsWorkspaceMode: false,
        supportsFileOperations: false,
        availableModels: [],
        version: 'unknown',
        features: []
      };
    }
  }
}