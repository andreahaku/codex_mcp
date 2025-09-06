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

## Available Tools

### Core Tools
- `consult_codex`: Get assistance from Codex with persistent sessions, workspace isolation, and streaming support
- `start_conversation`: Begin a new conversation with context
- `continue_conversation`: Continue an existing conversation
- `set_conversation_options`: Configure conversation settings
- `get_conversation_metadata`: View conversation details
- `summarize_conversation`: Compress conversation history

### Session Management
- `cancel_request`: Cancel ongoing operations or force terminate sessions
- `get_session_health`: Monitor session status and get diagnostics
- `restart_session`: Recover from errors with process restart

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

## Usage in Claude

Once configured, you can use the following tools in Claude:

### Basic Usage
```
@codex What is the best way to implement error handling in Node.js?
```

### With Workspace Isolation
```
@codex Based on this code: [attach file], how can I optimize the performance?
# Automatically uses current repository workspace for isolation
```

### Persistent Sessions
```
@codex {"session_id": "my-feature", "prompt": "Help me implement user authentication"}
@codex {"session_id": "my-feature", "prompt": "Now add password reset functionality"}  
# Context preserved across requests
```

### Streaming Updates
```
@codex {"streaming": true, "prompt": "Refactor this large codebase"}
# See real-time thinking and progress events
```

### Session Management
```
@codex_health  # Check all session status
@codex_cancel {"session_id": "my-feature"}  # Cancel operations
@codex_restart {"session_id": "my-feature"}  # Recover from errors
```

## Differences from GPT-5 MCP Server

**Removed:**
- Cost tracking and reporting
- Budget limits and confirmations
- Token usage estimation
- OpenAI API integration

**Added:**
- Codex CLI integration
- Simplified configuration
- Git repo check bypass for programmatic usage

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
├── index.ts           # Main MCP server
├── codex-client.ts    # Codex CLI wrapper
├── conversation.ts    # Conversation management
└── types.ts          # TypeScript types
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