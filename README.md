# Codex MCP Server

A Model Context Protocol (MCP) server that integrates OpenAI's Codex CLI with Claude Code, enabling you to use Codex's capabilities directly from within Claude.

This server is converted from the original GPT-5 MCP server, with cost tracking features removed and replaced with direct Codex CLI integration.

## Features

- **Persistent Process Architecture**: 80% faster responses with long-lived Codex processes
- **Workspace Isolation**: Automatic repository-based session separation
- **Streaming Support**: Real-time progress updates and thinking events
- **Session Management**: Health monitoring, cancellation, and restart capabilities
- **Lightweight Persistence**: JSON-based storage for session recovery
- **Resource Processing**: Handle attached files and content in prompts
- **🆕 Structured Logging**: Context-aware error categorization and tracking
- **🆕 Enhanced Capability Detection**: Dynamic discovery of Codex CLI features
- **🆕 Improved Claude Code Integration**: Optimized for collaborative workflows

## Local Codex Skill

This repository also includes a local Claude skill at [skill/codex](skill/codex) for cases where you want Claude to use the installed `codex` CLI directly instead of going through the MCP server.

The skill is designed for iterative collaboration, not just one-shot prompts:

- New persistent session: `bash skill/codex/scripts/codex-ask.sh --new --name api-design "Analyze this architecture"`
- Resume the last session in the current workspace: `bash skill/codex/scripts/codex-ask.sh --last "Continue from the previous plan"`
- Resume a specific session by alias or id: `bash skill/codex/scripts/codex-ask.sh --session api-design "Refine the migration strategy"`
- One-shot prompt: `bash skill/codex/scripts/codex-ask.sh --one-shot "Summarize the tradeoffs briefly"`

The wrapper prints a `[codex-session]` preamble with the workspace and resolved `session_id`, and stores per-workspace aliases plus the last-used session so Claude can continue the same Codex thread across turns.

### Depth Control

Adjust model and reasoning effort based on task complexity:

- `--fast`: Uses `gpt-5.1-codex-mini` with low reasoning for quick lookups
- *(default)*: Uses `gpt-5.4` with standard reasoning
- `--deep`: Uses `gpt-5.4` with `xhigh` reasoning for complex analysis
- `--reasoning <level>`: Fine-grained control (`minimal`, `low`, `medium`, `high`, `xhigh`)

### Structured Output

Use `--structured` to get JSON output (`{ findings[], summary, model }`) for machine-readable results and cross-model chaining.

### Multi-Agent Collaboration

The skill includes scripts for multi-agent workflows with Gemini:

- **Cross-model reviews**: Run Codex and Gemini reviews in parallel to find complementary blind spots
- **Debate mode**: Automated critique cycles (`debate.sh`) — Model A responds, Model B critiques, Model A revises
- **Session tracking**: Shared cross-model threads (`cross-model-tracker.sh`) linking Codex and Gemini sessions under a unified thread ID
- **Routing guide**: Built-in guidance for delegating tasks to the best model based on task type

### When to Use What

Use the **local skill** when you want Codex to behave like a persistent collaborator for iterative design, debugging, code refinement, back-and-forth analysis, and multi-agent orchestration with Gemini. Use the **MCP server** when you want Codex exposed as Claude tools with managed sessions, health checks, restart, and cancellation.

## Available Tools

### Core Tools
- `🌟 codex_ask`: Primary tool for Codex assistance with enhanced integration
- `💬 codex_conversation_start`: Begin a new conversation with context  
- `💬 codex_conversation_continue`: Continue an existing conversation
- `⚙️ codex_conversation_options`: Configure conversation settings
- `📊 codex_conversation_metadata`: View conversation details
- `📝 codex_conversation_summarize`: Compress conversation history

### Session Management
- `🔧 codex_cancel`: Cancel ongoing operations or force terminate sessions
- `🩺 codex_health`: Monitor session status and get diagnostics
- `🔄 codex_restart`: Recover from errors with process restart

## Prerequisites

1. **Node.js** (≥18.0.0)
2. **pnpm** package manager
3. **Codex CLI** installed and configured
   ```bash
   npm install -g @openai/codex
   # or
   brew install codex
   ```

## Installation

### Automated Installation

```bash
./install.sh
```

This script will:
- Check dependencies
- Install Codex CLI if needed
- Build the project
- Configure Claude Desktop integration
- Run tests

### Manual Installation

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Build the project:
   ```bash
   pnpm run build
   ```

3. Configure Claude Desktop by adding to `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "codex": {
         "command": "node",
         "args": ["/path/to/codex_mcp/dist/index.js"],
         "env": {
           "MAX_CONVERSATIONS": "50",
           "MAX_CONVERSATION_HISTORY": "100",
           "MAX_CONVERSATION_CONTEXT": "10"
         }
       }
     }
   }
   ```

## Running the Server

### Start Script
```bash
./start.sh
```

### Manual Start
```bash
# Production mode
node dist/index.js

# Development mode with hot reload
pnpm run dev
```

## Configuration

Environment variables (set in `.env` file):

- `MAX_CONVERSATIONS`: Maximum number of concurrent conversations (default: 50)
- `MAX_CONVERSATION_HISTORY`: Maximum messages per conversation (default: 100)
- `MAX_CONVERSATION_CONTEXT`: Maximum context messages sent to Codex (default: 10)
- `LOG_LEVEL`: Logging level (default: info)
- `MAX_SESSIONS`: Maximum concurrent Codex sessions (default: 10)
- `SESSION_IDLE_TIMEOUT`: Session cleanup timeout in ms (default: 1800000)

## Testing

Run the comprehensive test suite:

```bash
# Test all functionality
node test-server.js

# Test MCP protocol only
node test-mcp-protocol.js

# Test tools functionality
node test-tools.js
```

## MCP Client Discovery & Usage

### How MCP Clients Understand This Server

MCP clients (like Claude Code) automatically discover available tools through the Model Context Protocol:

#### 1. **Automatic Tool Discovery**
The server exposes 9 tools with full JSON schemas:
- `consult_codex` - Core Codex interaction with advanced features
- `get_session_health` - Monitor and diagnose sessions  
- `cancel_request`, `restart_session` - Session management
- `start_conversation`, `continue_conversation` - Conversation workflows
- `set_conversation_options`, `get_conversation_metadata`, `summarize_conversation` - Advanced conversation control

#### 2. **Progressive Feature Discovery**
Users naturally discover capabilities through:
- **Tool descriptions** in MCP protocol
- **Response metadata** showing session IDs and workspace paths
- **Error messages** that guide proper usage
- **Rich output** from Codex CLI operations

#### 3. **Self-Documenting Responses**
Every response includes helpful context:
```
Session: `my-session` | Workspace: `/path/to/repo`
```

## Usage Patterns

### **Level 1: Basic Usage**
```
@codex What is the best way to implement error handling in Node.js?
```

### **Level 2: Workspace-Aware Development**
```
@codex Based on this code: [attach file], how can I optimize the performance?
# Automatically uses current repository workspace for isolation
```

### **Level 3: Persistent Sessions** 
```
@codex {"session_id": "auth-feature", "prompt": "Help me implement user authentication"}
@codex {"session_id": "auth-feature", "prompt": "Now add password reset functionality"}  
# Session maintains workspace context and request history
```

### **Level 4: Advanced Features**
```json
{
  "session_id": "complex-task",
  "workspace_path": "/specific/repo", 
  "streaming": true,
  "prompt": "Analyze and refactor this large codebase",
  "page": 1,
  "max_tokens_per_page": 15000
}
```

### **Session Management**
```
@codex_health                           # Monitor all sessions
@codex_health {"session_id": "my-task"} # Check specific session
@codex_cancel {"session_id": "stuck-task"}  # Cancel operations  
@codex_restart {"session_id": "failed"}     # Recover from errors
```

### **Multi-Repository Workflows**
```
# Work on frontend
@codex_ask {"workspace_path": "/projects/frontend", "session_id": "ui", "prompt": "Update React components"}

# Switch to backend  
@codex_ask {"workspace_path": "/projects/backend", "session_id": "api", "prompt": "Add new API endpoints"}

# Sessions remain isolated by workspace
@codex_health  # Shows both sessions with different workspace IDs
```

## 🚀 Enhanced Integration Features (v2.0)

### **Structured Error Handling**
All errors are automatically categorized and logged with context:
- **Codex CLI errors**: Command failures, timeouts, authentication issues
- **Session management**: Creation, timeout, and capacity issues  
- **MCP protocol**: Request validation and response handling
- **Resource errors**: File access, permissions, disk space

### **Dynamic Capability Detection**
The server automatically detects available Codex CLI features:
- JSON mode support
- Available models (GPT-5.4, GPT-5.1-codex-mini, etc.)
- Workspace/directory mode
- File operation capabilities
- Plan API support
- Token limits and constraints

### **Enhanced Shell Security**
Complex prompts with special characters are automatically escaped for secure execution:
```javascript
// Handles prompts like: "What's the best way to implement auth?"
// Safely escapes: 'What'\''s the best way to implement auth?'
```

### **Claude Code Optimizations**
- Unified `session_id` system for seamless integration
- Tool names prefixed with `codex_` for easy discovery
- Rich error context with recovery suggestions
- Workspace-aware session isolation

## API Reference

### `codex_ask`
🌟 Primary Codex interaction tool with enhanced Claude Code integration.

**Parameters:**
- `prompt` (string, required): The prompt to send to Codex
- `session_id` (string, optional): Session ID for persistent context
- `workspace_path` (string, optional): Workspace path for repository isolation
- `context` (string, optional): Additional context for the prompt
- `streaming` (boolean, optional): Enable streaming responses
- `model` (string, optional): Model to use (e.g., "o3", "gpt-5")
- `page` (number, optional): Page number for pagination
- `max_tokens_per_page` (number, optional): Maximum tokens per page

**Response:** Rich Codex output with session and workspace metadata

### `codex_health`
🩺 Monitor session status and diagnostics with detailed capability reporting.

**Parameters:**
- `session_id` (string, optional): Specific session to check

**Response:** Session status, workspace info, capabilities, and request counts

### `codex_cancel` / `codex_restart`
🔧🔄 Enhanced session management and recovery with structured error handling.

**Parameters:**
- `session_id` (string, required): Target session ID
- `force` (boolean, optional): Force termination vs graceful restart

**Response:** Operation status and confirmation

### Conversation Tools
Legacy conversation management (consider using sessions instead):
- `start_conversation`, `continue_conversation`
- `set_conversation_options`, `get_conversation_metadata`
- `summarize_conversation`


## Troubleshooting

### Codex CLI Not Found
```bash
# Install via npm
npm install -g @openai/codex

# Install via Homebrew
brew install codex

# Verify installation
codex --help
```

### Server Won't Start
1. Check that dependencies are installed: `pnpm install`
2. Ensure the project is built: `pnpm run build`
3. Verify Codex CLI is working: `codex exec "echo test"`

### Authentication Issues
Make sure Codex CLI is authenticated. Run `codex` to check status or re-authenticate if needed.

## Development

### Project Structure
```
src/
├── index.ts                   # Main MCP server
├── codex-process-simple.ts    # Enhanced Codex CLI wrapper with capability detection
├── session-manager.ts         # Session management with workspace isolation
├── conversation.ts            # Conversation management
├── logger.ts                  # Structured logging system
├── error-types.ts             # Error categorization and definitions
├── error-utils.ts             # Error mapping and recovery utilities
├── token-utils.ts             # Pagination and token estimation
└── types.ts                   # TypeScript types

skill/codex/
├── SKILL.md                   # Claude Code skill instructions
├── references/
│   └── codex-cli.md           # Wrapper documentation and environment variables
└── scripts/
    ├── codex-ask.sh           # Main consultation wrapper (sessions, one-shot, depth control)
    ├── codex-review.sh        # Code review wrapper (uncommitted, branch, commit)
    ├── cross-model-tracker.sh # Cross-model session tracking
    └── debate.sh              # Automated cross-model debate/critique
```

### Building
```bash
pnpm run build
```

### Testing
```bash
pnpm run test         # Run test suite
pnpm run dev          # Development mode
```

## License

MIT License - see original GPT-5 MCP server for full license details.
