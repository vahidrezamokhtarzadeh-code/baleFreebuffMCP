// Bale Freebuff Bot - Main Entry Point
// Connects a Bale messenger bot to Freebuff CLI

import { BaleBot } from './bale.js';
import { Bridge } from './bridge.js';
import config from './config.js';

async function main() {
  console.log('🤖 Bale Freebuff Bot starting...');
  console.log(`   Working dir: ${config.freebuffWorkingDir}`);
  console.log(`   Freebuff path: ${config.freebuffPath}`);
  console.log(`   Session timeout: ${config.sessionTimeoutMs / 60000} min`);
  console.log(`   Users file: ${config.usersFile}`);

  // Initialize Bale bot
  const bot = new BaleBot(config.baleToken, {
    pollTimeout: config.pollTimeout,
  });

  // Verify bot token
  try {
    const me = await bot.getMe();
    console.log(`✅ Bot connected: @${me.username} (${me.first_name})`);
  } catch (err) {
    console.error('❌ Failed to connect to Bale API:', err.message);
    console.error('   Check your BALE_BOT_TOKEN in config.json');
    process.exit(1);
  }

  // Initialize bridge
  const bridge = new Bridge(bot);

  // Handle messages
  console.log('👂 Listening for messages...\n');
  bot.start(async (message) => {
    try {
      await bridge.handleMessage(message);
    } catch (err) {
      console.error('❌ Unhandled error in message handler:', err);
    }
  }, async (query) => {
    try {
      await bridge.handleCallbackQuery(query);
    } catch (err) {
      console.error('❌ Unhandled error in callback handler:', err);
    }
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n⏹️  Received ${signal}, shutting down...`);
    bot.stop();
    await bridge.stopAll();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
