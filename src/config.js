// Configuration management
// Uses environment variables or a config.json file

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

function loadConfig() {
  // Try loading from config.json first
  const configPath = join(PROJECT_ROOT, 'config.json');
  if (existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      // Environment variables take precedence
      return {
        baleToken: process.env.BALE_BOT_TOKEN || fileConfig.baleToken,
        usersFile: resolve(PROJECT_ROOT, process.env.USERS_FILE || fileConfig.usersFile || 'users.json'),
        freebuffPath: process.env.FREEBUFF_PATH || fileConfig.freebuffPath || 'freebuff',
        sessionTimeoutMs: process.env.SESSION_TIMEOUT_MS
          ? Number(process.env.SESSION_TIMEOUT_MS)
          : fileConfig.sessionTimeoutMs || 30 * 60 * 1000, // 30 min
        maxOutputLength: process.env.MAX_OUTPUT_LENGTH
          ? Number(process.env.MAX_OUTPUT_LENGTH)
          : fileConfig.maxOutputLength || 3500, // Telegram/Bale message limit
        pollTimeout: process.env.POLL_TIMEOUT
          ? Number(process.env.POLL_TIMEOUT)
          : fileConfig.pollTimeout || 30,
        freebuffWorkingDir: process.env.FREEBUFF_WORKING_DIR
          || fileConfig.freebuffWorkingDir
          || process.cwd(),
        responseWaitMs: process.env.RESPONSE_WAIT_MS
          ? Number(process.env.RESPONSE_WAIT_MS)
          : fileConfig.responseWaitMs || 60_000,
      };
    } catch {
      // Fall through to env-only config
    }
  }

  return {
    baleToken: process.env.BALE_BOT_TOKEN,
    usersFile: resolve(PROJECT_ROOT, process.env.USERS_FILE || 'users.json'),
    freebuffPath: process.env.FREEBUFF_PATH || 'freebuff',
    sessionTimeoutMs: process.env.SESSION_TIMEOUT_MS
      ? Number(process.env.SESSION_TIMEOUT_MS)
      : 30 * 60 * 1000,
    maxOutputLength: process.env.MAX_OUTPUT_LENGTH
      ? Number(process.env.MAX_OUTPUT_LENGTH)
      : 3500,
    pollTimeout: process.env.POLL_TIMEOUT
      ? Number(process.env.POLL_TIMEOUT)
      : 30,
    freebuffWorkingDir: process.env.FREEBUFF_WORKING_DIR || process.cwd(),
    responseWaitMs: process.env.RESPONSE_WAIT_MS
      ? Number(process.env.RESPONSE_WAIT_MS)
      : 60_000,
  };
}

const config = loadConfig();

if (!config.baleToken) {
  console.error('❌ BALE_BOT_TOKEN is required. Set it in config.json or as an environment variable.');
  console.error('   Create a bot via @BotFather in Bale, then set the token.');
  process.exit(1);
}

export default config;
