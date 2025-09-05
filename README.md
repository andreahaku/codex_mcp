# Codex MCP Server

A Model Context Protocol (MCP) server that integrates OpenAI's Codex CLI with Claude Code, enabling you to use Codex's capabilities directly from within Claude.

This server is converted from the original GPT-5 MCP server, with cost tracking features removed and replaced with direct Codex CLI integration.

## Features

- **Direct Codex Integration**: Uses the Codex CLI for all AI interactions
- **No Cost Tracking**: Simplified version without API cost management
- **Conversation Management**: Maintain context across multiple interactions
- **Resource Processing**: Handle attached files and content in prompts

## Available Tools

- `consult_codex`: Get assistance from Codex for any task
- `start_conversation`: Begin a new conversation with context
- `continue_conversation`: Continue an existing conversation
- `set_conversation_options`: Configure conversation settings
- `get_conversation_metadata`: View conversation details
- `summarize_conversation`: Compress conversation history

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

### With Context
```
@codex Based on this code: [attach file], how can I optimize the performance?
```

### Conversations
```
@codex Start a conversation about React best practices
@codex Continue our React discussion - what about state management?
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