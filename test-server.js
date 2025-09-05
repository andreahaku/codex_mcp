#!/usr/bin/env node

// Simple test script to verify Codex MCP Server functionality
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const LOG_FILE = 'test-results.log';

// Colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(`${color}${logMessage}${colors.reset}`);
  return fs.appendFile(LOG_FILE, logMessage + '\n').catch(() => {});
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testCodexConnection() {
  log('🔍 Testing Codex CLI connection...', colors.blue);
  
  return new Promise((resolve) => {
    const codex = spawn('codex', ['--help'], { stdio: 'pipe' });
    
    let stdout = '';
    let stderr = '';
    
    codex.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    codex.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    codex.on('close', (code) => {
      if (code === 0 && stdout.includes('Usage')) {
        log('✅ Codex CLI is working correctly', colors.green);
        resolve(true);
      } else {
        log('❌ Codex CLI test failed', colors.red);
        log(`Exit code: ${code}`, colors.red);
        log(`Stdout: ${stdout}`, colors.yellow);
        log(`Stderr: ${stderr}`, colors.red);
        resolve(false);
      }
    });
    
    codex.on('error', (error) => {
      log(`❌ Codex CLI error: ${error.message}`, colors.red);
      resolve(false);
    });
  });
}

async function testMCPServer() {
  log('🚀 Testing MCP Server startup...', colors.blue);
  
  return new Promise((resolve) => {
    const server = spawn('node', ['dist/index.js'], { 
      stdio: 'pipe',
      env: { ...process.env, LOG_LEVEL: 'error' } // Reduce log noise
    });
    
    let stdout = '';
    let stderr = '';
    let serverStarted = false;
    
    server.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      
      if (output.includes('Codex MCP Server is running')) {
        serverStarted = true;
        log('✅ MCP Server started successfully', colors.green);
        
        // Give it a moment then kill the server
        setTimeout(() => {
          server.kill('SIGTERM');
        }, 1000);
      }
    });
    
    server.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    server.on('close', (code) => {
      if (serverStarted) {
        log('✅ MCP Server stopped cleanly', colors.green);
        resolve(true);
      } else {
        log('❌ MCP Server failed to start properly', colors.red);
        log(`Exit code: ${code}`, colors.red);
        log(`Stdout: ${stdout}`, colors.yellow);
        log(`Stderr: ${stderr}`, colors.red);
        resolve(false);
      }
    });
    
    server.on('error', (error) => {
      log(`❌ MCP Server error: ${error.message}`, colors.red);
      resolve(false);
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      if (!serverStarted) {
        log('❌ MCP Server startup timeout', colors.red);
        server.kill('SIGKILL');
        resolve(false);
      }
    }, 30000);
  });
}

async function testSimpleCodexCall() {
  log('🧠 Testing simple Codex CLI call...', colors.blue);
  
  return new Promise((resolve) => {
    const codex = spawn('codex', ['exec', '--full-auto', '--skip-git-repo-check', 'Say "Hello from Codex!"'], { 
      stdio: 'pipe',
      timeout: 30000
    });
    
    let stdout = '';
    let stderr = '';
    
    codex.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    codex.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    codex.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        log('✅ Codex CLI call successful', colors.green);
        log(`Response: ${stdout.trim().substring(0, 100)}${stdout.length > 100 ? '...' : ''}`, colors.cyan);
        resolve(true);
      } else {
        log('❌ Codex CLI call failed', colors.red);
        log(`Exit code: ${code}`, colors.red);
        log(`Stdout: ${stdout}`, colors.yellow);
        log(`Stderr: ${stderr}`, colors.red);
        resolve(false);
      }
    });
    
    codex.on('error', (error) => {
      log(`❌ Codex CLI call error: ${error.message}`, colors.red);
      resolve(false);
    });
  });
}

async function runTests() {
  log('🧪 Starting Codex MCP Server Tests', colors.cyan);
  log('=====================================', colors.cyan);
  
  // Clear previous log
  try {
    await fs.unlink(LOG_FILE);
  } catch {}
  
  const tests = [
    { name: 'Codex CLI Connection', fn: testCodexConnection },
    { name: 'Simple Codex Call', fn: testSimpleCodexCall },
    { name: 'MCP Server Startup', fn: testMCPServer }
  ];
  
  const results = [];
  
  for (const test of tests) {
    log(`\n--- Running: ${test.name} ---`, colors.blue);
    try {
      const result = await test.fn();
      results.push({ name: test.name, passed: result });
    } catch (error) {
      log(`❌ Test error: ${error.message}`, colors.red);
      results.push({ name: test.name, passed: false });
    }
    await delay(1000); // Brief pause between tests
  }
  
  // Summary
  log('\n🏁 Test Results Summary', colors.cyan);
  log('======================', colors.cyan);
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  results.forEach(result => {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    const color = result.passed ? colors.green : colors.red;
    log(`${status} ${result.name}`, color);
  });
  
  log(`\nOverall: ${passed}/${total} tests passed`, passed === total ? colors.green : colors.red);
  
  if (passed === total) {
    log('\n🎉 All tests passed! The Codex MCP Server is ready to use.', colors.green);
    log('\nNext steps:', colors.blue);
    log('1. Configure Claude Desktop with this MCP server', colors.blue);
    log('2. Restart Claude Desktop', colors.blue);
    log('3. Try using the Codex tools in Claude', colors.blue);
  } else {
    log('\n⚠️  Some tests failed. Check the issues above.', colors.yellow);
    if (!results.find(r => r.name === 'Codex CLI Connection')?.passed) {
      log('\nCodex CLI may not be installed or configured properly.', colors.yellow);
      log('Install with: npm install -g @openai/codex', colors.yellow);
      log('Or: brew install codex', colors.yellow);
    }
  }
  
  log(`\nTest log saved to: ${path.resolve(LOG_FILE)}`, colors.cyan);
}

// Run tests
runTests().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});