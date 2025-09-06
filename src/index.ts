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
  max_tokens_per_page: z.number().int().min(5000).max(20000).default(18000).describe('Maximum tokens per page (default: 18000)')
});

const StartConversationSchema = z.object({
  topic: z.string().describe('The topic or purpose of the conversation'),
  instructions: z.string().optional().describe('System instructions for the conversation')
});

const ContinueConversationSchema = z.object({
  conversation_id: z.string().describe('The ID of the conversation to continue'),
  message: z.string().describe('The message to send in the conversation')
});

const SetConversationOptionsSchema = z.object({
  conversation_id: z.string().describe('Conversation ID'),
  context_limit: z.number().int().min(1).max(1000).optional().describe('Messages to keep in context window')
});

const GetConversationMetadataSchema = z.object({
  conversation_id: z.string().describe('Conversation ID')
});

const SummarizeConversationSchema = z.object({
  conversation_id: z.string().describe('Conversation ID'),
  keep_last_n: z.number().int().min(0).max(50).default(5).describe('How many recent messages to keep verbatim')
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
    const cacheKey = getCacheKey(params.prompt, params.context, params.model);
    let fullResponse: string;

    // Check cache first (only for page 1 or if we have a cached response)
    const cachedEntry = responseCache.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp) < cachedEntry.ttl) {
      fullResponse = cachedEntry.response;
      logger.info(`Using cached response for page ${params.page}`, { requestId, cacheKey });
    } else {
      // Only call Codex for page 1 or if not cached
      if (params.page === 1 || !cachedEntry) {
        logger.info(`Calling Codex CLI for new request`, { requestId, model: params.model });
        
        // Create response using Codex CLI
        const response = await codexClient.createResponse({
          input,
          model: params.model,
          temperature: params.temperature
        });

        if (!response.success) {
          return {
            type: 'text',
            text: `❌ Error: ${response.error || 'Failed to consult Codex'}`
          };
        }

        fullResponse = response.text;
        
        // Cache the full response
        responseCache.set(cacheKey, {
          response: fullResponse,
          timestamp: Date.now(),
          ttl: CACHE_TTL
        });
        
        logger.info(`Cached response`, { 
          requestId, 
          cacheKey, 
          responseLength: fullResponse.length,
          estimatedTokens: estimateTokens(fullResponse).estimatedTokens
        });
      } else {
        return {
          type: 'text',
          text: `❌ Error: Page ${params.page} requested but no cached response available. Please start with page 1.`
        };
      }
    }

    // Chunk the response for pagination
    const chunk = chunkResponse(fullResponse, params.max_tokens_per_page, params.page);
    const paginatedText = formatPaginatedResponse(chunk, fullResponse, requestId);

    logger.info(`Returning paginated response`, {
      requestId,
      page: params.page,
      totalPages: chunk.totalChunks,
      chunkTokens: chunk.tokenEstimate.estimatedTokens,
      totalTokens: estimateTokens(fullResponse).estimatedTokens
    });

    // Return in proper MCP format
    return {
      type: 'text',
      text: paginatedText
    };
  } catch (error: any) {
    logger.error('Error consulting Codex:', error);
    return {
      type: 'text',
      text: `❌ Error: ${error.message || 'Failed to consult Codex'}`
    };
  }
}

async function handleStartConversation(args: any): Promise<any> {
  const params = StartConversationSchema.parse(args);
  
  try {
    const conversationId = conversationManager.startConversation(
      params.topic,
      params.instructions
    );

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
    const conversation = conversationManager.getConversation(params.conversation_id);
    if (!conversation) {
      return { type: 'text', text: `❌ Conversation not found: ${params.conversation_id}` };
    }

    // Add user message
    conversationManager.addMessage(params.conversation_id, 'user', params.message);

    // Get formatted messages for API with context limit
    const contextLimit = parseInt(process.env.MAX_CONVERSATION_CONTEXT || '10');
    const messages = conversationManager.formatForAPI(params.conversation_id, undefined, contextLimit);
    const instructions = conversationManager.getInstructions(params.conversation_id);

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
    conversationManager.addMessage(params.conversation_id, 'assistant', response.text);

    return { 
      type: 'text', 
      text: `${response.text}\n\n---\n💬 Conversation: ${params.conversation_id}` 
    };
  } catch (error: any) {
    logger.error('Error continuing conversation:', error);
    return { 
      type: 'text', 
      text: `❌ Error continuing conversation ${params.conversation_id}: ${error.message || 'Unknown error'}` 
    };
  }
}

async function handleSetConversationOptions(args: any): Promise<any> {
  const params = SetConversationOptionsSchema.parse(args);
  try {
    conversationManager.setOptions(params.conversation_id, {
      contextLimit: params.context_limit
    });
    return { 
      type: 'text', 
      text: `✅ Updated conversation ${params.conversation_id}${params.context_limit ? `\nContext limit: ${params.context_limit}` : ''}` 
    };
  } catch (error: any) {
    return { type: 'text', text: `❌ Failed to set options: ${error.message || 'Unknown error'}` };
  }
}

async function handleGetConversationMetadata(args: any): Promise<any> {
  const params = GetConversationMetadataSchema.parse(args);
  const meta = conversationManager.getMetadata(params.conversation_id);
  if (!meta) return { type: 'text', text: `❌ Conversation not found: ${params.conversation_id}` };
  return { type: 'text', text: JSON.stringify(meta, null, 2) };
}

async function handleSummarizeConversation(args: any): Promise<any> {
  const params = SummarizeConversationSchema.parse(args);
  const conversation = conversationManager.getConversation(params.conversation_id);
  if (!conversation) return { type: 'text', text: `❌ Conversation not found: ${params.conversation_id}` };

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

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'consult_codex',
      description: 'Consult Codex for planning or coding assistance. Supports pagination for large responses to stay within MCP token limits. Use page parameter for subsequent chunks.',
      inputSchema: zodToJsonSchema(ConsultCodexSchema) as any
    },
    {
      name: 'start_conversation',
      description: 'Start a new conversation with Codex',
      inputSchema: zodToJsonSchema(StartConversationSchema) as any
    },
    {
      name: 'continue_conversation',
      description: 'Continue an existing conversation with Codex',
      inputSchema: zodToJsonSchema(ContinueConversationSchema) as any
    },
    {
      name: 'set_conversation_options',
      description: 'Adjust conversation context options',
      inputSchema: zodToJsonSchema(SetConversationOptionsSchema) as any
    },
    {
      name: 'get_conversation_metadata',
      description: 'Return conversation metadata and messages',
      inputSchema: zodToJsonSchema(GetConversationMetadataSchema) as any
    },
    {
      name: 'summarize_conversation',
      description: 'Summarize a conversation to reduce context size',
      inputSchema: zodToJsonSchema(SummarizeConversationSchema) as any
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
      case 'consult_codex':
        return { content: [toContent(await handleConsultCodex(args, request.params._meta))] };
      
      case 'start_conversation':
        return { content: [toContent(await handleStartConversation(args))] };
      
      case 'continue_conversation':
        return { content: [toContent(await handleContinueConversation(args))] };
      
      case 'set_conversation_options':
        return { content: [toContent(await handleSetConversationOptions(args))] };
      
      case 'get_conversation_metadata':
        return { content: [toContent(await handleGetConversationMetadata(args))] };
      
      case 'summarize_conversation':
        return { content: [toContent(await handleSummarizeConversation(args))] };
      
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
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down Codex MCP Server...');
  process.exit(0);
});

// Run the server
main().catch((error) => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});