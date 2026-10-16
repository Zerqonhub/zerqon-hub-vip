'use strict';

require('dotenv').config();
const path = require('node:path');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { buildConfig } = require('./config');
const { createDatabase } = require('./db');
const { DiscordService } = require('./discord');
const { createApp } = require('./app');

const config = buildConfig(process.env);
if (config.isProduction && (!config.sessionSecret || config.sessionSecret.length < 32)) {
  console.error('[startup] Production blocked: configure SESSION_SECRET with at least 32 random characters.');
  process.exit(1);
}

const database = createDatabase(path.resolve(process.cwd(), config.databasePath));
database.store.onExpired = (discordId, sessionData) => database.queueExpiredRoleRemoval(discordId, sessionData, config);
const discord = new DiscordService(config, database);
const app = createApp({ config, database, discord, sessionStore: database.store });
let gatewayClient = null;

function logConfigSummary() {
  console.log(`[startup] Zerqon Hub VIP (${config.nodeEnv})`);
  console.log(`[startup] Public origin: ${config.appOrigin || 'NOT CONFIGURED'}`);
  console.log(`[startup] Expected Discord callback: ${config.expectedRedirectUri || 'NOT CALCULABLE'}`);
  console.log(`[startup] Redirect URI consistent: ${config.redirectMatches ? 'yes' : 'no'}`);
  console.log(`[startup] OAuth client ID configured: ${Boolean(config.clientId)}`);
  console.log(`[startup] OAuth client secret configured: ${Boolean(config.clientSecret)}`);
  console.log(`[startup] Bot token configured: ${Boolean(config.botToken)}`);
  console.log(`[startup] Guild ID configured: ${Boolean(config.guildId)}`);
  console.log(`[startup] VIP role ID configured: ${Boolean(config.vipRoleId)}`);
  if (config.problems.length) config.problems.forEach(problem => console.warn(`[startup] Setup required: ${problem}`));
}

async function startGateway() {
  if (!config.gatewayEnabled || !config.botToken) {
    app.locals.gatewayReady = false;
    console.warn('[gateway] Disabled or no bot token configured; member-leave events are unavailable.');
    return;
  }
  gatewayClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  gatewayClient.once(Events.ClientReady, client => {
    app.locals.gatewayReady = true;
    console.log(`[gateway] Connected as ${client.user.username}; member-leave listener ready.`);
  });
  gatewayClient.on(Events.GuildMemberRemove, member => {
    if (member.guild.id !== config.guildId) return;
    const userId = member.user.id;
    try {
      database.markLeftGuild(userId, config.guildId);
      database.store.revokeByDiscordId(userId);
      database.addAudit('discord_member_left', userId, 'authorization_revoked', null);
      console.log(`[gateway] Discord member left; application sessions revoked for discordUserId=${userId}`);
    } catch (error) {
      console.error(`[gateway] Failed to process member departure; diagnostic=${error.code || error.name || 'UNKNOWN'}`);
    }
  });
  gatewayClient.on(Events.Error, error => {
    app.locals.gatewayReady = false;
    console.error(`[gateway] Discord client error; diagnostic=${error.code || error.name || 'UNKNOWN'}`);
  });
  try {
    await gatewayClient.login(config.botToken);
  } catch (error) {
    app.locals.gatewayReady = false;
    console.error(`[gateway] Login failed; diagnostic=${error.code || error.name || 'GATEWAY_LOGIN_FAILED'}`);
  }
}

async function main() {
  logConfigSummary();
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[startup] Listening on 0.0.0.0:${config.port}`);
  });
  startGateway().catch(error => console.error(`[gateway] Startup error: ${error.code || error.name || 'UNKNOWN'}`));

  const setupTimer = setInterval(() => {
    const cleanup = database.expireSessions(config);
    if (cleanup.removalsQueued > 0) console.log(`[sessions] Expired sessions queued ${cleanup.removalsQueued} VIP role removal(s).`);
    discord.retryPendingRoleRemovals().catch(error => console.warn(`[retry] Pending-removal worker failed: ${error.code || error.name || 'UNKNOWN'}`));
  }, 30000);
  setupTimer.unref();

  const shutdown = async signal => {
    console.log(`[shutdown] ${signal}`);
    clearInterval(setupTimer);
    server.close();
    if (gatewayClient) await gatewayClient.destroy().catch(() => {});
    database.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(`[startup] Fatal error: ${error.code || error.name || 'UNKNOWN'}`);
  process.exit(1);
});
