// Bridge between Bale bot messages and Freebuff sessions
// Simplified: send input → wait → grab response → send back
// No stream monitoring, no thinking indicator updates

import { FreebuffSession } from './freebuff.js';
import config from './config.js';
import { UserStore } from './user-store.js';

export class Bridge {
  constructor(baleBot) {
    this.baleBot = baleBot;
    this.userStore = new UserStore(config.usersFile);
    this.sessions = new Map();
    this.processing = new Map();
  }

  isAuthenticated(userId) {
    return this.userStore.isAuthenticated(userId);
  }

  async handleMessage(message) {
    const chatId = message.chat?.id;
    const userId = message.from?.id;
    const text = message.text || '';

    console.log(`📩 [BRIDGE] Message from user=${userId} chat=${chatId}: "${text.substring(0, 100)}"`);

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, userId, text, message.from);
      return;
    }

    if (text.trim()) {
      if (!this.isAuthenticated(userId)) {
        await this.baleBot.sendMessage(chatId, '⛔ ابتدا احراز هویت کنید.\nاز /start <توکن شما> استفاده کنید.');
        return;
      }
      await this.sendToFreebuff(chatId, userId, text);
    }
  }

  async handleCommand(chatId, userId, text, from = {}) {
    const parts = text.trim().split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case '/start':
        await this.handleStart(chatId, userId, parts[1], from);
        break;

      case '/help':
        if (!this.isAuthenticated(userId)) return this.sendAuthReminder(chatId);
        await this.baleBot.sendMessage(chatId,
          '📖 راهنمای Freebuff Bot\n\n' +
          '💬 پیام متنی → اجرا در Freebuff\n' +
          '/new → session جدید\n' +
          '/stop → توقف session\n' +
          '/status → وضعیت فعلی'
        );
        break;

      case '/new':
        if (!this.isAuthenticated(userId)) return this.sendAuthReminder(chatId);
        await this.stopSession(userId);
        await this.baleBot.sendMessage(chatId, '🔄 Session جدید ایجاد شد.');
        break;

      case '/stop':
        if (!this.isAuthenticated(userId)) return this.sendAuthReminder(chatId);
        await this.stopSession(userId);
        await this.baleBot.sendMessage(chatId, '⏹️ Session متوقف شد.');
        break;

      case '/status': {
        if (!this.isAuthenticated(userId)) return this.sendAuthReminder(chatId);
        const session = this.sessions.get(String(userId));
        if (session && session.isAlive()) {
          const status = session.getStatus();
          const stateEmoji = status.state === 'idle' ? '🟢' : '🔄';
          const stateText = status.state === 'idle' ? 'آماده' : 'در حال پردازش';
          await this.baleBot.sendMessage(chatId,
            `${stateEmoji} Session ${stateText}\n` +
            `⏱️ ${status.uptime} دقیقه فعال\n` +
            `📂 ${status.cwd}\n` +
            `🔧 PID: ${status.pid}`
          );
        } else {
          await this.baleBot.sendMessage(chatId, '📊 Session فعالی نیست.\nبرای شروع /start <توکن> را بزنید.');
        }
        break;
      }

      default:
        if (!this.isAuthenticated(userId)) return this.sendAuthReminder(chatId);
        await this.baleBot.sendMessage(chatId, `❓ دستور ناشناخته: ${command}`);
    }
  }

  async handleStart(chatId, userId, token, from = {}) {
    const userToken = this.userStore.registerUser(userId, from.username, from.first_name);
    if (!token) {
      if (this.isAuthenticated(userId)) return this.sendMainMenu(chatId, '🤖 به Freebuff Bot خوش آمدید!');
      await this.baleBot.sendMessage(chatId, `🔑 توکن شما: ${userToken}\n\nبرای فعال‌سازی، /start ${userToken} را ارسال کنید.`);
      return;
    }

    const result = this.userStore.authenticateByToken(token, userId);
    if (!result.success) {
      const text = result.reason === 'belongs_to_another_user'
        ? '❌ این توکن متعلق به کاربر دیگری است.'
        : '❌ توکن معتبر نیست.';
      await this.baleBot.sendMessage(chatId, text);
      return;
    }

    // Start Freebuff session immediately after authentication
    await this.baleBot.sendMessage(chatId, '✅ احراز هویت با موفقیت انجام شد!\n\n🔄 در حال راه‌اندازی Freebuff...');
    this._startSessionInBackground(userId, chatId);
    await this.sendMainMenu(chatId, '🤖 به Freebuff Bot خوش آمدید!');
  }

  // Start session in background (fire-and-forget)
  async _startSessionInBackground(userId, chatId) {
    try {
      const session = await this.createSession(String(userId));
      if (session) {
        console.log(`✅ [BRIDGE] Session ready for user ${userId}`);
        // Notify user that session is ready
        await this.baleBot.sendMessage(chatId, '✅ Freebuff آماده است! می‌توانید پیام خود را ارسال کنید.');
      } else {
        console.error(`❌ [BRIDGE] Failed to create session for user ${userId}`);
        await this.baleBot.sendMessage(chatId, '❌ خطا در راه‌اندازی Freebuff. دوباره /new را بزنید.');
      }
    } catch (err) {
      console.error(`❌ [BRIDGE] Background session start error:`, err.message);
      await this.baleBot.sendMessage(chatId, '❌ خطا در راه‌اندازی Freebuff.');
    }
  }

  async sendMainMenu(chatId, text) {
    await this.baleBot.sendInlineKeyboard(chatId, text, [[
      { text: '📊 وضعیت Session', callback_data: 'status' },
      { text: '📖 راهنما', callback_data: 'help' },
    ]]);
  }

  async sendAuthReminder(chatId) {
    await this.baleBot.sendMessage(chatId, '⛔ ابتدا احراز هویت کنید.\nاز /start <توکن شما> استفاده کنید.');
  }

  async handleCallbackQuery(query) {
    const chatId = query.message?.chat?.id;
    const userId = query.from?.id;
    const data = query.data;
    await this.baleBot.call('answerCallbackQuery', { callback_query_id: query.id });
    if (!chatId || !userId) return;
    if (!this.isAuthenticated(userId)) return this.sendAuthReminder(chatId);
    if (data === 'help') {
      await this.baleBot.sendMessage(chatId, '📖 راهنمای Freebuff Bot\n\n💬 پیام متنی → اجرا در Freebuff\n/new → session جدید\n/stop → توقف session\n/status → وضعیت فعلی');
    } else if (data === 'status') {
      await this.handleCommand(chatId, userId, '/status');
    }
  }

  // ─── Core: Send to Freebuff ───────────────────────────────────

  async sendToFreebuff(chatId, userId, text) {
    const sessionKey = String(userId);
    console.log(`🚀 [BRIDGE] sendToFreebuff user=${sessionKey} chat=${chatId} text="${text.substring(0, 80)}"`);

    // Prevent concurrent sends
    if (this.processing.get(sessionKey)) {
      await this.baleBot.sendMessage(chatId, '⏳ لطفاً صبر کنید... پاسخ قبلی هنوز آماده نشده.');
      return;
    }

    this.processing.set(sessionKey, true);

    try {
      // Get or create session — wait for ready
      let session = this.sessions.get(sessionKey);
      if (!session || !session.isAlive() || !session.isIdle()) {
        console.log(`🔄 [BRIDGE] Need new/ready session for chat ${chatId}`);
        await this.baleBot.sendMessage(chatId, '🔄 در حال راه‌اندازی Freebuff...');

        session = await this.createSession(sessionKey);
        if (!session) {
          await this.baleBot.sendMessage(chatId, '❌ خطا در راه‌اندازی Freebuff.');
          return;
        }
      }

      // Session is ready — send input and wait for response
      console.log(`📤 [BRIDGE] Sending input to Freebuff`);

      // Progress tracking
      let lastProgressUpdate = 0;
      const progressInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - lastProgressUpdate) / 1000);
        if (elapsed > 10 && session.isAlive()) {
          // Show thinking indicator every 10s
          this.baleBot.sendChatAction(chatId, 'typing').catch(() => {});
        }
      }, 10000);

      // Note: sendInput internally waits for the response
      // It will emit 'response', 'response_empty', or 'progress' when done
      const responsePromise = new Promise((resolve) => {
        const onResp = (text) => {
          clearInterval(progressInterval);
          session.removeListener('response_empty', onEmpty);
          session.removeListener('progress', onProgress);
          resolve({ type: 'response', text });
        };
        const onEmpty = () => {
          clearInterval(progressInterval);
          session.removeListener('response', onResp);
          session.removeListener('progress', onProgress);
          resolve({ type: 'empty' });
        };
        const onProgress = (data) => {
          // Progress is handled by typing indicator above
          console.log(`📊 [BRIDGE] Progress: ${data.elapsed}s / ${data.maxWait}s`);
        };
        session.on('response', onResp);
        session.on('response_empty', onEmpty);
        session.on('progress', onProgress);
      });

      // Fire-and-forget the input send (it has its own timer)
      session.sendInput(text).catch(err => {
        clearInterval(progressInterval);
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
      this.processing.set(sessionKey, false);
    }
  }

  async createSession(userId) {
    const existing = this.sessions.get(userId);
    if (existing) existing.destroy();

    const session = new FreebuffSession({
      freebuffPath: config.freebuffPath,
      cwd: config.freebuffWorkingDir,
      sessionTimeoutMs: config.sessionTimeoutMs,
      responseWaitMs: config.responseWaitMs,
    });

    session.on('exit', () => {
      console.log(`🔴 [BRIDGE] Session for user ${userId} exited`);
      this.sessions.delete(userId);
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
      this.sessions.set(userId, session);
    }
    return session;
  }

  async stopSession(userId) {
    const session = this.sessions.get(String(userId));
    if (session) {
      session.destroy();
      this.sessions.delete(String(userId));
    }
  }

  async stopAll() {
    for (const [, session] of this.sessions) {
      session.destroy();
    }
    this.sessions.clear();
  }
}
