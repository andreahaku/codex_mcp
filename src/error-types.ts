/**
 * Error categorization and type system for Codex MCP Server
 * Provides structured error handling with automatic categorization
 */

export enum ErrorCategory {
  CODEX_CLI = 'codex_cli',
  SESSION_MANAGEMENT = 'session_management',
  MCP_PROTOCOL = 'mcp_protocol',
  VALIDATION = 'validation',
  RESOURCE = 'resource',
  TIMEOUT = 'timeout',
  AUTHENTICATION = 'authentication',
  SYSTEM = 'system'
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

export interface ErrorContext {
  sessionId?: string;
  workspaceId?: string;
  workspacePath?: string;
  requestId?: string;
  toolName?: string;
  userId?: string;
  timestamp: Date;
  [key: string]: any;
}

export interface CategorizedError extends Error {
  category: ErrorCategory;
  severity: ErrorSeverity;
  code: string;
  context: ErrorContext;
  originalError?: Error;
  recoverable: boolean;
  retryAfter?: number; // milliseconds
}

export class CodexError extends Error implements CategorizedError {
  public readonly category: ErrorCategory;
  public readonly severity: ErrorSeverity;
  public readonly code: string;
  public readonly context: ErrorContext;
  public readonly originalError?: Error;
  public readonly recoverable: boolean;
  public readonly retryAfter?: number;

  constructor(
    message: string,
    category: ErrorCategory,
    severity: ErrorSeverity,
    code: string,
    context: ErrorContext,
    originalError?: Error,
    recoverable: boolean = false,
    retryAfter?: number
  ) {
    super(message);
    this.name = 'CodexError';
    this.category = category;
    this.severity = severity;
    this.code = code;
    this.context = context;
    this.originalError = originalError;
    this.recoverable = recoverable;
    this.retryAfter = retryAfter;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CodexError);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      severity: this.severity,
      code: this.code,
      context: this.context,
      recoverable: this.recoverable,
      retryAfter: this.retryAfter,
      stack: this.stack,
      originalError: this.originalError ? {
        name: this.originalError.name,
        message: this.originalError.message,
        stack: this.originalError.stack
      } : undefined
    };
  }
}

// Predefined error codes for common scenarios
export const ERROR_CODES = {
  // Codex CLI errors
  CODEX_NOT_FOUND: 'CODEX_001',
  CODEX_TIMEOUT: 'CODEX_002', 
  CODEX_COMMAND_FAILED: 'CODEX_003',
  CODEX_AUTH_FAILED: 'CODEX_004',
  CODEX_RATE_LIMITED: 'CODEX_005',
  
  // Session management errors
  SESSION_NOT_FOUND: 'SESSION_001',
  SESSION_CREATION_FAILED: 'SESSION_002',
  SESSION_TIMEOUT: 'SESSION_003',
  SESSION_TERMINATED: 'SESSION_004',
  MAX_SESSIONS_EXCEEDED: 'SESSION_005',
  
  // MCP protocol errors
  MCP_INVALID_REQUEST: 'MCP_001',
  MCP_TOOL_NOT_FOUND: 'MCP_002',
  MCP_RESPONSE_TOO_LARGE: 'MCP_003',
  MCP_SERIALIZATION_ERROR: 'MCP_004',
  
  // Validation errors
  INVALID_PARAMETERS: 'VALIDATION_001',
  MISSING_REQUIRED_FIELD: 'VALIDATION_002',
  PARAMETER_OUT_OF_RANGE: 'VALIDATION_003',
  
  // Resource errors
  FILE_NOT_FOUND: 'RESOURCE_001',
  PERMISSION_DENIED: 'RESOURCE_002',
  DISK_SPACE_FULL: 'RESOURCE_003',
  MEMORY_EXCEEDED: 'RESOURCE_004',
  
  // System errors
  UNEXPECTED_ERROR: 'SYSTEM_001',
  INITIALIZATION_FAILED: 'SYSTEM_002',
  SHUTDOWN_ERROR: 'SYSTEM_003'
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];