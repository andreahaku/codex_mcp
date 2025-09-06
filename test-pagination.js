#!/usr/bin/env node

// Simple test script to verify pagination functionality
import { chunkResponse, formatPaginatedResponse, estimateTokens } from './dist/token-utils.js';

// Create a large mock response (simulate large Codex output)
const mockLargeResponse = Array(100).fill(0)
  .map((_, i) => `This is paragraph ${i + 1}. `.repeat(50))
  .join('\n\n');

console.log('🧪 Testing Pagination Implementation\n');

// Test token estimation
const estimate = estimateTokens(mockLargeResponse);
console.log(`📊 Mock Response Stats:`);
console.log(`   Characters: ${estimate.characters.toLocaleString()}`);
console.log(`   Estimated Tokens: ${estimate.estimatedTokens.toLocaleString()}`);
console.log(`   Over Limit: ${estimate.isOverLimit ? '❌ Yes' : '✅ No'}\n`);

// Test chunking
console.log(`📄 Testing Chunking:`);
for (let page = 1; page <= 3; page++) {
  const chunk = chunkResponse(mockLargeResponse, 18000, page);
  const formatted = formatPaginatedResponse(chunk, mockLargeResponse, `test_${page}`);
  
  console.log(`   Page ${page}:`);
  console.log(`     Chunk size: ${chunk.content.length} chars`);
  console.log(`     Estimated tokens: ${chunk.tokenEstimate.estimatedTokens}`);
  console.log(`     Has more: ${chunk.hasMore ? '✅' : '❌'}`);
  console.log(`     Total chunks: ${chunk.totalChunks}`);
  
  if (page === 1) {
    // Show first chunk preview
    console.log(`     Preview: "${chunk.content.slice(0, 100)}..."`);
    console.log(`     Formatted preview: "${formatted.slice(-200)}"`);
  }
  console.log('');
}

console.log('✅ Pagination test completed successfully!');
console.log('\n🚀 Usage:');
console.log('   Call consult_codex with:');
console.log('   - page: 1 (for first chunk)');
console.log('   - page: 2 (for second chunk, etc.)');
console.log('   - max_tokens_per_page: 18000 (default, adjustable 5000-20000)');