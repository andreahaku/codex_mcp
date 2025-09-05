#!/usr/bin/env node

// Test MCP tools functionality
import { spawn } from 'child_process';

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

async function testTool(toolName, args) {
  log(`🔧 Testing tool: ${toolName}`, colors.blue);
  
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
        const lines = output.split('\n').filter(line => line.trim());
        for (const line of lines) {
          if (line.trim()) {
            const response = JSON.parse(line);
            if (response.id === 2 && response.result) {
              log(`✅ ${toolName} responded successfully`, colors.green);
              if (response.result.content && response.result.content[0]) {
                const content = response.result.content[0].text;
                const preview = content.substring(0, 100);
                log(`Response: ${preview}${content.length > 100 ? '...' : ''}`, colors.cyan);
              }
              responseReceived = true;
              server.kill('SIGTERM');
              return;
            } else if (response.id === 2 && response.error) {
              log(`❌ ${toolName} returned error: ${response.error.message}`, colors.red);
              responseReceived = true;
              server.kill('SIGTERM');
              resolve(false);
              return;
            }
          }
        }
      } catch (e) {
        // Not JSON, might be startup message
        if (output.includes('Codex MCP Server is running')) {
          log('Server started, sending tool request...', colors.blue);
          
          // Send tool request
          const request = {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: args
            }
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
        resolve(true);
      } else {
        log(`❌ ${toolName} test failed`, colors.red);
        log(`Exit code: ${code}`, colors.red);
        if (stderr) {
          log('Stderr:', colors.red);
          console.log(stderr.substring(0, 500));
        }
        resolve(false);
      }
    });
    
    server.on('error', (error) => {
      log(`❌ Server error: ${error.message}`, colors.red);
      resolve(false);
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      if (!responseReceived) {
        log(`❌ ${toolName} test timeout`, colors.red);
        server.kill('SIGKILL');
        resolve(false);
      }
    }, 30000);
  });
}

async function runToolTests() {
  log('🧪 Testing Codex MCP Tools', colors.cyan);
  log('===========================', colors.cyan);
  
  const tests = [
    {
      name: 'consult_codex',
      args: { prompt: 'What is 2 + 2? Give a brief answer.' }
    },
    {
      name: 'start_conversation',
      args: { topic: 'Test conversation', instructions: 'Be helpful and concise' }
    }
  ];
  
  const results = [];
  
  for (const test of tests) {
    try {
      const result = await testTool(test.name, test.args);
      results.push({ name: test.name, passed: result });
    } catch (error) {
      log(`❌ Test error: ${error.message}`, colors.red);
      results.push({ name: test.name, passed: false });
    }
    
    // Brief pause between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Summary
  log('\n🏁 Tool Test Results', colors.cyan);
  log('===================', colors.cyan);
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  results.forEach(result => {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    const color = result.passed ? colors.green : colors.red;
    log(`${status} ${result.name}`, color);
  });
  
  log(`\nOverall: ${passed}/${total} tools tested successfully`, passed === total ? colors.green : colors.red);
  
  if (passed === total) {
    log('\n🎉 All tools are working correctly!', colors.green);
  } else {
    log('\n⚠️  Some tools failed. Check Codex CLI configuration.', colors.yellow);
  }
  
  return passed === total;
}

// Run tests
runToolTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});