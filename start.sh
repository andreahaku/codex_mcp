#!/bin/bash

# Codex MCP Server Startup Script

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Print colored output
print_info() { echo -e "${BLUE}ℹ${NC} $1"; }
print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }

# Clear screen for better UX
clear

# Banner
echo -e "${CYAN}"
echo "┌─────────────────────────────────┐"
echo "│   Codex MCP Server Launcher     │"
echo "└─────────────────────────────────┘"
echo -e "${NC}"

# Check if Codex CLI is installed
check_codex() {
    if ! command -v codex &> /dev/null; then
        print_error "Codex CLI is not installed!"
        echo ""
        echo "To install Codex CLI:"
        echo "  npm install -g @openai/codex"
        echo "  or"
        echo "  brew install codex"
        echo ""
        exit 1
    fi
}

# Check if .env exists
if [ ! -f .env ]; then
    print_info "Creating .env file for configuration..."
    cat > .env << EOF
# Codex MCP Server Configuration

# Conversation Limits
MAX_CONVERSATIONS=50
MAX_CONVERSATION_HISTORY=100
MAX_CONVERSATION_CONTEXT=10

# Logging
LOG_LEVEL=info
EOF
    print_success "Created .env file"
    echo ""
fi

# Check if dependencies are installed
check_dependencies() {
    if [ ! -d "node_modules" ]; then
        print_warning "Dependencies not installed"
        print_info "Installing dependencies..."
        pnpm install
        print_success "Dependencies installed"
        echo ""
    fi
}

# Check if TypeScript is built
check_build() {
    if [ ! -d "dist" ]; then
        print_warning "Project not built"
        print_info "Building project..."
        pnpm run build
        print_success "Build completed"
        echo ""
    fi
}

# Start local server
start_local() {
    print_info "Starting local Node.js server..."
    check_codex
    check_dependencies
    check_build
    
    echo ""
    print_success "Starting Codex MCP Server (Local)"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    # Load environment variables and start
    export $(grep -v '^#' .env | xargs)
    node dist/index.js
}

# Start development mode
start_dev() {
    print_info "Starting in development mode with hot reload..."
    check_codex
    check_dependencies
    
    echo ""
    print_success "Starting Codex MCP Server (Development)"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    pnpm run dev
}

# Main menu
show_menu() {
    echo "How would you like to run the Codex MCP Server?"
    echo ""
    echo -e "  ${CYAN}1)${NC} Local (Production)"
    echo -e "  ${CYAN}2)${NC} Local (Development with hot reload)"
    echo -e "  ${CYAN}3)${NC} Exit"
    echo ""
    read -p "Enter your choice [1-3]: " choice
    
    case $choice in
        1)
            start_local
            ;;
        2)
            start_dev
            ;;
        3)
            print_info "Exiting..."
            exit 0
            ;;
        *)
            print_error "Invalid choice. Please try again."
            echo ""
            show_menu
            ;;
    esac
}

# Handle Ctrl+C gracefully
trap 'echo ""; print_info "Server stopped"; exit 0' INT TERM

# Show current configuration
echo "Current Configuration:"
echo -e "  ${CYAN}•${NC} Working Directory: $(pwd)"

if [ -f .env ]; then
    # Extract some config values
    max_conversations=$(grep "MAX_CONVERSATIONS" .env | cut -d'=' -f2 || echo "50")
    max_history=$(grep "MAX_CONVERSATION_HISTORY" .env | cut -d'=' -f2 || echo "100")
    max_context=$(grep "MAX_CONVERSATION_CONTEXT" .env | cut -d'=' -f2 || echo "10")
    
    echo -e "  ${CYAN}•${NC} Max Conversations: $max_conversations"
    echo -e "  ${CYAN}•${NC} Max History per Conversation: $max_history"
    echo -e "  ${CYAN}•${NC} Max Context Messages: $max_context"
fi

echo ""

# Check Codex status
if command -v codex &> /dev/null; then
    print_success "Codex CLI is installed and ready"
else
    print_warning "Codex CLI is not installed - server will fail to start"
fi

echo ""

# Main execution
show_menu