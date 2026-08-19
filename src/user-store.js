import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export class UserStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.users = this._load();
  }

  _load() {
    if (!existsSync(this.filePath)) return {};

    try {
      const users = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return users && typeof users === 'object' && !Array.isArray(users) ? users : {};
    } catch (err) {
      console.error(`⚠️  Failed to load users from ${this.filePath}: ${err.message}`);
      return {};
    }
  }

  registerUser(userId, username = null, firstName = null) {
    const key = String(userId);
    const existing = this.users[key];
    if (existing) {
      existing.username = username ?? existing.username;
      existing.firstName = firstName ?? existing.firstName;
      this._save();
      return existing.token;
    }

    let token;
    do {
      token = UserStore._generateToken();
    } while (Object.values(this.users).some(user => user.token === token));

    this.users[key] = {
      token,
      username,
      firstName,
      authenticated: false,
      createdAt: new Date().toISOString(),
    };
    this._save();
    return token;
  }

  authenticateByToken(token, userId = null) {
    const normalizedToken = String(token || '').trim().toLowerCase();
    const ownerEntry = Object.entries(this.users).find(([, user]) => user.token === normalizedToken);

    if (!ownerEntry) return { success: false, reason: 'invalid' };
    if (userId !== null && ownerEntry[0] !== String(userId)) {
      return { success: false, reason: 'belongs_to_another_user' };
    }

    this.users[ownerEntry[0]].authenticated = true;
    this._save();
    return { userId: ownerEntry[0], success: true };
  }

  isAuthenticated(userId) {
    return this.users[String(userId)]?.authenticated === true;
  }

  getToken(userId) {
    return this.users[String(userId)]?.token || null;
  }

  getUser(userId) {
    return this.users[String(userId)] || null;
  }

  _save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.users, null, 2)}\n`, 'utf8');
  }

  static _generateToken() {
    const bytes = randomBytes(8);
    return [...bytes].map(byte => TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length]).join('');
  }
}
