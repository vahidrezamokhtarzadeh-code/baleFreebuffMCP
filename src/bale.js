// Bale Bot API Client
// Uses long-polling (getUpdates) to receive messages
// Base API: https://tapi.bale.ai/bot<token>/

const BASE_URL = 'https://tapi.bale.ai';

export class BaleBot {
  constructor(token, { pollTimeout = 30 } = {}) {
    this.token = token;
    this.baseURL = `${BASE_URL}/bot${token}`;
    this.pollTimeout = pollTimeout;
    this.offset = 0;
    this.running = false;
  }

  // Generic API call
  async call(method, params = {}) {
    const url = `${this.baseURL}/${method}`;
    const body = JSON.stringify(params);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60_000),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Bale API error [${method}]: ${data.description || data.error_code}`);
    }
    return data.result;
  }

  // Send a text message
  async sendMessage(chatId, text, { replyToMessageId = null, parseMode = null, reply_markup = null } = {}) {
    console.log(`📤 [BALE] Sending to chat ${chatId}: "${text.substring(0, 80)}..."`);
    const params = {
      chat_id: String(chatId),
      text,
      ...(parseMode && { parse_mode: parseMode }),
      ...(replyToMessageId && { reply_to_message_id: replyToMessageId }),
      ...(reply_markup && { reply_markup }),
    };
    const result = await this.call('sendMessage', params);
    console.log(`✅ [BALE] Message sent (id=${result.message_id})`);
    return result;
  }

  async sendInlineKeyboard(chatId, text, keyboard, opts = {}) {
    return this.sendMessage(chatId, text, {
      ...opts,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // Send a chat action (typing indicator)
  async sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: String(chatId), action });
  }

  // Delete a message
  async deleteMessage(chatId, messageId) {
    console.log(`🗑️  [BALE] Deleting message ${messageId} in chat ${chatId}`);
    return this.call('deleteMessage', { chat_id: String(chatId), message_id: messageId });
  }

  // Long-poll for updates
  async getUpdates() {
    const params = {
      offset: this.offset,
      timeout: this.pollTimeout,
    };

    const result = await this.call('getUpdates', params);

    if (result.length > 0) {
      // Set offset to last update_id + 1
      this.offset = result[result.length - 1].update_id + 1;
    }

    return result;
  }

  // Start polling loop
  async start(onMessage, onCallbackQuery = null) {
    this.running = true;
    console.log('🤖 Bale bot is listening...');
    console.log(`🔗 [BALE] Base URL: ${this.baseURL.substring(0, 40)}...`);

    while (this.running) {
      try {
        const updates = await this.getUpdates();
        if (updates.length > 0) {
          console.log(`📥 [BALE] Received ${updates.length} update(s) (offset=${this.offset})`);
        }
        for (const update of updates) {
          if (update.message) {
            const msg = update.message;
            console.log(`📩 [BALE] Message: user=${msg.from?.id} chat=${msg.chat?.id} text="${(msg.text || '').substring(0, 50)}"`);
            await onMessage(msg);
          }
          if (update.callback_query && onCallbackQuery) {
            await onCallbackQuery(update.callback_query);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          // Poll timeout, continue
          continue;
        }
        console.error('⚠️  Error polling Bale API:', err.message);
        // Wait a bit before retrying on error
        await sleep(3000);
      }
    }
  }

  stop() {
    this.running = false;
  }

  // Get bot info
  async getMe() {
    return this.call('getMe');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
