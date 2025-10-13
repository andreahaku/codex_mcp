# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server that bridges OpenAI's Codex CLI with Claude Code. It enables Claude to leverage Codex capabilities for coding assistance through a persistent process architecture with workspace isolation.

**Key Architecture Principle:** The server maintains long-lived Codex processes per session/workspace, avoiding cold starts and providing 80% faster responses compared to spawning new processes for each request.

## Development Commands

### Build & Run
```bash
pnpm run build          # Compile TypeScript to dist/
pnpm run dev            # Development mode with hot reload (tsx watch)
pnpm run clean          # Remove dist/ directory
```

### Testing
```bash
pnpm run test           # Run Jest test suite
pnpm run test:watch     # Run tests in watch mode
pnpm run test:coverage  # Generate coverage report
```

### Installation & Setup
```bash
./install.sh            # Automated: dependencies + Codex CLI + build + config + tests
./start.sh              # Start the MCP server (production mode)
pnpm run start:local    # Start server locally (same as ./start.sh)
```

## Architecture

### Core Components

**index.ts** (MCP Server)
- Main entry point exposing 8 MCP tools via stdio transport
- Handles tool registration, request routing, and response formatting
- Manages response caching with TTL for pagination support
- Processes MCP resources (attached files) and converts to text context
- Tool naming convention: `ask`, `chat_start`, `chat_msg`, `cancel`, `status`, `restart`, `plan`, `patch`

**session-manager.ts** (Session Management)
- Manages lifecycle of CodexProcess instances per session
- Implements workspace-based session isolation using `workspaceId` (MD5 hash of repo path + git HEAD)
- Auto-cleanup of idle sessions (default: 30 min timeout)
- Capacity management (default: max 10 concurrent sessions)
- Health monitoring and restart capabilities

**codex-process-simple.ts** (Codex CLI Wrapper)
- Wraps Codex CLI execution using `child_process.exec`
- Capability detection at startup (JSON support, available models, streaming, plan API, etc.)
- Shell argument escaping for complex prompts with special characters
- Response parsing to extract clean Codex output (strips timestamps and metadata)
- Timeout handling (default: 120s per command)

**conversation.ts** (Conversation Management)
- Legacy conversation system (prefer session-based approach)
- Manages multi-turn conversations with context window limits
- Supports developer instructions (system messages)
- Message history trimming based on `MAX_CONVERSATION_CONTEXT`

**logger.ts** (Structured Logging)
- Winston-based structured logging with JSON output
- Context-aware logging methods: `logSessionEvent`, `logMCPRequest`, `logError`, `logCodexCommand`
- Log levels: debug, info, warn, error (configurable via `LOG_LEVEL` env var)

**error-types.ts & error-utils.ts** (Error Handling)
- Categorizes errors into: `CODEX_CLI`, `SESSION_MANAGEMENT`, `MCP_PROTOCOL`, `RESOURCE`
- Creates rich error context for debugging (session ID, workspace, request ID, tool name)
- Maps error codes to user-friendly messages with recovery suggestions

**token-utils.ts** (Pagination)
- Token estimation using character count heuristics
- Response chunking for large outputs (default: 18k tokens per page)
- Formatted pagination with page indicators and cache key tracking

**types.ts** (TypeScript Definitions)
- Shared types for conversations, messages, and metadata
- Ensures type safety across components

### Session vs Conversation System

**Use Sessions** (Recommended):
- Session IDs are workspace-aware and persist process state
- Automatically created if not provided (`session_${requestId}`)
- Reuse existing Codex processes for faster responses
- Accessed via `ask` tool with `sid` parameter

**Use Conversations** (Legacy):
- Multi-turn conversations with explicit conversation management
- Accessed via `chat_start` and `chat_msg` tools
- Consider migrating to session-based approach for better performance

### Tool Design Philosophy

1. **ask** - Primary entry point, handles 90% of use cases (single prompts, sessions, resources)
2. **chat_start/chat_msg** - Explicit multi-turn conversations (legacy pattern)
3. **status/cancel/restart** - Session lifecycle management
4. **plan/patch** - Advanced Codex features (if supported by CLI)

All tools return MCP-compatible content objects with `type: 'text'` and formatted response text.

## Environment Configuration

Create `.env` file in project root:

```bash
# Conversation limits
MAX_CONVERSATIONS=50              # Max concurrent conversations
MAX_CONVERSATION_HISTORY=100      # Max messages per conversation
MAX_CONVERSATION_CONTEXT=10       # Max context messages sent to Codex

# Session limits
MAX_SESSIONS=10                   # Max concurrent Codex sessions
SESSION_IDLE_TIMEOUT=1800000      # Idle timeout (ms) - default 30 min

# Logging
LOG_LEVEL=info                    # debug | info | warn | error
```

## Key Implementation Details

### Workspace Isolation
Sessions are isolated by workspace using a generated `workspaceId`:
```typescript
// src/session-manager.ts:327-349
private generateWorkspaceId(workspacePath: string): string {
  // Uses git HEAD + path for stable workspace identification
  // Falls back to path-only hash if not a git repo
}
```

### Response Caching
Responses are cached for pagination with 10-minute TTL:
```typescript
// src/index.ts:36-58
const responseCache = new Map<string, { response: string; timestamp: number; ttl: number }>();
// Cache key: hash of prompt + sessionId + context + model
```

### Shell Escaping
Complex prompts with special characters require proper escaping:
```typescript
// src/codex-process-simple.ts:223-233
private escapeShellArgument(arg: string): string {
  // Wraps in single quotes, escapes embedded single quotes with '\''
}
```

### Resource Processing
Attached files/resources from MCP clients are processed into text context:
```typescript
// src/index.ts:124-179
async function processResources(meta?: any): Promise<string>
// Handles: resources array, content array, text fields
// Returns formatted sections with headers/footers
```

## Testing Strategy

- Unit tests should mock `child_process.exec` for Codex CLI calls
- Test fixtures should include sample Codex responses with metadata
- Session manager tests should verify workspace isolation and cleanup
- Error handling tests should cover all error categories

## Common Patterns

### Adding a New MCP Tool
1. Define Zod schema (e.g., `FooSchema`) with parameter descriptions
2. Create handler function (`async function handleFoo(args: any): Promise<any>`)
3. Register in `ListToolsRequestSchema` handler with tool metadata
4. Add case in `CallToolRequestSchema` switch statement
5. Update README.md tool list

### Extending Capability Detection
Modify `detectCapabilities()` in `codex-process-simple.ts`:
- Add new test queries to Codex CLI
- Parse help output for feature detection
- Update `CodexCapabilities` interface in types
- Log detected capabilities for debugging

### Session Lifecycle Hooks
Session events are logged via structured logger:
- `created` - New session initialized
- `restart` - Session restarted after error
- Process event handlers in `setupProcessEventHandlers()`

## Performance Considerations

- **Persistent processes**: Sessions reuse Codex processes, avoiding ~2s startup cost per request
- **Response caching**: Reduces redundant Codex calls for paginated responses
- **Workspace isolation**: Multiple projects can run concurrently without interference
- **Idle cleanup**: Automatic session cleanup prevents memory leaks
- **Buffer limits**: `maxBuffer: 10MB` for exec operations (src/codex-process-simple.ts:118)

## Integration with Claude Code

This server is designed for Claude Code integration via MCP protocol. Key integration points:

1. **Session ID unification**: Use same `sid` across tools for context persistence
2. **Resource attachment**: Claude Code can attach files, which are processed into context
3. **Streaming support**: Framework exists but disabled for exec-based approach (set `streaming: false`)
4. **Error recovery**: Structured error categories help Claude Code suggest fixes to users

## Dependencies

- **@modelcontextprotocol/sdk**: MCP protocol implementation
- **zod**: Schema validation for tool parameters
- **zod-to-json-schema**: Convert Zod schemas to JSON Schema for MCP
- **winston**: Structured logging
- **dotenv**: Environment variable management

Requires **Codex CLI** installed globally (`npm install -g @openai/codex` or `brew install codex`).

## Notes

- TypeScript compilation uses Node16 module resolution with ES2022 target
- All paths must use `.js` extensions for ESM imports
- Project uses pnpm (v10.17.1+) as package manager
- Entry point is executable: `#!/usr/bin/env node` in dist/index.js
