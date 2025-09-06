/**
 * Enhanced structured logging system for Codex MCP Server
 * Provides context-aware logging with error categorization
 */

import winston from 'winston';
import { ErrorCategory, ErrorSeverity, ErrorContext, CategorizedError } from './error-types.js';

export interface LogContext extends ErrorContext {
  duration?: number;
  success?: boolean;
  retryCount?: number;
  metadata?: Record<string, any>;
}

export interface MCPRequestContext {
  toolName: string;
  requestId: string;
  sessionId?: string;
  parameters: Record<string, any>;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  success: boolean;
  errorCategory?: ErrorCategory;
  errorCode?: string;
}

export class StructuredLogger {
  private logger: winston.Logger;
  private defaultContext: Partial<LogContext>;

  constructor(level: string = 'info', defaultContext: Partial<LogContext> = {}) {
    this.defaultContext = defaultContext;
    
    this.logger = winston.createLogger({
      level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const logEntry = {
            timestamp,
            level,
            message,
            ...meta
          };
          return JSON.stringify(logEntry, null, 2);
        })
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });
  }

  /**
   * Log with structured context
   */
  logWithContext(
    level: string,
    message: string,
    context: Partial<LogContext> = {},
    errorCategory?: ErrorCategory,
    errorCode?: string
  ) {
    const fullContext = {
      ...this.defaultContext,
      ...context,
      errorCategory,
      errorCode
    };

    this.logger.log(level, message, fullContext);
  }

  /**
   * Log error with automatic categorization
   */
  logError(
    error: Error | CategorizedError,
    context: Partial<LogContext> = {},
    category?: ErrorCategory,
    severity?: ErrorSeverity
  ) {
    let errorCategory: ErrorCategory;
    let errorSeverity: ErrorSeverity;
    let errorCode: string | undefined;

    // Check if it's already a categorized error
    if ('category' in error && 'severity' in error) {
      const categorized = error as CategorizedError;
      errorCategory = categorized.category;
      errorSeverity = categorized.severity;
      errorCode = categorized.code;
    } else {
      // Auto-categorize based on error message and type
      errorCategory = category || this.categorizeError(error);
      errorSeverity = severity || this.determineSeverity(error, errorCategory);
    }

    const fullContext = {
      ...this.defaultContext,
      ...context,
      errorCategory,
      errorSeverity,
      errorCode,
      errorName: error.name,
      errorStack: error.stack,
      originalError: 'originalError' in error ? error.originalError : undefined
    };

    this.logger.error(error.message, fullContext);
  }

  /**
   * Log session events with context
   */
  logSessionEvent(
    sessionId: string,
    event: 'created' | 'destroyed' | 'error' | 'timeout' | 'restart',
    data: Record<string, any> = {}
  ) {
    this.logWithContext('info', `Session ${event}`, {
      sessionId,
      eventType: 'session',
      event,
      ...data
    });
  }

  /**
   * Log MCP request with timing and success metrics
   */
  logMCPRequest(requestContext: MCPRequestContext) {
    const { toolName, success, errorCategory, errorCode } = requestContext;
    
    const level = success ? 'info' : 'error';
    const message = `MCP ${toolName} ${success ? 'completed' : 'failed'}`;
    
    this.logWithContext(level, message, {
      ...requestContext,
      eventType: 'mcp_request'
    }, errorCategory, errorCode);
  }

  /**
   * Log performance metrics
   */
  logPerformance(
    operation: string,
    duration: number,
    context: Partial<LogContext> = {}
  ) {
    this.logWithContext('debug', `Performance: ${operation}`, {
      ...context,
      eventType: 'performance',
      operation,
      duration,
      performanceThreshold: duration > 1000 ? 'slow' : 'normal'
    });
  }

  /**
   * Log recovery attempts
   */
  logRecovery(
    sessionId: string,
    recoveryType: 'retry' | 'restart' | 'failover',
    attempt: number,
    success: boolean,
    context: Partial<LogContext> = {}
  ) {
    const level = success ? 'info' : 'warn';
    const message = `Recovery ${recoveryType} attempt ${attempt} ${success ? 'succeeded' : 'failed'}`;
    
    this.logWithContext(level, message, {
      ...context,
      sessionId,
      eventType: 'recovery',
      recoveryType,
      attempt,
      success
    });
  }

  /**
   * Standard winston logger methods with context injection
   */
  info(message: string, context: Partial<LogContext> = {}) {
    this.logWithContext('info', message, context);
  }

  warn(message: string, context: Partial<LogContext> = {}) {
    this.logWithContext('warn', message, context);
  }

  error(message: string, context: Partial<LogContext> = {}) {
    this.logWithContext('error', message, context);
  }

  debug(message: string, context: Partial<LogContext> = {}) {
    this.logWithContext('debug', message, context);
  }

  /**
   * Auto-categorize errors based on message patterns
   */
  private categorizeError(error: Error): ErrorCategory {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    // Codex CLI errors
    if (message.includes('codex') && (message.includes('not found') || message.includes('command not found'))) {
      return ErrorCategory.CODEX_CLI;
    }
    if (message.includes('timeout') || message.includes('timed out')) {
      return ErrorCategory.TIMEOUT;
    }
    if (message.includes('permission') || message.includes('unauthorized') || message.includes('forbidden')) {
      return ErrorCategory.AUTHENTICATION;
    }

    // Session errors
    if (message.includes('session') || message.includes('process')) {
      return ErrorCategory.SESSION_MANAGEMENT;
    }

    // MCP errors
    if (message.includes('mcp') || message.includes('protocol') || name.includes('mcp')) {
      return ErrorCategory.MCP_PROTOCOL;
    }

    // Validation errors
    if (name.includes('validation') || message.includes('invalid') || message.includes('required')) {
      return ErrorCategory.VALIDATION;
    }

    // Resource errors
    if (message.includes('file') || message.includes('directory') || message.includes('enoent') || 
        message.includes('eacces') || message.includes('emfile') || message.includes('enomem')) {
      return ErrorCategory.RESOURCE;
    }

    // Default to system error
    return ErrorCategory.SYSTEM;
  }

  /**
   * Determine error severity based on category and context
   */
  private determineSeverity(error: Error, category: ErrorCategory): ErrorSeverity {
    const message = error.message.toLowerCase();

    // Critical errors that break core functionality
    if (message.includes('fatal') || message.includes('critical') || 
        category === ErrorCategory.AUTHENTICATION && message.includes('failed')) {
      return ErrorSeverity.CRITICAL;
    }

    // High severity errors that affect functionality
    if (category === ErrorCategory.CODEX_CLI || category === ErrorCategory.SESSION_MANAGEMENT ||
        message.includes('failed') || message.includes('error')) {
      return ErrorSeverity.HIGH;
    }

    // Medium severity for recoverable issues
    if (category === ErrorCategory.TIMEOUT || category === ErrorCategory.VALIDATION ||
        message.includes('timeout') || message.includes('retry')) {
      return ErrorSeverity.MEDIUM;
    }

    // Low severity for minor issues
    return ErrorSeverity.LOW;
  }
}

// Export default logger instance
export const logger = new StructuredLogger(
  process.env.LOG_LEVEL || 'info',
  {
    service: 'codex-mcp',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  }
);