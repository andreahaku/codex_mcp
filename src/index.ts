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
import winston from 'winston';

import { CodexClient } from './codex-client.js';
import { ConversationManager } from './conversation.js';
import { SessionManager } from './session-manager.js';
import { chunkResponse, formatPaginatedResponse, estimateTokens } from './token-utils.js';

// Load environment variables
dotenv.config();

// Configure logging
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
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
const ConsultCodexSchema = z.object({
  prompt: z.string().describe('The prompt to send to Codex'),
  context: z.string().optional().describe('Additional context for the prompt'),
  model: z.string().optional().describe('Model to use (e.g., "o3", "gpt-5")'),
  temperature: z.number().min(0).max(2).default(0.7).describe('Sampling temperature'),
  page: z.number().int().min(1).default(1).describe('Page number for pagination (default: 1)'),
  max_tokens_per_page: z.number().int().min(5000).max(20000).default(18000).describe('Maximum tokens per page (default: 18000)'),
  session_id: z.string().optional().describe('Session/Conversation ID for persistent context (auto-generated if not provided)'),
  workspace_path: z.string().optional().describe('Workspace path for repository isolation (defaults to current working directory)'),
  streaming: z.boolean().default(false).describe('Enable streaming responses for real-time updates')
});

const StartConversationSchema = z.object({
  topic: z.string().describe('The topic or purpose of the conversation'),
  instructions: z.string().optional().describe('System instructions for the conversation'),
  session_id: z.string().optional().describe('Optional session ID to link with existing Codex session')
});

const ContinueConversationSchema = z.object({
  session_id: z.string().describe('The session/conversation ID to continue'),
  message: z.string().describe('The message to send in the conversation')
});

const SetConversationOptionsSchema = z.object({
  session_id: z.string().describe('Session/Conversation ID'),
  context_limit: z.number().int().min(1).max(1000).optional().describe('Messages to keep in context window')
});

const GetConversationMetadataSchema = z.object({
  session_id: z.string().describe('Session/Conversation ID')
});

const SummarizeConversationSchema = z.object({
  session_id: z.string().describe('Session/Conversation ID'),
  keep_last_n: z.number().int().min(0).max(50).default(5).describe('How many recent messages to keep verbatim')
});

const CancelRequestSchema = z.object({
  session_id: z.string().describe('Session ID to cancel operations for'),
  force: z.boolean().default(false).describe('Force kill the session process')
});

const GetSessionHealthSchema = z.object({
  session_id: z.string().optional().describe('Specific session ID to check (optional - checks all if not provided)')
});

const RestartSessionSchema = z.object({
  session_id: z.string().describe('Session ID to restart')
});

// Plan Management Tools
const GetPlanSchema = z.object({
  session_id: z.string().describe('Session ID to get plan from')
});

const UpdatePlanSchema = z.object({
  session_id: z.string().describe('Session ID to update plan for'),
  plan_updates: z.string().describe('Plan updates or modifications to apply')
});

const PreviewPatchSchema = z.object({
  session_id: z.string().describe('Session ID for patch preview'),
  file_path: z.string().optional().describe('Specific file to preview (optional)'),
  dry_run: z.boolean().default(true).describe('Preview without applying changes')
});

const ApplyPatchSchema = z.object({
  session_id: z.string().describe('Session ID for patch application'),
  file_path: z.string().optional().describe('Specific file to apply patch to (optional)'),
  confirm: z.boolean().default(false).describe('Confirm application of destructive changes')
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
    logger.warn('Error processing resources:', error);
  }
  
  return resourceContent;
}

// Tool handlers
async function handleConsultCodex(args: any, meta?: any): Promise<any> {
  const params = ConsultCodexSchema.parse(args);
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  
  try {
    // Generate session ID if not provided
    const sessionId = params.session_id || `session_${requestId}`;
    const workspacePath = params.workspace_path || process.cwd();
    
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
    const chunk = chunkResponse(fullResponse, params.max_tokens_per_page, params.page);
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

async function handleStartConversation(args: any): Promise<any> {
  const params = StartConversationSchema.parse(args);
  
  try {
    // Use provided session_id or generate a new one
    const conversationId = params.session_id || conversationManager.startConversation(
      params.topic,
      params.instructions
    );
    
    // If session_id was provided, create or link the conversation
    if (params.session_id) {
      // Try to get existing conversation, or create new one with provided ID
      let conversation = conversationManager.getConversation(params.session_id);
      if (!conversation) {
        // Create new conversation with the provided ID
        conversationManager.startConversationWithId(
          params.session_id,
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

async function handleContinueConversation(args: any): Promise<any> {
  const params = ContinueConversationSchema.parse(args);
  
  try {
    // Get conversation context
    const conversation = conversationManager.getConversation(params.session_id);
    if (!conversation) {
      return { type: 'text', text: `❌ Conversation not found: ${params.session_id}` };
    }

    // Add user message
    conversationManager.addMessage(params.session_id, 'user', params.message);

    // Get formatted messages for API with context limit
    const contextLimit = parseInt(process.env.MAX_CONVERSATION_CONTEXT || '10');
    const messages = conversationManager.formatForAPI(params.session_id, undefined, contextLimit);
    const instructions = conversationManager.getInstructions(params.session_id);

    // Create response using Codex CLI
    const response = await codexClient.createResponse({
      input: messages,
      instructions
    });

    if (!response.success) {
      return {
        type: 'text',
        text: `❌ Error continuing conversation: ${response.error || 'Failed to get response'}`
      };
    }

    // Add assistant response to conversation
    conversationManager.addMessage(params.session_id, 'assistant', response.text);

    return { 
      type: 'text', 
      text: `${response.text}\n\n---\n💬 Conversation: ${params.session_id}` 
    };
  } catch (error: any) {
    logger.error('Error continuing conversation:', error);
    return { 
      type: 'text', 
      text: `❌ Error continuing conversation ${params.session_id}: ${error.message || 'Unknown error'}` 
    };
  }
}

async function handleSetConversationOptions(args: any): Promise<any> {
  const params = SetConversationOptionsSchema.parse(args);
  try {
    conversationManager.setOptions(params.session_id, {
      contextLimit: params.context_limit
    });
    return { 
      type: 'text', 
      text: `✅ Updated conversation ${params.session_id}${params.context_limit ? `\nContext limit: ${params.context_limit}` : ''}` 
    };
  } catch (error: any) {
    return { type: 'text', text: `❌ Failed to set options: ${error.message || 'Unknown error'}` };
  }
}

async function handleGetConversationMetadata(args: any): Promise<any> {
  const params = GetConversationMetadataSchema.parse(args);
  const meta = conversationManager.getMetadata(params.session_id);
  if (!meta) return { type: 'text', text: `❌ Conversation not found: ${params.session_id}` };
  return { type: 'text', text: JSON.stringify(meta, null, 2) };
}

async function handleSummarizeConversation(args: any): Promise<any> {
  const params = SummarizeConversationSchema.parse(args);
  const conversation = conversationManager.getConversation(params.session_id);
  if (!conversation) return { type: 'text', text: `❌ Conversation not found: ${params.session_id}` };

  // Build summary prompt
  const keep = Math.max(0, params.keep_last_n);
  const messages = conversation.messages;
  const hasDev = messages[0]?.role === 'developer';
  const prefix = hasDev ? messages[0] : null;
  const headIndex = hasDev ? 1 : 0;
  const recent = messages.slice(Math.max(headIndex, messages.length - keep));
  const toSummarize = messages.slice(headIndex, Math.max(headIndex, messages.length - keep));

  const summaryInput = [
    'Summarize the following conversation messages into a concise brief that preserves key decisions, facts, constraints, and pending questions. Use bullet points. Keep it under 300 words.\n',
    ...toSummarize.map(m => `${m.role.toUpperCase()}: ${m.content}`)
  ].join('\n');

  const response = await codexClient.createResponse({
    input: summaryInput
  });

  if (!response.success) {
    return { type: 'text', text: `❌ Failed to summarize conversation: ${response.error}` };
  }

  // Replace messages with summary + recent
  const newMessages: any[] = [];
  if (prefix) newMessages.push(prefix);
  newMessages.push({ role: 'assistant', content: `Conversation summary (compressed):\n${response.text}`, timestamp: new Date() });
  for (const m of recent) newMessages.push(m);

  (conversation as any).messages = newMessages as any;
  conversation.metadata.lastActive = new Date();

  return { type: 'text', text: `✅ Conversation summarized. Kept last ${keep} messages.` };
}

async function handleCancelRequest(args: any): Promise<any> {
  const params = CancelRequestSchema.parse(args);
  
  try {
    logger.info('Cancelling session operations', { sessionId: params.session_id, force: params.force });
    
    if (params.force) {
      await sessionManager.destroySession(params.session_id);
      return { 
        type: 'text', 
        text: `🛑 Session ${params.session_id} forcefully terminated and destroyed.` 
      };
    } else {
      await sessionManager.restart(params.session_id);
      return { 
        type: 'text', 
        text: `⚡ Session ${params.session_id} restarted to cancel ongoing operations.` 
      };
    }
  } catch (error: any) {
    logger.error('Error cancelling request:', error);
    return { 
      type: 'text', 
      text: `❌ Failed to cancel session ${params.session_id}: ${error.message}` 
    };
  }
}

async function handleGetSessionHealth(args: any): Promise<any> {
  const params = GetSessionHealthSchema.parse(args);
  
  try {
    const healthCheck = await sessionManager.healthCheck(params.session_id);
    
    if (params.session_id) {
      const session = healthCheck.sessions[0];
      if (!session) {
        return { type: 'text', text: `❌ Session ${params.session_id} not found.` };
      }
      
      const status = session.status === 'ready' ? '✅' : 
                    session.status === 'error' ? '❌' : 
                    session.status === 'starting' ? '⏳' : '🔄';
      
      return {
        type: 'text',
        text: `${status} Session: ${session.id}
📂 Workspace: ${session.workspacePath}
🏷️  Workspace ID: ${session.workspaceId}
📊 Status: ${session.status}
🕒 Created: ${session.created.toISOString()}
⚡ Last Active: ${session.lastActive.toISOString()}
📈 Requests: ${session.requestCount}
🧠 Capabilities: ${session.capabilities ? JSON.stringify(session.capabilities, null, 2) : 'Unknown'}`
      };
    } else {
      // Show all sessions
      if (healthCheck.sessions.length === 0) {
        return { type: 'text', text: '📭 No active sessions.' };
      }
      
      const sessionList = healthCheck.sessions.map(session => {
        const status = session.status === 'ready' ? '✅' : 
                      session.status === 'error' ? '❌' : 
                      session.status === 'starting' ? '⏳' : '🔄';
        return `${status} ${session.id} (${session.workspaceId}) - ${session.requestCount} requests`;
      }).join('\n');
      
      return {
        type: 'text',
        text: `🖥️  Active Sessions (${healthCheck.sessions.length}):
${sessionList}

🏥 Overall Health: ${healthCheck.healthy ? '✅ Healthy' : '⚠️  Issues Detected'}`
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

async function handleRestartSession(args: any): Promise<any> {
  const params = RestartSessionSchema.parse(args);
  
  try {
    logger.info('Restarting session', { sessionId: params.session_id });
    await sessionManager.restart(params.session_id);
    
    return { 
      type: 'text', 
      text: `🔄 Session ${params.session_id} restarted successfully.` 
    };
  } catch (error: any) {
    logger.error('Error restarting session:', error);
    return { 
      type: 'text', 
      text: `❌ Failed to restart session ${params.session_id}: ${error.message}` 
    };
  }
}

// Plan Management Tool Handlers
async function handleGetPlan(args: any): Promise<any> {
  const params = GetPlanSchema.parse(args);
  
  try {
    logger.info('Getting plan from session', { sessionId: params.session_id });
    
    const response = await sessionManager.sendCommand(
      params.session_id,
      {
        args: ['exec', '--full-auto', '--skip-git-repo-check', 'show current plan']
      }
    );

    if (!response.success) {
      return {
        type: 'text',
        text: `❌ Failed to get plan from session ${params.session_id}: ${response.error}`
      };
    }

    return {
      type: 'text',
      text: `📋 **Current Plan - Session ${params.session_id}**

${response.text}

---
💡 Use \`update_plan\` to modify this plan or \`preview_patch\` to see proposed changes.`
    };
  } catch (error: any) {
    logger.error('Error getting plan:', error);
    return {
      type: 'text',
      text: `❌ Failed to get plan: ${error.message}`
    };
  }
}

async function handleUpdatePlan(args: any): Promise<any> {
  const params = UpdatePlanSchema.parse(args);
  
  try {
    logger.info('Updating plan for session', { sessionId: params.session_id });
    
    const planPrompt = `Update the current plan with these modifications: ${params.plan_updates}`;
    
    const response = await sessionManager.sendCommand(
      params.session_id,
      {
        args: ['exec', '--full-auto', '--skip-git-repo-check', planPrompt]
      }
    );

    if (!response.success) {
      return {
        type: 'text',
        text: `❌ Failed to update plan for session ${params.session_id}: ${response.error}`
      };
    }

    return {
      type: 'text',
      text: `✅ **Plan Updated - Session ${params.session_id}**

${response.text}

---
💡 Use \`get_plan\` to view the updated plan or \`preview_patch\` to see changes.`
    };
  } catch (error: any) {
    logger.error('Error updating plan:', error);
    return {
      type: 'text',
      text: `❌ Failed to update plan: ${error.message}`
    };
  }
}

async function handlePreviewPatch(args: any): Promise<any> {
  const params = PreviewPatchSchema.parse(args);
  
  try {
    logger.info('Previewing patch for session', { sessionId: params.session_id, filePath: params.file_path });
    
    let previewPrompt = 'Show me what changes would be made';
    if (params.file_path) {
      previewPrompt += ` to ${params.file_path}`;
    }
    if (params.dry_run) {
      previewPrompt += ' (dry run - do not apply changes)';
    }
    
    const response = await sessionManager.sendCommand(
      params.session_id,
      {
        args: ['exec', '--full-auto', '--skip-git-repo-check', previewPrompt]
      }
    );

    if (!response.success) {
      return {
        type: 'text',
        text: `❌ Failed to preview patch for session ${params.session_id}: ${response.error}`
      };
    }

    const patchIcon = params.dry_run ? '👁️' : '🔍';
    
    return {
      type: 'text',
      text: `${patchIcon} **Patch Preview - Session ${params.session_id}**
${params.file_path ? `File: \`${params.file_path}\`` : 'All Files'}

${response.text}

---
💡 ${params.dry_run ? 'Use `apply_patch` to apply these changes.' : 'This is a preview of proposed changes.'}`
    };
  } catch (error: any) {
    logger.error('Error previewing patch:', error);
    return {
      type: 'text',
      text: `❌ Failed to preview patch: ${error.message}`
    };
  }
}

async function handleApplyPatch(args: any): Promise<any> {
  const params = ApplyPatchSchema.parse(args);
  
  try {
    logger.info('Applying patch for session', { 
      sessionId: params.session_id, 
      filePath: params.file_path,
      confirmed: params.confirm 
    });
    
    if (!params.confirm) {
      return {
        type: 'text',
        text: `⚠️  **Confirmation Required - Session ${params.session_id}**

This operation will apply changes to your files. To proceed, set \`confirm: true\`.

💡 Use \`preview_patch\` first to see what changes will be made.`
      };
    }
    
    let applyPrompt = 'Apply the planned changes';
    if (params.file_path) {
      applyPrompt += ` to ${params.file_path}`;
    }
    
    const response = await sessionManager.sendCommand(
      params.session_id,
      {
        args: ['exec', '--full-auto', '--skip-git-repo-check', applyPrompt]
      }
    );

    if (!response.success) {
      return {
        type: 'text',
        text: `❌ Failed to apply patch for session ${params.session_id}: ${response.error}`
      };
    }

    return {
      type: 'text',
      text: `✅ **Patch Applied - Session ${params.session_id}**
${params.file_path ? `File: \`${params.file_path}\`` : 'All Files'}

${response.text}

---
🎉 Changes have been applied! Check your workspace for the updates.`
    };
  } catch (error: any) {
    logger.error('Error applying patch:', error);
    return {
      type: 'text',
      text: `❌ Failed to apply patch: ${error.message}`
    };
  }
}

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'codex_ask',
      description: '🌟 Ask Codex for help with coding, planning, or analysis. Supports persistent sessions, streaming, and pagination for large responses.',
      inputSchema: zodToJsonSchema(ConsultCodexSchema) as any
    },
    {
      name: 'codex_chat_start',
      description: '💬 Start new conversation with Codex (links to session)',
      inputSchema: zodToJsonSchema(StartConversationSchema) as any
    },
    {
      name: 'codex_chat_continue',
      description: 'Continue existing conversation with Codex',
      inputSchema: zodToJsonSchema(ContinueConversationSchema) as any
    },
    {
      name: 'codex_chat_config',
      description: 'Configure conversation context and options',
      inputSchema: zodToJsonSchema(SetConversationOptionsSchema) as any
    },
    {
      name: 'codex_chat_info',
      description: 'Get conversation metadata and message history',
      inputSchema: zodToJsonSchema(GetConversationMetadataSchema) as any
    },
    {
      name: 'codex_chat_summarize',
      description: 'Summarize conversation to reduce context size',
      inputSchema: zodToJsonSchema(SummarizeConversationSchema) as any
    },
    {
      name: 'codex_cancel',
      description: 'Cancel running Codex operations or force terminate sessions',
      inputSchema: zodToJsonSchema(CancelRequestSchema) as any
    },
    {
      name: 'codex_status',
      description: '💻 Check status and health of Codex sessions with diagnostics',
      inputSchema: zodToJsonSchema(GetSessionHealthSchema) as any
    },
    {
      name: 'codex_restart',
      description: 'Restart Codex sessions to recover from errors',
      inputSchema: zodToJsonSchema(RestartSessionSchema) as any
    },
    {
      name: 'codex_plan_get',
      description: '📋 Get current implementation plan from Codex session',
      inputSchema: zodToJsonSchema(GetPlanSchema) as any
    },
    {
      name: 'codex_plan_update',
      description: 'Update or modify implementation plan with Codex',
      inputSchema: zodToJsonSchema(UpdatePlanSchema) as any
    },
    {
      name: 'codex_patch_preview',
      description: 'Preview code changes that Codex plans to make',
      inputSchema: zodToJsonSchema(PreviewPatchSchema) as any
    },
    {
      name: 'codex_patch_apply',
      description: 'Apply Codex-planned changes to files (requires confirmation)',
      inputSchema: zodToJsonSchema(ApplyPatchSchema) as any
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;

  logger.info(`Calling tool: ${name}`, { requestId, args });

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
      case 'codex_ask':
        return { content: [toContent(await handleConsultCodex(args, request.params._meta))] };
      
      case 'codex_chat_start':
        return { content: [toContent(await handleStartConversation(args))] };
      
      case 'codex_chat_continue':
        return { content: [toContent(await handleContinueConversation(args))] };
      
      case 'codex_chat_config':
        return { content: [toContent(await handleSetConversationOptions(args))] };
      
      case 'codex_chat_info':
        return { content: [toContent(await handleGetConversationMetadata(args))] };
      
      case 'codex_chat_summarize':
        return { content: [toContent(await handleSummarizeConversation(args))] };
      
      case 'codex_cancel':
        return { content: [toContent(await handleCancelRequest(args))] };
      
      case 'codex_status':
        return { content: [toContent(await handleGetSessionHealth(args))] };
      
      case 'codex_restart':
        return { content: [toContent(await handleRestartSession(args))] };
      
      case 'codex_plan_get':
        return { content: [toContent(await handleGetPlan(args))] };
      
      case 'codex_plan_update':
        return { content: [toContent(await handleUpdatePlan(args))] };
      
      case 'codex_patch_preview':
        return { content: [toContent(await handlePreviewPatch(args))] };
      
      case 'codex_patch_apply':
        return { content: [toContent(await handleApplyPatch(args))] };
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    logger.error(`Tool ${name} failed:`, { requestId, error });
    return {
      content: [{ type: 'text', text: `❌ Tool ${name} failed: ${error.message || 'Unknown error'}` }]
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
    logger.error('Failed to start server:', error);
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