#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import dotenv from 'dotenv';

import { CodexClient } from './codex-client.js';
import { ConversationManager } from './conversation.js';
import { SessionManager } from './session-manager.js';
import { chunkResponse, formatPaginatedResponse, estimateTokens } from './token-utils.js';
import { logger as structuredLogger } from './logger.js';
import { categorizeError, createErrorContext } from './error-utils.js';
import { ErrorCategory } from './error-types.js';

// Load environment variables
dotenv.config();

// Use structured logger from logger.js
const logger = structuredLogger;

// Initialize components
const codexClient = new CodexClient();
const sessionManager = new SessionManager(logger);
const conversationManager = new ConversationManager(
  parseInt(process.env.MAX_CONVERSATIONS || '50'),
  parseInt(process.env.MAX_CONVERSATION_HISTORY || '100')
);

// Response cache for pagination (TTL: 10 minutes)
const responseCache = new Map<string, { response: string; timestamp: number; ttl: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function cleanExpiredCache() {
  const now = Date.now();
  for (const [key, entry] of responseCache.entries()) {
    if (now - entry.timestamp > entry.ttl) {
      responseCache.delete(key);
    }
  }
}

function getCacheKey(prompt: string, context?: string, model?: string): string {
  const content = `${prompt}|${context || ''}|${model || ''}`;
  // Simple hash for cache key
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `codex_${Math.abs(hash).toString(36)}`;
}

// Define tool schemas with pagination support
const AskSchema = z.object({
  prompt: z.string().describe('Prompt text'),
  context: z.string().optional().describe('Additional context'),
  model: z.string().optional().describe('Model (e.g., "o3", "gpt-5")'),
  temp: z.number().min(0).max(2).default(0.7).describe('Temperature'),
  page: z.number().int().min(1).default(1).describe('Page number (def: 1)'),
  max_tok: z.number().int().min(5000).max(20000).default(18000).describe('Max tokens/page (def: 18000)'),
  sid: z.string().optional().describe('Session ID (auto-gen if omitted)'),
  ws: z.string().optional().describe('Workspace path (def: cwd)'),
  streaming: z.boolean().default(false).describe('Enable streaming')
});

const ChatStartSchema = z.object({
  topic: z.string().describe('Conversation topic'),
  instructions: z.string().optional().describe('System instructions'),
  sid: z.string().optional().describe('Session ID to link')
});

const ChatMsgSchema = z.object({
  sid: z.string().describe('Session ID'),
  message: z.string().describe('Message text')
});

const CancelSchema = z.object({
  sid: z.string().describe('Session ID'),
  force: z.boolean().default(false).describe('Force kill process')
});

const StatusSchema = z.object({
  sid: z.string().optional().describe('Session ID (optional - checks all)')
});

const RestartSchema = z.object({
  sid: z.string().describe('Session ID')
});

// Consolidated Plan Tool
const PlanSchema = z.object({
  sid: z.string().describe('Session ID'),
  updates: z.string().optional().describe('Plan updates (omit to view current)')
});

// Consolidated Patch Tool
const PatchSchema = z.object({
  sid: z.string().describe('Session ID'),
  file: z.string().optional().describe('Specific file (optional)'),
  apply: z.boolean().default(false).describe('Apply changes (def: false=preview)')
});

// Create MCP server
const server = new Server(
  {
    name: 'codex-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper function to process MCP resources into text content
async function processResources(meta?: any): Promise<string> {
  if (!meta) return '';
  
  let resourceContent = '';
  
  try {
    // Handle different ways resources might be passed
    if (meta.resources && Array.isArray(meta.resources)) {
      for (const resource of meta.resources) {
        if (resource.text) {
          const header = `\n--- Resource: ${resource.name || resource.uri || 'file'} ---\n`;
          const footer = '\n--- End Resource ---\n';
          resourceContent += header + resource.text + footer;
        } else if (resource.content) {
          const header = `\n--- Resource: ${resource.name || resource.uri || 'file'} ---\n`;
          const footer = '\n--- End Resource ---\n';
          resourceContent += header + resource.content + footer;
        } else if (resource.uri) {
          resourceContent += `\n--- File Reference: ${resource.uri} ---\n`;
        }
      }
    }
    
    // Handle content array format (common in MCP)
    if (meta.content && Array.isArray(meta.content)) {
      for (const item of meta.content) {
        if (item.type === 'text' && item.text) {
          const header = `\n--- Attached Content ---\n`;
          const footer = '\n--- End Content ---\n';
          resourceContent += header + item.text + footer;
        } else if (item.type === 'resource' && item.resource) {
          const res = item.resource;
          const header = `\n--- Resource: ${res.name || res.uri || 'file'} ---\n`;
          const footer = '\n--- End Resource ---\n';
          if (res.text) {
            resourceContent += header + res.text + footer;
          } else if (res.content) {
            resourceContent += header + res.content + footer;
          }
        }
      }
    }
    
    // Fallback: check if meta itself has content
    if (!resourceContent && meta.text) {
      const header = `\n--- Attached Content ---\n`;
      const footer = `\n--- End Content ---\n`;
      resourceContent = header + meta.text + footer;
    }
    
  } catch (error) {
    logger.warn('Error processing resources:', { error: error instanceof Error ? error.message : String(error) });
  }
  
  return resourceContent;
}

// Tool handlers
async function handleAsk(args: any, meta?: any): Promise<any> {
  const params = AskSchema.parse(args);
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;

  try {
    // Generate session ID if not provided
    const sessionId = params.sid || `session_${requestId}`;
    const workspacePath = params.ws || process.cwd();

    // Auto-create conversation if session doesn't exist in conversation manager
    if (!conversationManager.getConversation(sessionId)) {
      conversationManager.startConversationWithId(
        sessionId,
        `Codex Session: ${sessionId}`,
        `Codex session for ${workspacePath}`
      );
    }
    
    // Clean expired cache entries periodically
    if (responseCache.size > 0 && Math.random() < 0.1) {
      cleanExpiredCache();
    }

    // Process any attached resources
    const resourceContent = await processResources(meta);
    
    // Build input with resources
    let input = params.prompt;
    
    if (resourceContent) {
      input = `Attached Files/Resources:\n${resourceContent}\n\n`;
      
      if (params.context) {
        input += `Context:\n${params.context}\n\nRequest:\n${params.prompt}`;
      } else {
        input += `Request:\n${params.prompt}`;
      }
    } else if (params.context) {
      input = `Context:\n${params.context}\n\nRequest:\n${params.prompt}`;
    }

    // Generate cache key for this request (excluding page number)
    const cacheKey = getCacheKey(params.prompt + sessionId, params.context, params.model);
    let fullResponse: string;

    // Check cache first (only for page 1 or if we have a cached response)
    const cachedEntry = responseCache.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp) < cachedEntry.ttl) {
      fullResponse = cachedEntry.response;
      logger.info(`Using cached response for page ${params.page}`, { requestId, cacheKey, sessionId });
    } else {
      // Only call Codex for page 1 or if not cached
      if (params.page === 1 || !cachedEntry) {
        logger.info(`Calling Codex via session manager`, { 
          requestId, 
          sessionId,
          workspacePath,
          model: params.model,
          streaming: params.streaming
        });
        
        // Build command args
        const commandArgs = ['exec'];
        if (params.model) {
          commandArgs.push('--model', params.model);
        }
        if (params.temp !== undefined && params.temp !== 0.7) {
          commandArgs.push('--temperature', params.temp.toString());
        }
        commandArgs.push('--full-auto', '--skip-git-repo-check');
        commandArgs.push(input);

        // Collection for streaming events
        const streamingEvents: any[] = [];

        // Send command through session manager
        const response = await sessionManager.sendCommand(
          sessionId,
          {
            args: commandArgs,
            input,
            timeout: 120000
          },
          workspacePath,
          params.streaming ? (event) => {
            streamingEvents.push(event);
            logger.debug('Streaming event', {
              requestId,
              sessionId,
              eventType: event.type,
              timestamp: event.timestamp
            });
          } : undefined
        );

        if (!response.success) {
          return {
            type: 'text',
            text: `❌ Error: ${response.error || 'Failed to consult Codex'}\n\nSession: ${sessionId}`
          };
        }

        fullResponse = response.text;
        
        // Include streaming events in response if enabled
        if (params.streaming && streamingEvents.length > 0) {
          const streamingInfo = streamingEvents
            .filter(e => e.type === 'thinking' || e.type === 'progress')
            .map(e => `[${e.type.toUpperCase()}] ${e.data.text || JSON.stringify(e.data)}`)
            .join('\n');
          
          if (streamingInfo) {
            fullResponse = `${streamingInfo}\n\n---\n\n${fullResponse}`;
          }
        }
        
        // Cache the full response
        responseCache.set(cacheKey, {
          response: fullResponse,
          timestamp: Date.now(),
          ttl: CACHE_TTL
        });
        
        logger.info(`Cached response`, { 
          requestId, 
          sessionId,
          cacheKey, 
          responseLength: fullResponse.length,
          estimatedTokens: estimateTokens(fullResponse).estimatedTokens,
          streamingEvents: streamingEvents.length
        });
      } else {
        return {
          type: 'text',
          text: `❌ Error: Page ${params.page} requested but no cached response available. Please start with page 1.\n\nSession: ${sessionId}`
        };
      }
    }

    // Chunk the response for pagination
    const chunk = chunkResponse(fullResponse, params.max_tok, params.page);
    const paginatedText = formatPaginatedResponse(chunk, fullResponse, requestId);

    logger.info(`Returning paginated response`, {
      requestId,
      sessionId,
      page: params.page,
      totalPages: chunk.totalChunks,
      chunkTokens: chunk.tokenEstimate.estimatedTokens,
      totalTokens: estimateTokens(fullResponse).estimatedTokens
    });

    // Return in proper MCP format with session info
    const responseText = `${paginatedText}\n\n---\n💡 Session: \`${sessionId}\` | Workspace: \`${workspacePath}\``;
    
    return {
      type: 'text',
      text: responseText
    };
  } catch (error: any) {
    logger.error('Error consulting Codex:', error);
    return {
      type: 'text',
      text: `❌ Error: ${error.message || 'Failed to consult Codex'}\n\nRequest ID: ${requestId}`
    };
  }
}

async function handleChatStart(args: any): Promise<any> {
  const params = ChatStartSchema.parse(args);

  try {
    // Use provided sid or generate a new one
    const conversationId = params.sid || conversationManager.startConversation(
      params.topic,
      params.instructions
    );

    // If sid was provided, create or link the conversation
    if (params.sid) {
      // Try to get existing conversation, or create new one with provided ID
      let conversation = conversationManager.getConversation(params.sid);
      if (!conversation) {
        // Create new conversation with the provided ID
        conversationManager.startConversationWithId(
          params.sid,
          params.topic,
          params.instructions
        );
      }
    }

    return {
      type: 'text',
      text: `✅ Started conversation: ${conversationId}\nTopic: ${params.topic}`
    };
  } catch (error: any) {
    logger.error('Error starting conversation:', error);
    return {
      type: 'text',
      text: `❌ Error starting conversation: ${error.message || 'Failed to start conversation'}`
    };
  }
}

async function handleChatMsg(args: any): Promise<any> {
  const params = ChatMsgSchema.parse(args);

  try {
    // Get conversation context
    const conversation = conversationManager.getConversation(params.sid);
    if (!conversation) {
      return { type: 'text', text: `❌ Conversation not found: ${params.sid}` };
    }

    // Add user message
    conversationManager.addMessage(params.sid, 'user', params.message);

    // Get formatted messages for API with context limit
    const contextLimit = parseInt(process.env.MAX_CONVERSATION_CONTEXT || '10');
    const messages = conversationManager.formatForAPI(params.sid, undefined, contextLimit);
    const instructions = conversationManager.getInstructions(params.sid);

    // Format input for Codex - combine conversation history
    const conversationText = messages.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n\n');
    const finalInput = instructions ? `${instructions}\n\n${conversationText}` : conversationText;

    // Use session manager to send command (reusing the session)
    const response = await sessionManager.sendCommand(
      params.sid,
      {
        args: ['exec', '--full-auto', '--skip-git-repo-check', finalInput],
        input: finalInput,
        timeout: 120000
      }
    );

    if (!response.success) {
      return {
        type: 'text',
        text: `❌ Error continuing conversation: ${response.error || 'Failed to get response'}`
      };
    }

    // Add assistant response to conversation
    conversationManager.addMessage(params.sid, 'assistant', response.text);

    return {
      type: 'text',
      text: `${response.text}\n\n---\n💬 Conversation: ${params.sid}`
    };
  } catch (error: any) {
    logger.error('Error continuing conversation:', error);
    return {
      type: 'text',
      text: `❌ Error continuing conversation ${params.sid}: ${error.message || 'Unknown error'}`
    };
  }
}

async function handleCancel(args: any): Promise<any> {
  const params = CancelSchema.parse(args);

  try {
    logger.info('Cancelling session operations', { sessionId: params.sid, force: params.force });

    if (params.force) {
      await sessionManager.destroySession(params.sid);
      return {
        type: 'text',
        text: `🛑 Session ${params.sid} forcefully terminated.`
      };
    } else {
      await sessionManager.restart(params.sid);
      return {
        type: 'text',
        text: `⚡ Session ${params.sid} restarted.`
      };
    }
  } catch (error: any) {
    logger.error('Error cancelling request:', error);
    return {
      type: 'text',
      text: `❌ Failed to cancel session ${params.sid}: ${error.message}`
    };
  }
}

async function handleStatus(args: any): Promise<any> {
  const params = StatusSchema.parse(args);

  try {
    const healthCheck = await sessionManager.healthCheck(params.sid);

    if (params.sid) {
      const session = healthCheck.sessions[0];
      if (!session) {
        return { type: 'text', text: `❌ Session ${params.sid} not found.` };
      }

      const status = session.status === 'ready' ? '✅' :
                    session.status === 'error' ? '❌' :
                    session.status === 'starting' ? '⏳' : '🔄';

      return {
        type: 'text',
        text: `${status} Session: ${session.id}
📂 Workspace: ${session.workspacePath}
📊 Status: ${session.status}
📈 Requests: ${session.requestCount}`
      };
    } else {
      if (healthCheck.sessions.length === 0) {
        return { type: 'text', text: '📭 No active sessions.' };
      }

      const sessionList = healthCheck.sessions.map(session => {
        const status = session.status === 'ready' ? '✅' :
                      session.status === 'error' ? '❌' :
                      session.status === 'starting' ? '⏳' : '🔄';
        return `${status} ${session.id} - ${session.requestCount} requests`;
      }).join('\n');

      return {
        type: 'text',
        text: `Active Sessions (${healthCheck.sessions.length}):\n${sessionList}`
      };
    }
  } catch (error: any) {
    logger.error('Error checking session health:', error);
    return {
      type: 'text',
      text: `❌ Health check failed: ${error.message}`
    };
  }
}

async function handleRestart(args: any): Promise<any> {
  const params = RestartSchema.parse(args);

  try {
    logger.info('Restarting session', { sessionId: params.sid });
    await sessionManager.restart(params.sid);

    return {
      type: 'text',
      text: `🔄 Session ${params.sid} restarted successfully.`
    };
  } catch (error: any) {
    logger.error('Error restarting session:', error);
    return {
      type: 'text',
      text: `❌ Failed to restart session ${params.sid}: ${error.message}`
    };
  }
}

// Consolidated Plan Tool Handler
async function handlePlan(args: any): Promise<any> {
  const params = PlanSchema.parse(args);

  try {
    // If updates provided, update plan; otherwise get current plan
    if (params.updates) {
      logger.info('Updating plan for session', { sessionId: params.sid });
      const planPrompt = `Update the current plan with these modifications: ${params.updates}`;

      const response = await sessionManager.sendCommand(
        params.sid,
        {
          args: ['exec', '--full-auto', '--skip-git-repo-check', planPrompt]
        }
      );

      if (!response.success) {
        return {
          type: 'text',
          text: `❌ Failed to update plan for session ${params.sid}: ${response.error}`
        };
      }

      return {
        type: 'text',
        text: `✅ Plan Updated - Session ${params.sid}\n\n${response.text}`
      };
    } else {
      logger.info('Getting plan from session', { sessionId: params.sid });

      const response = await sessionManager.sendCommand(
        params.sid,
        {
          args: ['exec', '--full-auto', '--skip-git-repo-check', 'show current plan']
        }
      );

      if (!response.success) {
        return {
          type: 'text',
          text: `❌ Failed to get plan: ${response.error}`
        };
      }

      return {
        type: 'text',
        text: `📋 Current Plan - Session ${params.sid}\n\n${response.text}`
      };
    }
  } catch (error: any) {
    logger.error('Error with plan:', error);
    return {
      type: 'text',
      text: `❌ Failed to handle plan: ${error.message}`
    };
  }
}

// Consolidated Patch Tool Handler
async function handlePatch(args: any): Promise<any> {
  const params = PatchSchema.parse(args);

  try {
    if (params.apply) {
      // Apply mode
      logger.info('Applying patch for session', { sessionId: params.sid, file: params.file });

      let applyPrompt = 'Apply the planned changes';
      if (params.file) {
        applyPrompt += ` to ${params.file}`;
      }

      const response = await sessionManager.sendCommand(
        params.sid,
        {
          args: ['exec', '--full-auto', '--skip-git-repo-check', applyPrompt]
        }
      );

      if (!response.success) {
        return {
          type: 'text',
          text: `❌ Failed to apply patch: ${response.error}`
        };
      }

      return {
        type: 'text',
        text: `✅ Patch Applied - Session ${params.sid}\n${params.file ? `File: ${params.file}\n` : ''}\n${response.text}`
      };
    } else {
      // Preview mode
      logger.info('Previewing patch for session', { sessionId: params.sid, file: params.file });

      let previewPrompt = 'Show what changes would be made';
      if (params.file) {
        previewPrompt += ` to ${params.file}`;
      }

      const response = await sessionManager.sendCommand(
        params.sid,
        {
          args: ['exec', '--full-auto', '--skip-git-repo-check', previewPrompt]
        }
      );

      if (!response.success) {
        return {
          type: 'text',
          text: `❌ Failed to preview patch: ${response.error}`
        };
      }

      return {
        type: 'text',
        text: `👁️ Patch Preview - Session ${params.sid}\n${params.file ? `File: ${params.file}\n` : ''}\n${response.text}`
      };
    }
  } catch (error: any) {
    logger.error('Error with patch:', error);
    return {
      type: 'text',
      text: `❌ Failed to handle patch: ${error.message}`
    };
  }
}

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ask',
      description: 'Ask Codex for help with coding, planning, or analysis',
      inputSchema: zodToJsonSchema(AskSchema) as any
    },
    {
      name: 'chat_start',
      description: 'Start conversation with Codex',
      inputSchema: zodToJsonSchema(ChatStartSchema) as any
    },
    {
      name: 'chat_msg',
      description: 'Continue conversation',
      inputSchema: zodToJsonSchema(ChatMsgSchema) as any
    },
    {
      name: 'cancel',
      description: 'Cancel/terminate session',
      inputSchema: zodToJsonSchema(CancelSchema) as any
    },
    {
      name: 'status',
      description: 'Check session status',
      inputSchema: zodToJsonSchema(StatusSchema) as any
    },
    {
      name: 'restart',
      description: 'Restart session',
      inputSchema: zodToJsonSchema(RestartSchema) as any
    },
    {
      name: 'plan',
      description: 'Get/update implementation plan',
      inputSchema: zodToJsonSchema(PlanSchema) as any
    },
    {
      name: 'patch',
      description: 'Preview/apply code changes',
      inputSchema: zodToJsonSchema(PatchSchema) as any
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const startTime = new Date();

  // Log MCP request start
  logger.logWithContext('info', `MCP tool called: ${name}`, {
    requestId,
    toolName: name,
    eventType: 'mcp_request_start',
    parameters: args,
    timestamp: startTime
  });

  try {
    // Ensure we always return a valid MCP content item
    const toContent = (result: any) => {
      if (result && typeof result === 'object' && typeof result.type === 'string') {
        return result;
      }
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { type: 'text', text } as any;
    };

    switch (name) {
      case 'ask':
        return { content: [toContent(await handleAsk(args, request.params._meta))] };

      case 'chat_start':
        return { content: [toContent(await handleChatStart(args))] };

      case 'chat_msg':
        return { content: [toContent(await handleChatMsg(args))] };

      case 'cancel':
        return { content: [toContent(await handleCancel(args))] };

      case 'status':
        return { content: [toContent(await handleStatus(args))] };

      case 'restart':
        return { content: [toContent(await handleRestart(args))] };

      case 'plan':
        return { content: [toContent(await handlePlan(args))] };

      case 'patch':
        return { content: [toContent(await handlePatch(args))] };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    
    // Log successful completion (this line won't be reached due to returns above, but we handle it in each case)
    
  } catch (error: any) {
    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();
    
    // Create error context for structured logging
    const errorContext = createErrorContext(
      undefined, // session ID not available at this level
      undefined,
      undefined,
      requestId,
      name,
      { parameters: args, duration }
    );

    // Categorize the error
    const categorizedError = categorizeError(error, errorContext, ErrorCategory.MCP_PROTOCOL);
    
    // Log MCP request failure
    logger.logMCPRequest({
      toolName: name,
      requestId,
      parameters: args as Record<string, any>,
      startTime,
      endTime,
      duration,
      success: false,
      errorCategory: categorizedError.category,
      errorCode: categorizedError.code
    });

    return {
      content: [{ type: 'text', text: `❌ Tool ${name} failed: ${categorizedError.message}` }]
    };
  }
});

// Start server
async function main() {
  try {
    // Test Codex connection
    logger.info('Testing Codex CLI connection...');
    const connected = await codexClient.testConnection();
    if (!connected) {
      logger.warn('Codex CLI connection test failed - make sure Codex is installed and accessible');
    } else {
      logger.info('Codex CLI connection successful');
    }

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    logger.info('Codex MCP Server is running');
    logger.info('Configuration:', {
      maxConversations: process.env.MAX_CONVERSATIONS || '50',
      maxConversationHistory: process.env.MAX_CONVERSATION_HISTORY || '100',
      maxConversationContext: process.env.MAX_CONVERSATION_CONTEXT || '10'
    });
  } catch (error) {
    logger.error('Failed to start server:', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down Codex MCP Server...');
  await sessionManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down Codex MCP Server...');
  await sessionManager.shutdown();
  process.exit(0);
});

// Run the server
main().catch((error) => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});