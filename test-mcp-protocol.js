#!/usr/bin/env node

// Test MCP protocol communication
import { spawn } from 'child_process';

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

async function testMCPProtocol() {
  log('🧪 Testing MCP Protocol Communication', colors.cyan);
  
  return new Promise((resolve) => {
    const server = spawn('node', ['dist/index.js'], { 
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let responseReceived = false;
    let stdout = '';
    let stderr = '';
    
    server.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      
      try {
        // Try to parse as JSON RPC response
        const lines = output.split('\n').filter(line => line.trim());
        for (const line of lines) {
          if (line.trim()) {
            const response = JSON.parse(line);
            if (response.result && response.result.tools) {
              log('✅ MCP Server responded with tools list', colors.green);
              log(`Found ${response.result.tools.length} tools:`, colors.cyan);
              response.result.tools.forEach(tool => {
                log(`  - ${tool.name}: ${tool.description}`, colors.blue);
              });
              responseReceived = true;
              server.kill('SIGTERM');
              return;
            }
          }
        }
      } catch (e) {
        // Not JSON, might be startup message
        if (output.includes('Codex MCP Server is running')) {
          log('✅ Server started, sending tools request...', colors.green);
          
          // Send list tools request
          const request = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {}
          };
          
          server.stdin.write(JSON.stringify(request) + '\n');
        }
      }
    });
    
    server.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    server.on('close', (code) => {
      if (responseReceived) {
        log('✅ MCP Protocol test passed', colors.green);
        resolve(true);
      } else {
        log('❌ MCP Protocol test failed', colors.red);
        log(`Exit code: ${code}`, colors.red);
        log('Stdout:', colors.blue);
        console.log(stdout);
        log('Stderr:', colors.red);
        console.log(stderr);
        resolve(false);
      }
    });
    
    server.on('error', (error) => {
      log(`❌ Server error: ${error.message}`, colors.red);
      resolve(false);
    });
    
    // Timeout after 10 seconds
    setTimeout(() => {
      if (!responseReceived) {
        log('❌ MCP Protocol test timeout', colors.red);
        server.kill('SIGKILL');
        resolve(false);
      }
    }, 10000);
  });
}

// Run the test
testMCPProtocol().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test error:', error);
  process.exit(1);
});