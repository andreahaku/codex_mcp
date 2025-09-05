#!/bin/bash

# Codex MCP Server Installation Script

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
print_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Banner
echo -e "${BLUE}"
echo "╔═══════════════════════════════════════╗"
echo "║      Codex MCP Server Installer       ║"
echo "╚═══════════════════════════════════════╝"
echo -e "${NC}"

# Check for required tools
check_requirements() {
    local missing_tools=()
    
    if ! command -v node &> /dev/null; then
        missing_tools+=("Node.js")
    fi
    
    if ! command -v pnpm &> /dev/null; then
        missing_tools+=("pnpm")
    fi
    
    if ! command -v codex &> /dev/null; then
        print_warning "Codex CLI not found - will be installed during setup"
    fi
    
    if [ ${#missing_tools[@]} -gt 0 ]; then
        print_error "Missing required tools: ${missing_tools[*]}"
        echo "Please install the missing tools and run this script again."
        exit 1
    fi
}

# Install Codex CLI
install_codex() {
    if ! command -v codex &> /dev/null; then
        print_info "Installing Codex CLI..."
        
        echo ""
        echo "Choose how to install Codex CLI:"
        echo "1) npm install -g @openai/codex"
        echo "2) brew install codex"
        echo "3) Skip and install manually"
        echo ""
        read -p "Enter your choice (1-3): " codex_choice
        
        case $codex_choice in
            1)
                npm install -g @openai/codex
                ;;
            2)
                if command -v brew &> /dev/null; then
                    brew install codex
                else
                    print_error "Homebrew not found. Please install it first."
                    return 1
                fi
                ;;
            3)
                print_warning "Please install Codex CLI manually before running the server"
                return 0
                ;;
            *)
                print_error "Invalid choice"
                return 1
                ;;
        esac
        
        if command -v codex &> /dev/null; then
            print_success "Codex CLI installed successfully"
        else
            print_error "Codex CLI installation failed"
            return 1
        fi
    else
        print_success "Codex CLI already installed"
    fi
}

# Setup environment file
setup_env() {
    if [ ! -f .env ]; then
        print_info "Setting up environment configuration..."
        
        cat > .env <<EOF
# Codex MCP Server Configuration

# Conversation Limits
MAX_CONVERSATIONS=50
MAX_CONVERSATION_HISTORY=100
MAX_CONVERSATION_CONTEXT=10

# Logging
LOG_LEVEL=info
EOF
        
        print_success "Created .env file"
    else
        print_info ".env file already exists"
    fi
}

# Build local installation
build_local() {
    print_info "Building local installation..."
    
    # Install dependencies
    print_info "Installing dependencies..."
    pnpm install
    
    # Build TypeScript
    print_info "Building TypeScript..."
    pnpm run build
    
    print_success "Local build completed successfully!"
}

# Configure Claude Desktop
configure_claude() {
    print_info "Configuring Claude Desktop integration..."
    
    local config_file=""
    local server_config=""
    local current_dir=$(pwd)
    
    # Determine config file location based on OS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        config_file="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        config_file="$HOME/.config/Claude/claude_desktop_config.json"
    else
        print_error "Unsupported operating system"
        return 1
    fi
    
    # Ask user for installation type
    echo ""
    echo "How would you like to configure the Codex MCP server for Claude?"
    echo "1) Local Node.js installation"
    echo "2) Skip Claude configuration"
    echo ""
    read -p "Enter your choice (1-2): " choice
    
    case $choice in
        1)
            server_config=$(cat <<EOF
    "codex": {
      "command": "node",
      "args": ["$current_dir/dist/index.js"],
      "env": {
        "MAX_CONVERSATIONS": "50",
        "MAX_CONVERSATION_HISTORY": "100",
        "MAX_CONVERSATION_CONTEXT": "10"
      }
    }
EOF
            )
            ;;
        2)
            print_info "Skipping Claude configuration"
            return 0
            ;;
        *)
            print_error "Invalid choice"
            return 1
            ;;
    esac
    
    # Create config directory if it doesn't exist
    mkdir -p "$(dirname "$config_file")"
    
    # Check if config file exists
    if [ -f "$config_file" ]; then
        print_warning "Claude config file already exists at: $config_file"
        echo ""
        echo "Add the following configuration to your mcpServers section:"
        echo ""
        echo "$server_config"
        echo ""
        echo "You can edit the file manually with: nano \"$config_file\""
    else
        # Create new config file
        cat > "$config_file" <<EOF
{
  "mcpServers": {
$server_config
  }
}
EOF
        print_success "Claude configuration created at: $config_file"
    fi
    
    echo ""
    print_info "Available MCP tools in Claude:"
    echo "  - consult_codex: Get assistance from Codex"
    echo "  - start_conversation: Start a new conversation"
    echo "  - continue_conversation: Continue an existing conversation"
    echo "  - set_conversation_options: Configure conversation settings"
    echo "  - get_conversation_metadata: View conversation details"
    echo "  - summarize_conversation: Summarize conversation history"
}

# Test the installation
test_installation() {
    print_info "Testing installation..."
    
    echo ""
    echo "Testing the Codex MCP server..."
    echo "The server will start briefly to test functionality"
    echo "Press Ctrl+C if it hangs"
    echo ""
    
    # Test local installation
    timeout 5 node dist/index.js 2>&1 | head -20 || true
    print_success "Installation test completed"
}

# Main installation flow
main() {
    check_requirements
    
    echo ""
    print_info "Starting Codex MCP Server installation..."
    echo ""
    
    # Install Codex CLI
    install_codex
    
    echo ""
    
    # Setup environment
    setup_env
    
    echo ""
    
    # Build local installation
    build_local
    
    echo ""
    configure_claude
    
    echo ""
    test_installation
    
    echo ""
    print_success "Installation completed!"
    echo ""
    echo "Next steps:"
    echo "1. Make sure Codex CLI is authenticated (run 'codex' to check)"
    echo "2. Restart Claude Desktop to load the new MCP server"
    echo "3. Use the Codex tools in Claude"
    echo ""
    echo "To start the server manually:"
    echo "  ./start.sh"
    echo ""
    print_info "For more information, see README.md"
}

# Run main function
main