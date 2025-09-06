/**
 * Error mapping and categorization utilities
 * Provides functions to automatically categorize and handle errors
 */

import { ErrorCategory, ErrorSeverity, ErrorContext, CodexError, ERROR_CODES, ErrorCode } from './error-types.js';

export interface ErrorMapping {
  pattern: RegExp | string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  code: ErrorCode;
  recoverable: boolean;
  retryAfter?: number;
}

// Predefined error mappings for automatic categorization
export const ERROR_MAPPINGS: ErrorMapping[] = [
  // Codex CLI specific errors
  {
    pattern: /codex.*not found|command not found.*codex/i,
    category: ErrorCategory.CODEX_CLI,
    severity: ErrorSeverity.CRITICAL,
    code: ERROR_CODES.CODEX_NOT_FOUND,
    recoverable: false
  },
  {
    pattern: /codex.*timeout|timed out.*codex|Request timed out/i,
    category: ErrorCategory.CODEX_CLI,
    severity: ErrorSeverity.HIGH,
    code: ERROR_CODES.CODEX_TIMEOUT,
    recoverable: true,
    retryAfter: 5000
  },
  {
    pattern: /codex.*failed|Command failed.*codex|spawn.*codex.*ENOENT/i,
    category: ErrorCategory.CODEX_CLI,
    severity: ErrorSeverity.HIGH,
    code: ERROR_CODES.CODEX_COMMAND_FAILED,
    recoverable: true,
    retryAfter: 1000
  },
  {
    pattern: /authentication.*failed|unauthorized|forbidden/i,
    category: ErrorCategory.AUTHENTICATION,
    severity: ErrorSeverity.CRITICAL,
    code: ERROR_CODES.CODEX_AUTH_FAILED,
    recoverable: false
  },
  {
    pattern: /rate.*limit|too many requests/i,
    category: ErrorCategory.CODEX_CLI,
    severity: ErrorSeverity.MEDIUM,
    code: ERROR_CODES.CODEX_RATE_LIMITED,
    recoverable: true,
    retryAfter: 60000
  },

  // Session management errors
  {
    pattern: /session.*not found|Session.*not found/i,
    category: ErrorCategory.SESSION_MANAGEMENT,
    severity: ErrorSeverity.MEDIUM,
    code: ERROR_CODES.SESSION_NOT_FOUND,
    recoverable: true
  },
  {
    pattern: /failed to create session|session creation failed/i,
    category: ErrorCategory.SESSION_MANAGEMENT,
    severity: ErrorSeverity.HIGH,
    code: ERROR_CODES.SESSION_CREATION_FAILED,
    recoverable: true,
    retryAfter: 2000
  },
  {
    pattern: /session.*timeout|session.*timed out/i,
    category: ErrorCategory.SESSION_MANAGEMENT,
    severity: ErrorSeverity.MEDIUM,
    code: ERROR_CODES.SESSION_TIMEOUT,
    recoverable: true,
    retryAfter: 3000
  },
  {
    pattern: /max.*sessions|too many sessions/i,
    category: ErrorCategory.SESSION_MANAGEMENT,
    severity: ErrorSeverity.HIGH,
    code: ERROR_CODES.MAX_SESSIONS_EXCEEDED,
    recoverable: true,
    retryAfter: 10000
  },

  // MCP protocol errors
  {
    pattern: /invalid.*request|malformed.*request/i,
    category: ErrorCategory.MCP_PROTOCOL,
    severity: ErrorSeverity.MEDIUM,
    code: ERROR_CODES.MCP_INVALID_REQUEST,
    recoverable: false
  },
  {
    pattern: /tool.*not found|unknown tool/i,
    category: ErrorCategory.MCP_PROTOCOL,
    severity: ErrorSeverity.MEDIUM,
    code: ERROR_CODES.MCP_TOOL_NOT_FOUND,
    recoverable: false
  },
  {
    pattern: /response.*too large|payload.*too large/i,
    category: ErrorCategory.MCP_PROTOCOL,
    severity: ErrorSeverity.MEDIUM,
    code: ERROR_CODES.MCP_RESPONSE_TOO_LARGE,
    recoverable: true
  },

  // Validation errors
  {
    pattern: /validation.*failed|invalid.*parameter|missing.*required/i,
    category: ErrorCategory.VALIDATION,
    severity: ErrorSeverity.LOW,
    code: ERROR_CODES.INVALID_PARAMETERS,
    recoverable: false
  },
  {
    pattern: /required.*field|missing.*required/i,
    category: ErrorCategory.VALIDATION,
    severity: ErrorSeverity.LOW,
    code: ERROR_CODES.MISSING_REQUIRED_FIELD,
    recoverable: false
  },

  // Resource errors
  {
    pattern: /ENOENT|file.*not found|directory.*not found/i,
    category: ErrorCategory.RESOURCE,
    severity: ErrorSeverity.MEDIUM,
    code: ERROR_CODES.FILE_NOT_FOUND,
    recoverable: false
  },
  {
    pattern: /EACCES|permission denied|access denied/i,
    category: ErrorCategory.RESOURCE,
    severity: ErrorSeverity.HIGH,
    code: ERROR_CODES.PERMISSION_DENIED,
    recoverable: false
  },
  {
    pattern: /ENOSPC|no space left|disk.*full/i,
    category: ErrorCategory.RESOURCE,
    severity: ErrorSeverity.CRITICAL,
    code: ERROR_CODES.DISK_SPACE_FULL,
    recoverable: false
  },
  {
    pattern: /ENOMEM|out of memory|memory.*exceeded/i,
    category: ErrorCategory.RESOURCE,
    severity: ErrorSeverity.CRITICAL,
    code: ERROR_CODES.MEMORY_EXCEEDED,
    recoverable: true,
    retryAfter: 30000
  }
];

/**
 * Create a categorized error from a standard Error
 */
export function categorizeError(
  error: Error,
  context: ErrorContext,
  fallbackCategory: ErrorCategory = ErrorCategory.SYSTEM
): CodexError {
  // Check if it's already a CodexError
  if (error instanceof CodexError) {
    return error;
  }

  // Find matching error mapping
  const mapping = findErrorMapping(error);
  
  if (mapping) {
    return new CodexError(
      error.message,
      mapping.category,
      mapping.severity,
      mapping.code,
      context,
      error,
      mapping.recoverable,
      mapping.retryAfter
    );
  }

  // Fallback categorization
  const category = fallbackCategory;
  const severity = determineFallbackSeverity(error);
  const code = ERROR_CODES.UNEXPECTED_ERROR;

  return new CodexError(
    error.message,
    category,
    severity,
    code,
    context,
    error,
    false
  );
}

/**
 * Find error mapping for a given error
 */
export function findErrorMapping(error: Error): ErrorMapping | null {
  const message = error.message;
  const name = error.name;
  const fullText = `${name}: ${message}`;

  for (const mapping of ERROR_MAPPINGS) {
    if (typeof mapping.pattern === 'string') {
      if (fullText.toLowerCase().includes(mapping.pattern.toLowerCase())) {
        return mapping;
      }
    } else {
      if (mapping.pattern.test(fullText)) {
        return mapping;
      }
    }
  }

  return null;
}

/**
 * Determine if an error is recoverable
 */
export function isRecoverable(error: Error | CodexError): boolean {
  if (error instanceof CodexError) {
    return error.recoverable;
  }

  const mapping = findErrorMapping(error);
  return mapping?.recoverable ?? false;
}

/**
 * Get retry delay for a recoverable error
 */
export function getRetryDelay(error: Error | CodexError, attempt: number = 1): number {
  let baseDelay: number;

  if (error instanceof CodexError && error.retryAfter) {
    baseDelay = error.retryAfter;
  } else {
    const mapping = findErrorMapping(error);
    baseDelay = mapping?.retryAfter ?? 1000;
  }

  // Exponential backoff with jitter
  const backoffMultiplier = Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.1; // 10% jitter
  
  return Math.min(baseDelay * backoffMultiplier * (1 + jitter), 30000); // Max 30 seconds
}

/**
 * Create error context from available information
 */
export function createErrorContext(
  sessionId?: string,
  workspaceId?: string,
  workspacePath?: string,
  requestId?: string,
  toolName?: string,
  additionalContext?: Record<string, any>
): ErrorContext {
  return {
    sessionId,
    workspaceId,
    workspacePath,
    requestId,
    toolName,
    timestamp: new Date(),
    ...additionalContext
  };
}

/**
 * Extract error information for logging
 */
export function extractErrorInfo(error: Error | CodexError) {
  const info: any = {
    name: error.name,
    message: error.message,
    stack: error.stack
  };

  if (error instanceof CodexError) {
    info.category = error.category;
    info.severity = error.severity;
    info.code = error.code;
    info.recoverable = error.recoverable;
    info.retryAfter = error.retryAfter;
    info.context = error.context;
    
    if (error.originalError) {
      info.originalError = {
        name: error.originalError.name,
        message: error.originalError.message,
        stack: error.originalError.stack
      };
    }
  }

  return info;
}

/**
 * Determine fallback severity for uncategorized errors
 */
function determineFallbackSeverity(error: Error): ErrorSeverity {
  const message = error.message.toLowerCase();

  if (message.includes('critical') || message.includes('fatal')) {
    return ErrorSeverity.CRITICAL;
  }
  if (message.includes('error') || message.includes('failed')) {
    return ErrorSeverity.HIGH;
  }
  if (message.includes('warning') || message.includes('timeout')) {
    return ErrorSeverity.MEDIUM;
  }

  return ErrorSeverity.LOW;
}