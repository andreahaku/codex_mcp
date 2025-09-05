import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CodexResponse {
  text: string;
  success: boolean;
  error?: string;
}

export class CodexClient {
  private workingDirectory: string;

  constructor(workingDirectory = process.cwd()) {
    this.workingDirectory = workingDirectory;
  }

  async createResponse(params: {
    input: string | any[];
    instructions?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
  }): Promise<CodexResponse> {
    try {
      // Build the prompt from input
      let prompt = '';
      
      if (typeof params.input === 'string') {
        prompt = params.input;
      } else if (Array.isArray(params.input)) {
        // Convert message format to simple text
        prompt = params.input
          .filter(msg => msg && msg.content)
          .map(msg => {
            if (typeof msg.content === 'string') {
              return `${msg.role}: ${msg.content}`;
            } else if (Array.isArray(msg.content)) {
              const textParts = msg.content
                .filter((c: any) => c.type === 'input_text' || c.type === 'text')
                .map((c: any) => c.text || c.content);
              return `${msg.role}: ${textParts.join('\n')}`;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n\n');
      }

      // Add instructions if provided
      if (params.instructions) {
        prompt = `Instructions: ${params.instructions}\n\n${prompt}`;
      }

      // Build codex command
      const args = ['exec'];
      
      // Add model if specified
      if (params.model) {
        args.push('--model', params.model);
      }

      // Use full-auto mode for non-interactive execution
      args.push('--full-auto');
      
      // Skip git repo check for programmatic usage
      args.push('--skip-git-repo-check');

      // Add the prompt
      args.push(prompt);

      // Execute codex command
      const result = await this.execCodex(args);
      
      return {
        text: result.stdout.trim(),
        success: true
      };

    } catch (error: any) {
      return {
        text: '',
        success: false,
        error: error.message || 'Failed to execute Codex CLI'
      };
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      // Test if codex is available and working
      const result = await this.execCodex(['--help']);
      return result.stdout.includes('codex') || result.stdout.includes('Usage:');
    } catch (error) {
      console.error('Codex CLI connection test failed:', error);
      return false;
    }
  }

  private async execCodex(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const command = 'codex';
    const fullCommand = `${command} ${args.map(arg => 
      arg.includes(' ') ? `"${arg.replace(/"/g, '\\"')}"` : arg
    ).join(' ')}`;

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        cwd: this.workingDirectory,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 120000 // 2 minutes timeout
      });

      return { stdout, stderr };
    } catch (error: any) {
      throw new Error(`Codex CLI error: ${error.message}`);
    }
  }
}