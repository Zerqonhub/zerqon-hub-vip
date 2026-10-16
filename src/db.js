'use strict';

const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const Database = require('better-sqlite3');

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.getRow = db.prepare('SELECT sess, expire, discord_id FROM sessions WHERE sid = ?');
    this.upsertRow = db.prepare(`INSERT INTO sessions (sid, sess, expire, discord_id) VALUES (@sid, @sess, @expire, @discord_id)
      ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire, discord_id=excluded.discord_id`);
    this.deleteRow = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchRow = db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
    this.deleteByDiscord = db.prepare('DELETE FROM sessions WHERE discord_id = ?');
    this.pruneExpired = db.prepare('DELETE FROM sessions WHERE expire <= ?');
    this.countRows = db.prepare('SELECT COUNT(*) AS count FROM sessions');
    this.allRows = db.prepare('SELECT sid, sess FROM sessions');
  }

  get(sid, callback) {
    try {
      const row = this.getRow.get(sid);
      if (!row) return callback(null, null);
      if (row.expire <= Date.now()) {
        if (row.discord_id && typeof this.onExpired === 'function') {
          try { this.onExpired(row.discord_id, JSON.parse(row.sess)); } catch { /* The scheduled cleanup worker will retry. */ }
        }
        this.deleteRow.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) { return callback(error); }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const cookieExpiry = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      const discordId = sess.discordUserId || (sess.user && sess.user.id) || null;
      this.upsertRow.run({ sid, sess: JSON.stringify(sess), expire: cookieExpiry, discord_id: discordId });
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const cookieExpiry = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.touchRow.run(cookieExpiry, sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try { this.deleteRow.run(sid); callback(null); } catch (error) { callback(error); }
  }

  clear(callback = () => {}) {
    try { this.db.prepare('DELETE FROM sessions').run(); callback(null); } catch (error) { callback(error); }
  }

  length(callback) {
    try { callback(null, this.countRows.get().count); } catch (error) { callback(error); }
  }

  all(callback) {
    try { callback(null, this.allRows.all().map(row => ({ ...JSON.parse(row.sess), id: row.sid }))); } catch (error) { callback(error); }
  }

  revokeByDiscordId(discordId) {
    return this.deleteByDiscord.run(discordId).changes;
  }

  prune() { return this.pruneExpired.run(Date.now()).changes; }
}

function createDatabase(databasePath) {
  const absolutePath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const db = new Database(absolutePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire INTEGER NOT NULL,
      discord_id TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
    CREATE INDEX IF NOT EXISTS sessions_discord_idx ON sessions(discord_id);

    CREATE TABLE IF NOT EXISTS accounts (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      global_name TEXT,
      avatar TEXT,
      guild_id TEXT NOT NULL,
      vip_role_id TEXT NOT NULL,
      role_status TEXT NOT NULL DEFAULT 'unknown',
      role_assigned_at TEXT,
      last_verified_at TEXT,
      updated_at TEXT NOT NULL,
      last_error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS role_removal_jobs (
      discord_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error_code TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      discord_id TEXT,
      status TEXT NOT NULL,
      error_code TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const store = new SQLiteSessionStore(db);
  const statements = {
    upsertAccount: db.prepare(`INSERT INTO accounts
      (discord_id, username, global_name, avatar, guild_id, vip_role_id, role_status, role_assigned_at, last_verified_at, updated_at, last_error_code)
      VALUES (@discord_id, @username, @global_name, @avatar, @guild_id, @vip_role_id, @role_status, @role_assigned_at, @last_verified_at, @updated_at, @last_error_code)
      ON CONFLICT(discord_id) DO UPDATE SET username=excluded.username, global_name=excluded.global_name, avatar=excluded.avatar,
      guild_id=excluded.guild_id, vip_role_id=excluded.vip_role_id, role_status=excluded.role_status,
      role_assigned_at=COALESCE(excluded.role_assigned_at, accounts.role_assigned_at), last_verified_at=excluded.last_verified_at,
      updated_at=excluded.updated_at, last_error_code=excluded.last_error_code`),
    getAccount: db.prepare('SELECT * FROM accounts WHERE discord_id = ?'),
    updateRoleStatus: db.prepare('UPDATE accounts SET role_status=?, last_error_code=?, updated_at=? WHERE discord_id=?'),
    markLeftGuild: db.prepare("UPDATE accounts SET role_status='left_server', last_error_code=NULL, updated_at=? WHERE discord_id=? AND guild_id=?"),
    queueRemoval: db.prepare(`INSERT INTO role_removal_jobs (discord_id, guild_id, role_id, reason, attempts, next_attempt_at, last_error_code, updated_at)
      VALUES (@discord_id,@guild_id,@role_id,@reason,0,@next_attempt_at,@last_error_code,@updated_at)
      ON CONFLICT(discord_id) DO UPDATE SET reason=excluded.reason, next_attempt_at=excluded.next_attempt_at,
      last_error_code=excluded.last_error_code, updated_at=excluded.updated_at`),
    getPendingRemovals: db.prepare('SELECT * FROM role_removal_jobs WHERE next_attempt_at <= ? ORDER BY updated_at LIMIT ?'),
    markPendingFailure: db.prepare('UPDATE role_removal_jobs SET attempts=attempts+1, next_attempt_at=?, last_error_code=?, updated_at=? WHERE discord_id=?'),
    deletePending: db.prepare('DELETE FROM role_removal_jobs WHERE discord_id=?'),
    markLeftPending: db.prepare('DELETE FROM role_removal_jobs WHERE discord_id=?'),
    insertAudit: db.prepare('INSERT INTO audit_events (event_type, discord_id, status, error_code, created_at) VALUES (?, ?, ?, ?, ?)'),
    recentAudit: db.prepare('SELECT event_type, discord_id, status, error_code, created_at FROM audit_events ORDER BY id DESC LIMIT ?'),
    pendingCount: db.prepare('SELECT COUNT(*) AS count FROM role_removal_jobs'),
  };

  function queueExpiredRoleRemoval(discordId, sessionData, config) {
    if (!discordId || !config) return false;
    const now = Date.now();
    const account = statements.getAccount.get(discordId);
    const hasVerifiedEntitlement = Boolean((sessionData && sessionData.roleStatus === 'verified') || (account && account.role_status === 'verified'));
    if (!hasVerifiedEntitlement) return false;
    const active = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE discord_id = ? AND expire > ?').get(discordId, now).count;
    if (active > 0) return false;
    statements.queueRemoval.run({
      discord_id: discordId,
      guild_id: config.guildId || (account && account.guild_id) || '',
      role_id: config.vipRoleId || (account && account.vip_role_id) || '',
      reason: 'Sesión de Zerqon Hub expirada',
      next_attempt_at: now,
      last_error_code: 'SESSION_EXPIRED_CLEANUP',
      updated_at: new Date().toISOString(),
    });
    statements.updateRoleStatus.run('removal_pending', 'SESSION_EXPIRED_CLEANUP', new Date().toISOString(), discordId);
    return true;
  }

  return {
    db,
    store,
    queueExpiredRoleRemoval(discordId, sessionData, config) { return queueExpiredRoleRemoval(discordId, sessionData, config); },
    close: () => db.close(),
    upsertAccount(data) { statements.upsertAccount.run(data); },
    getAccount(id) { return statements.getAccount.get(id) || null; },
    updateRoleStatus(id, status, errorCode = null) { statements.updateRoleStatus.run(status, errorCode, new Date().toISOString(), id); },
    markLeftGuild(id, guildId) {
      statements.markLeftGuild.run(new Date().toISOString(), id, guildId);
      statements.markLeftPending.run(id);
    },
    queueRemoval(id, guildId, roleId, reason, errorCode) {
      statements.queueRemoval.run({ discord_id: id, guild_id: guildId, role_id: roleId, reason, next_attempt_at: Date.now() + 30000, last_error_code: errorCode || null, updated_at: new Date().toISOString() });
    },
    getPendingRemovals(limit = 25) { return statements.getPendingRemovals.all(Date.now(), limit); },
    failPending(id, attempts, errorCode) {
      const delay = Math.min(60 * 60 * 1000, Math.max(30000, 30000 * (2 ** Math.min(attempts, 6))));
      statements.markPendingFailure.run(Date.now() + delay, errorCode, new Date().toISOString(), id);
    },
    deletePending(id) { statements.deletePending.run(id); },
    addAudit(type, discordId, status, errorCode = null) {
      statements.insertAudit.run(type, discordId || null, status, errorCode || null, new Date().toISOString());
    },
    getRecentAudit(limit = 20) { return statements.recentAudit.all(Math.min(Math.max(limit, 1), 100)); },
    expireSessions(config) {
      const now = Date.now();
      const expired = db.prepare('SELECT sid, discord_id, sess FROM sessions WHERE expire <= ? AND discord_id IS NOT NULL').all(now);
      let removalsQueued = 0;
      for (const row of expired) {
        let sess;
        try { sess = JSON.parse(row.sess); } catch { sess = {}; }
        if (queueExpiredRoleRemoval(row.discord_id, sess, config)) removalsQueued += 1;
      }
      const sessionsRemoved = store.prune();
      return { sessionsRemoved, removalsQueued };
    },
    pendingCount() { return statements.pendingCount.get().count; },
  };
}

module.exports = { createDatabase, SQLiteSessionStore };
