/**
 * Token estimation and response chunking utilities for MCP compliance
 */

export interface TokenEstimate {
  characters: number;
  estimatedTokens: number;
  isOverLimit: boolean;
}

export interface ResponseChunk {
  content: string;
  chunkIndex: number;
  totalChunks: number;
  tokenEstimate: TokenEstimate;
  hasMore: boolean;
}

export interface PaginationInfo {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalTokens: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Estimate token count using rough approximation (1 token ≈ 4 characters)
 * This is conservative to stay well under limits
 */
export function estimateTokens(text: string): TokenEstimate {
  const characters = text.length;
  // Use conservative estimate: 3.5 chars per token to be safe
  const estimatedTokens = Math.ceil(characters / 3.5);
  const isOverLimit = estimatedTokens > 20000; // Leave 5k token buffer under 25k limit
  
  return {
    characters,
    estimatedTokens,
    isOverLimit
  };
}

/**
 * Split response into chunks that respect token limits
 */
export function chunkResponse(
  text: string, 
  maxTokensPerChunk: number = 20000,
  requestedPage: number = 1
): ResponseChunk {
  const estimate = estimateTokens(text);
  
  if (!estimate.isOverLimit) {
    // Response fits in single chunk
    return {
      content: text,
      chunkIndex: 1,
      totalChunks: 1,
      tokenEstimate: estimate,
      hasMore: false
    };
  }
  
  // Calculate chunk size based on token limit
  const maxCharsPerChunk = Math.floor(maxTokensPerChunk * 3.5);
  const totalChunks = Math.ceil(text.length / maxCharsPerChunk);
  
  // Validate requested page
  const pageNum = Math.max(1, Math.min(requestedPage, totalChunks));
  
  // Extract the requested chunk
  const startIndex = (pageNum - 1) * maxCharsPerChunk;
  const endIndex = Math.min(startIndex + maxCharsPerChunk, text.length);
  const chunkContent = text.slice(startIndex, endIndex);
  
  // Try to break at word boundaries for better readability
  const cleanContent = pageNum < totalChunks 
    ? breakAtWordBoundary(chunkContent, maxCharsPerChunk)
    : chunkContent;
  
  return {
    content: cleanContent,
    chunkIndex: pageNum,
    totalChunks,
    tokenEstimate: estimateTokens(cleanContent),
    hasMore: pageNum < totalChunks
  };
}

/**
 * Break text at word boundary to avoid cutting words in half
 */
function breakAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  
  // Look for last space, newline, or punctuation within reasonable range
  const searchRange = Math.min(200, Math.floor(maxLength * 0.1));
  const cutPoint = maxLength - searchRange;
  
  const lastSpace = text.lastIndexOf(' ', maxLength);
  const lastNewline = text.lastIndexOf('\n', maxLength);
  const lastPunct = Math.max(
    text.lastIndexOf('.', maxLength),
    text.lastIndexOf('!', maxLength),
    text.lastIndexOf('?', maxLength),
    text.lastIndexOf(';', maxLength)
  );
  
  const breakPoint = Math.max(lastSpace, lastNewline, lastPunct);
  
  if (breakPoint > cutPoint) {
    return text.slice(0, breakPoint);
  }
  
  // Fallback to character limit if no good break point found
  return text.slice(0, maxLength) + '...';
}

/**
 * Create pagination info for response metadata
 */
export function createPaginationInfo(
  chunk: ResponseChunk,
  totalText: string
): PaginationInfo {
  return {
    currentPage: chunk.chunkIndex,
    totalPages: chunk.totalChunks,
    pageSize: 20000, // tokens
    totalTokens: estimateTokens(totalText).estimatedTokens,
    hasNextPage: chunk.hasMore,
    hasPreviousPage: chunk.chunkIndex > 1
  };
}

/**
 * Format paginated response for MCP
 */
export function formatPaginatedResponse(
  chunk: ResponseChunk,
  totalText: string,
  requestId?: string
): string {
  const pagination = createPaginationInfo(chunk, totalText);
  
  let response = chunk.content;
  
  // Add pagination metadata if this is a multi-chunk response
  if (chunk.totalChunks > 1) {
    const metadata = [
      `\n\n--- Page ${chunk.chunkIndex} of ${chunk.totalChunks} ---`,
      `📊 Tokens: ~${chunk.tokenEstimate.estimatedTokens} (of ~${pagination.totalTokens} total)`,
      chunk.hasMore ? `⏭️  Use page=${chunk.chunkIndex + 1} for next chunk` : '✅ End of response',
      requestId ? `🔍 Request ID: ${requestId}` : ''
    ].filter(Boolean);
    
    response += '\n' + metadata.join('\n');
  }
  
  return response;
}