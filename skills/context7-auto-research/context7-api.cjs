#!/usr/bin/env node

/**
 * Context7 API Helper Script
 * Provides simple CLI interface to Context7 API for skill integration
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://context7.com/api/v2';
const STDIN_TIMEOUT_MS = 3000;
const MAX_STDIN_BYTES = 100 * 1024;

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function buildErrorResult(commandName, error) {
  const message = error instanceof Error ? error.message : String(error);
  const result = {
    ok: false,
    fallback: 'local-knowledge',
    error: {
      command: commandName,
      message
    }
  };

  if (commandName === 'search') {
    result.libraries = [];
  } else if (commandName === 'context') {
    result.results = [];
  }

  return result;
}

function printErrorResult(commandName, error, exitCode = 1) {
  printJson(buildErrorResult(commandName, error));
  process.exit(exitCode);
}

function printUsage() {
  console.error(`Usage:
  context7-api.cjs search <libraryName> <query|->
  context7-api.cjs context <libraryId> <query|->

Examples:
  node context7-api.cjs search react "useEffect cleanup"
  node context7-api.cjs context /facebook/react -

Config:
  CONTEXT7_API_KEY from environment, or .env in the script directory`);
}

// Load API key from .env file in skill directory or from environment variable
function loadApiKey() {
  // First try environment variable
  if (process.env.CONTEXT7_API_KEY) {
    return process.env.CONTEXT7_API_KEY;
  }

  // Then try .env file in skill directory
  const envPath = path.join(__dirname, '.env');
  let envContent;
  try {
    envContent = fs.readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (key !== 'CONTEXT7_API_KEY') {
      continue;
    }
    return trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');
  }

  return null;
}

const API_KEY = loadApiKey();

function makeRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const queryString = new URLSearchParams(params).toString();
    const url = `${API_BASE}${path}?${queryString}`;
    const headers = {
      'User-Agent': 'Context7-Skill/1.0'
    };

    if (API_KEY) {
      headers.Authorization = `Bearer ${API_KEY}`;
    }

    const options = {
      headers
    };

    const req = https.get(url, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`API Error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error('Request timeout after 10s'));
    });

    req.on('error', reject);
  });
}

async function searchLibrary(libraryName, query) {
  return makeRequest('/libs/search', {
    libraryName,
    query
  });
}

async function getContext(libraryId, query) {
  return makeRequest('/context', {
    libraryId,
    query,
    type: 'json'
  });
}

// Read query from stdin (avoids all shell escaping issues)
function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error('Cannot read query from stdin: no piped input detected. Pass the query as an argument, or use - with piped stdin.'));
      return;
    }

    let data = '';
    let byteLength = 0;
    let timeoutId;

    function cleanup() {
      clearTimeout(timeoutId);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    }

    function fail(error) {
      cleanup();
      reject(error);
    }

    function resetTimeout() {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        fail(new Error('Timed out waiting for stdin query input. Pass the query as an argument, or pipe it with -.'));
      }, STDIN_TIMEOUT_MS);
    }

    function onData(chunk) {
      data += chunk;
      byteLength += Buffer.byteLength(chunk, 'utf8');
      if (byteLength > MAX_STDIN_BYTES) {
        fail(new Error(`Stdin query input exceeded ${MAX_STDIN_BYTES} bytes. Pass a shorter query.`));
        return;
      }
      resetTimeout();
    }

    function onEnd() {
      const query = data.trim();
      cleanup();
      if (!query) {
        reject(new Error('Stdin query input was empty. Pass a non-empty query as an argument, or pipe it with -.'));
        return;
      }
      resolve(query);
    }

    function onError(error) {
      fail(error);
    }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    resetTimeout();
    process.stdin.resume();
  });
}

async function resolveQuery(queryArgs) {
  if (queryArgs.length === 0) {
    return '';
  }

  if (queryArgs.length === 1 && queryArgs[0] === '-') {
    return readStdin();
  }

  if (queryArgs.includes('-')) {
    throw new Error('Invalid query arguments: when using -, it must be the only query argument.');
  }

  return queryArgs.join(' ');
}

// CLI Interface
const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command === 'search') {
    const libraryName = args[0];
    try {
      const query = await resolveQuery(args.slice(1));
      if (!libraryName || !query) {
        printErrorResult('search', new Error('Missing required arguments: search requires <libraryName> and a non-empty <query|->.'));
        return;
      }
      const result = await searchLibrary(libraryName, query);
      printJson(result);
    } catch (error) {
      printErrorResult('search', error);
    }
  } else if (command === 'context') {
    const libraryId = args[0];
    try {
      const query = await resolveQuery(args.slice(1));
      if (!libraryId || !query) {
        printErrorResult('context', new Error('Missing required arguments: context requires <libraryId> and a non-empty <query|->.'));
        return;
      }
      const result = await getContext(libraryId, query);
      printJson(result);
    } catch (error) {
      printErrorResult('context', error);
    }
  } else {
    printUsage();
    process.exit(1);
  }
}

main().catch((error) => {
  if (command === 'search' || command === 'context') {
    printErrorResult(command, error);
  }
  process.exit(1);
});
