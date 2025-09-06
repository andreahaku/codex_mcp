# Pagination Support for Large Codex Responses

## Problem Solved

The MCP framework has a hard limit of **25,000 tokens** per tool response. Large Codex responses (like the 99,823 token response you encountered) exceed this limit and cause errors.

## Solution

This implementation adds **streaming/pagination** support to the `consult_codex` tool, allowing large responses to be delivered in manageable chunks.

## How It Works

### 1. **Token Estimation**
- Uses conservative estimation: ~3.5 characters per token
- Default limit: 18,000 tokens per page (leaving 7k token buffer)
- Automatically detects when responses exceed limits

### 2. **Response Caching**
- Caches full Codex responses for 10 minutes
- Allows pagination without re-calling Codex CLI
- Automatic cache cleanup for memory management

### 3. **Smart Chunking**
- Breaks responses at word boundaries when possible
- Preserves code blocks and formatting
- Provides pagination metadata

## Usage

### Basic Usage (Auto-pagination)
```typescript
// First call - gets page 1 automatically
await mcp.callTool('consult_codex', {
  prompt: 'Explain how React hooks work in detail with examples'
})
```

### Explicit Pagination
```typescript
// Get specific page
await mcp.callTool('consult_codex', {
  prompt: 'Explain how React hooks work in detail with examples',
  page: 2,
  max_tokens_per_page: 15000  // Optional: adjust page size
})
```

### Advanced Options
```typescript
await mcp.callTool('consult_codex', {
  prompt: 'Generate a complete REST API with documentation',
  context: 'Node.js Express application',
  model: 'gpt-5',
  page: 1,
  max_tokens_per_page: 20000,  // Max allowed: 20,000
  temperature: 0.3
})
```

## Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|--------|-------------|
| `page` | number | 1 | 1+ | Page number to retrieve |
| `max_tokens_per_page` | number | 18000 | 5000-20000 | Maximum tokens per page |

## Response Format

### Single Page Response
```
[Your Codex response content here]
```

### Multi-Page Response
```
[Your Codex response content here]

--- Page 1 of 3 ---
📊 Tokens: ~18000 (of ~45000 total)
⏭️  Use page=2 for next chunk
🔍 Request ID: req_abc123
```

## Benefits

1. **✅ MCP Compliance**: Never exceeds 25k token limit
2. **🚀 Performance**: Caching prevents redundant Codex calls
3. **🧠 Memory Efficient**: Automatic cache cleanup
4. **🎯 Flexible**: Adjustable page sizes and intelligent chunking
5. **📊 Transparent**: Clear pagination metadata

## Cache Behavior

- **TTL**: 10 minutes
- **Scope**: Per unique prompt+context+model combination
- **Cleanup**: Automatic (probabilistic, ~10% chance per request)
- **Memory**: Bounded by TTL expiration

## Error Handling

- **Page > 1 without cache**: "Please start with page 1"
- **Invalid page numbers**: Automatically clamped to valid range
- **Codex CLI errors**: Passed through with clear error messages
- **Token estimation**: Conservative to prevent edge cases

## Technical Details

### Token Estimation Formula
```typescript
estimatedTokens = Math.ceil(characters / 3.5)
```

### Cache Key Generation
```typescript
cacheKey = hash(prompt + context + model)
```

### Word Boundary Breaking
- Looks for spaces, newlines, punctuation within 200 chars of cut point
- Falls back to hard character limit if no good break point
- Adds "..." indicator for truncated chunks

This solution eliminates the 25k token limit error while maintaining full compatibility with existing MCP clients.