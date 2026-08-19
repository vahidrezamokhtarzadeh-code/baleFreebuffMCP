// Bridge between Bale bot messages and Freebuff sessions
// Simplified: send input → wait → grab response → send back
// No stream monitoring, no thinking indicator updates

import { FreebuffSession } from './freebuff.js';
import config from './config.js';

export class Bridge {
  constructor(baleBot) {
    this.baleBot = baleBot;
    this.sessions = new Map();
    this.processing = new Map();
  }

  isAuthorized(userId) {
    if (config.allowedUsers.length === 0) return true;
    return config.allowedUsers.includes(userId);
  }

  async handleMessage(message) {
    const chatId = message.chat?.id;
    const userId = message.from?.id;
    const text = message.text || '';

    console.log(`📩 [BRIDGE] Message from user=${userId} chat=${chatId}: "${text.substring(0, 100)}"`);

    if (!this.isAuthorized(userId)) {
      await this.baleBot.sendMessage(chatId, '⛔ دسترسی غیرمجاز.');
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, text);
      return;
    }

    if (text.trim()) {
      await this.sendToFreebuff(chatId, text);
    }
  }

  async handleCommand(chatId, text) {
    const command = text.split(' ')[0].toLowerCase();

    switch (command) {
      case '/start':
        await this.baleBot.sendMessage(chatId,
          '🤖 به Freebuff Bot خوش آمدید!\n\n' +
          '💬 هر پیام متنی بفرستید تا در Freebuff اجرا شود.\n\n' +
          '📌 دستورات:\n' +
          '/new - شروع session جدید\n' +
          '/stop - متوقف کردن session\n' +
          '/status - وضعیت session\n' +
          '/help - راهنما'
        );
        break;

      case '/help':
        await this.baleBot.sendMessage(chatId,
          '📖 راهنمای Freebuff Bot\n\n' +
          '💬 پیام متنی → اجرا در Freebuff\n' +
          '/new → session جدید\n' +
          '/stop → توقف session\n' +
          '/status → وضعیت فعلی'
        );
        break;

      case '/new':
        await this.stopSession(chatId);
        await this.baleBot.sendMessage(chatId, '🔄 Session جدید ایجاد شد.');
        break;

      case '/stop':
        await this.stopSession(chatId);
        await this.baleBot.sendMessage(chatId, '⏹️ Session متوقف شد.');
        break;

      case '/status': {
        const session = this.sessions.get(chatId);
        if (session && session.isAlive()) {
          const uptime = Math.round((Date.now() - session.sessionStartTime) / 60000);
          await this.baleBot.sendMessage(chatId,
            `📊 Session فعال (${uptime} دقیقه)\n📂 ${session.cwd}`
          );
        } else {
          await this.baleBot.sendMessage(chatId, '📊 Session فعالی نیست.');
        }
        break;
      }

      default:
        await this.baleBot.sendMessage(chatId, `❓ دستور ناشناخته: ${command}`);
    }
  }

  // ─── Core: Send to Freebuff ───────────────────────────────────

  async sendToFreebuff(chatId, text) {
    console.log(`🚀 [BRIDGE] sendToFreebuff chat=${chatId} text="${text.substring(0, 80)}"`);

    // Prevent concurrent sends
    if (this.processing.get(chatId)) {
      await this.baleBot.sendMessage(chatId, '⏳ لطفاً صبر کنید... پاسخ قبلی هنوز آماده نشده.');
      return;
    }

    this.processing.set(chatId, true);

    try {
      // Get or create session — wait for ready
      let session = this.sessions.get(chatId);
      if (!session || !session.isAlive() || !session.isIdle()) {
        console.log(`🔄 [BRIDGE] Need new/ready session for chat ${chatId}`);
        await this.baleBot.sendMessage(chatId, '🔄 در حال راه‌اندازی Freebuff...');

        session = await this.createSession(chatId);
        if (!session) {
          await this.baleBot.sendMessage(chatId, '❌ خطا در راه‌اندازی Freebuff.');
          return;
        }
      }

      // Session is ready — send input and wait for response
      console.log(`📤 [BRIDGE] Sending input to Freebuff`);

      // Note: sendInput internally waits for the response timer
      // It will emit 'response' or 'response_empty' when done
      const responsePromise = new Promise((resolve) => {
        const onResp = (text) => {
          session.removeListener('response_empty', onEmpty);
          resolve({ type: 'response', text });
        };
        const onEmpty = () => {
          session.removeListener('response', onResp);
          resolve({ type: 'empty' });
        };
        session.on('response', onResp);
        session.on('response_empty', onEmpty);
      });

      // Fire-and-forget the input send (it has its own timer)
      session.sendInput(text).catch(err => {
        console.error(`❌ [BRIDGE] sendInput error: ${err.message}`);
      });

      // Wait for response
      const response = await responsePromise;

      if (response.type === 'response' && response.text) {
        let output = response.text;
        if (output.length > config.maxOutputLength) {
          output = output.substring(0, config.maxOutputLength - 100) + '\n\n... (بریده شد)';
        }
        console.log(`📤 [BRIDGE] Sending response (${output.length} chars)`);
        await this.baleBot.sendMessage(chatId, output);
      } else {
        await this.baleBot.sendMessage(chatId, '📭 پاسخی دریافت نشد. دوباره تلاش کنید.');
      }

    } catch (err) {
      console.error(`❌ [BRIDGE] Error:`, err.message);
      await this.baleBot.sendMessage(chatId, `❌ خطا: ${err.message}`);
    } finally {
      this.processing.set(chatId, false);
    }
  }

  async createSession(chatId) {
    const existing = this.sessions.get(chatId);
    if (existing) existing.destroy();

    const session = new FreebuffSession({
      freebuffPath: config.freebuffPath,
      cwd: config.freebuffWorkingDir,
      sessionTimeoutMs: config.sessionTimeoutMs,
      responseWaitMs: config.responseWaitMs,
    });

    session.on('exit', () => {
      console.log(`🔴 [BRIDGE] Session for chat ${chatId} exited`);
      this.sessions.delete(chatId);
    });

    // Spawn and wait for ready
    session.spawn();

    const ready = await new Promise((resolve) => {
      const onReady = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        session.removeListener('ready', onReady);
        console.log(`⚠️  [BRIDGE] Startup timeout, proceeding anyway`);
        resolve(true); // Still resolve — session will eventually be ready
      }, session.startupTimeout + 5000); // Give bridge a bit more time than session

      session.once('ready', onReady);
    });

    if (ready) {
      this.sessions.set(chatId, session);
    }
    return session;
  }

  async stopSession(chatId) {
    const session = this.sessions.get(chatId);
    if (session) {
      session.destroy();
      this.sessions.delete(chatId);
    }
  }

  async stopAll() {
    for (const [, session] of this.sessions) {
      session.destroy();
    }
    this.sessions.clear();
  }
}
