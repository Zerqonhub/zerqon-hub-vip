'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { secureEqual, makeUserPayload } = require('./security');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { friendlyDiscordError } = require('./discord');

function publicErrorCode(error) {
  const allowed = new Set([
    'NOT_IN_GUILD', 'DISCORD_SETUP_NOT_READY', 'ROLE_ASSIGNMENT_NOT_CONFIRMED',
    'ROLE_CONFIGURATION_MISMATCH', 'ROLE_HIERARCHY', 'MANAGE_ROLES_REQUIRED',
    'BOT_NOT_IN_GUILD', 'BOT_CONFIG_MISSING', 'GUILD_CONFIG_MISSING', 'ROLE_CONFIG_MISSING',
    'DISCORD_HTTP_401', 'DISCORD_HTTP_403', 'DISCORD_HTTP_404', 'DISCORD_HTTP_429',
    'ROLE_REMOVAL_NOT_CONFIRMED', 'OAUTH_TOKEN_EXCHANGE_FAILED', 'OAUTH_USER_LOOKUP_FAILED'
  ]);
  return error && allowed.has(error.code) ? error.code : 'VERIFICATION_FAILED';
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createApp({ config, database, discord, sessionStore, logger = console }) {
  const app = express();
  const production = config.isProduction;
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://discord.com'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: production ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(session({
    name: 'zerqon.sid',
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: production,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    },
  }));

  const authLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'RATE_LIMITED', message: 'Demasiados intentos. Esperá un minuto e intentá nuevamente.' } });
  const verifyLimiter = rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'RATE_LIMITED', message: 'Demasiados intentos de verificación. Esperá un momento.' } });
  const logoutLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'RATE_LIMITED', message: 'Demasiados intentos de cierre de sesión.' } });

  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'Zerqon Hub VIP', timestamp: new Date().toISOString(), environment: config.nodeEnv }));

  app.get('/api/status', asyncRoute(async (req, res) => {
    const setup = await discord.validateSetup();
    const missing = [];
    if (!config.appOrigin) missing.push('PUBLIC_APP_URL');
    if (!config.redirectMatches) missing.push('DISCORD_REDIRECT_URI');
    if (!config.clientId) missing.push('DISCORD_CLIENT_ID');
    if (!config.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
    if (!config.botToken) missing.push('DISCORD_BOT_TOKEN');
    if (!config.guildId) missing.push('DISCORD_GUILD_ID');
    if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push('SESSION_SECRET');
    const roleOperational = Boolean(setup.ready);
    res.json({
      app: 'Zerqon Hub VIP',
      checkedAt: new Date().toISOString(),
      publicAppUrl: config.appOrigin,
      discordInviteUrl: config.inviteUrl,
      supportUrl: config.supportUrl,
      callbackPath: config.callbackPath,
      expectedRedirectUri: config.expectedRedirectUri,
      redirectConfiguredCorrectly: config.redirectMatches,
      oauthConfigured: Boolean(config.oauthReady),
      oauthReady: Boolean(config.oauthReady),
      gatewayEnabled: Boolean(config.gatewayEnabled && config.botToken),
      gatewayReady: Boolean(req.app.locals.gatewayReady),
      roleCheck: {
        configured: Boolean(config.roleFlowConfigured),
        ready: roleOperational,
        roleExists: Boolean(setup.roleExists),
        roleNameMatches: Boolean(setup.roleNameMatches),
        actualRoleName: setup.roleName || null,
        manageRoles: Boolean(setup.hasManageRoles),
        hierarchyOk: Boolean(setup.hierarchyOk),
        issue: setup.issue || null,
      },
      removalQueue: database.pendingCount(),
      missingVariables: missing,
      productionReady: Boolean(config.oauthReady && roleOperational),
    });
  }));

  app.get('/api/source-status', asyncRoute(async (req, res) => {
    res.json(await discord.checkScriptSource());
  }));

  app.get('/api/session', (req, res) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    const user = req.session.user || null;
    const account = user ? database.getAccount(user.id) : null;
    res.set('Cache-Control', 'no-store');
    res.json({
      authenticated: Boolean(user),
      user,
      csrfToken: req.session.csrfToken,
      vip: user ? {
        status: req.session.roleStatus || (account && account.role_status) || 'unknown',
        roleId: config.vipRoleId,
        roleName: config.vipRoleName,
        assignedAt: account && account.role_assigned_at ? account.role_assigned_at : null,
        lastVerifiedAt: account && account.last_verified_at ? account.last_verified_at : null,
      } : null,
    });
  });

  app.get('/api/auth/discord', authLimiter, (req, res) => {
    if (!config.oauthReady || !config.redirectUri) {
      return res.status(503).redirect('/?authError=oauth_not_configured#vip');
    }
    const state = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = state;
    req.session.oauthStateCreatedAt = Date.now();
    req.session.save(error => {
      if (error) {
        logger.error('[auth] Could not persist OAuth state.');
        return res.status(500).redirect('/?authError=session_error#vip');
      }
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: 'identify',
        state,
        prompt: 'consent',
      });
      return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    });
  });

  app.get('/api/auth/discord/callback', authLimiter, asyncRoute(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const returnedState = typeof req.query.state === 'string' ? req.query.state : null;
    const expectedState = req.session.oauthState;
    const stateAge = Date.now() - Number(req.session.oauthStateCreatedAt || 0);
    delete req.session.oauthState;
    delete req.session.oauthStateCreatedAt;
    await new Promise(resolve => req.session.save(() => resolve()));

    if (req.query.error) return res.redirect('/?authError=discord_denied#vip');
    if (!code || !expectedState || !returnedState || !secureEqual(expectedState, returnedState) || stateAge > 10 * 60 * 1000) {
      database.addAudit('oauth_callback', null, 'failed', 'OAUTH_STATE_INVALID');
      return res.redirect('/?authError=oauth_state_invalid#vip');
    }
    if (!config.oauthReady || !config.redirectUri) return res.redirect('/?authError=oauth_not_configured#vip');

    let oauthUser;
    try {
      const tokenData = await discord.exchangeCode(code);
      oauthUser = await discord.getOAuthUser(tokenData.access_token);
    } catch (error) {
      database.addAudit('oauth_callback', null, 'failed', error.code || 'OAUTH_FAILED');
      return res.redirect('/?authError=oauth_exchange_failed#vip');
    }

    const user = makeUserPayload(oauthUser);
    let roleStatus = 'not_checked';
    let roleAssignedAt = null;
    let roleErrorCode = null;
    try {
      const roleResult = await discord.assignVipRole(user.id);
      roleStatus = 'verified';
      roleAssignedAt = roleResult.assigned ? new Date().toISOString() : null;
      database.addAudit(roleResult.assigned ? 'vip_role_assigned' : 'vip_role_already_present', user.id, 'success', null);
    } catch (error) {
      roleErrorCode = publicErrorCode(error);
      if (error.code === 'NOT_IN_GUILD') roleStatus = 'not_member';
      else if (error.code === 'DISCORD_SETUP_NOT_READY' || error.code === 'BOT_CONFIG_MISSING') roleStatus = 'configuration_error';
      else roleStatus = 'error';
      database.addAudit('vip_role_assignment', user.id, 'failed', roleErrorCode);
      logger.warn(`[verification] Role assignment failed for discordUserId=${user.id}; diagnostic=${roleErrorCode}`);
    }

    database.upsertAccount({
      discord_id: user.id,
      username: user.username,
      global_name: user.globalName,
      avatar: oauthUser.avatar || null,
      guild_id: config.guildId || '',
      vip_role_id: config.vipRoleId,
      role_status: roleStatus,
      role_assigned_at: roleAssignedAt,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error_code: roleErrorCode,
    });

    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = user;
    req.session.discordUserId = user.id;
    req.session.roleStatus = roleStatus;
    req.session.roleErrorCode = roleErrorCode;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    return res.redirect('/?auth=complete#vip');
  }));

  function requireAuth(req, res, next) {
    if (!req.session || !req.session.user || !req.session.discordUserId) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Conectá tu cuenta de Discord primero.' });
    next();
  }

  function requireCsrf(req, res, next) {
    const headerToken = req.get('x-csrf-token');
    const bodyToken = req.body && req.body.csrfToken;
    if (!req.session || !req.session.csrfToken || !secureEqual(req.session.csrfToken, headerToken || bodyToken)) {
      return res.status(403).json({ error: 'CSRF_INVALID', message: 'La sesión de seguridad venció. Actualizá la página e intentá de nuevo.' });
    }
    next();
  }

  app.post('/api/verification/retry', verifyLimiter, requireAuth, requireCsrf, asyncRoute(async (req, res) => {
    const user = req.session.user;
    try {
      const result = await discord.assignVipRole(user.id);
      req.session.roleStatus = 'verified';
      req.session.roleErrorCode = null;
      database.upsertAccount({
        discord_id: user.id, username: user.username, global_name: user.globalName,
        avatar: user.avatar || null, guild_id: config.guildId, vip_role_id: config.vipRoleId,
        role_status: 'verified', role_assigned_at: result.assigned ? new Date().toISOString() : null,
        last_verified_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error_code: null,
      });
      database.addAudit(result.assigned ? 'vip_role_assigned' : 'vip_role_already_present', user.id, 'success', null);
      await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
      return res.json({ ok: true, status: 'verified', assigned: result.assigned, alreadyHadRole: result.alreadyHadRole, message: result.assigned ? 'Rol VIP asignado y confirmado por Discord.' : 'Tu rol VIP ya estaba asignado y fue confirmado.' });
    } catch (error) {
      const code = publicErrorCode(error);
      const status = error.code === 'NOT_IN_GUILD' ? 'not_member' : error.code === 'DISCORD_SETUP_NOT_READY' ? 'configuration_error' : 'error';
      req.session.roleStatus = status;
      req.session.roleErrorCode = code;
      database.updateRoleStatus(user.id, status, code);
      database.addAudit('vip_role_retry', user.id, 'failed', code);
      await new Promise(resolve => req.session.save(() => resolve()));
      const httpStatus = error.code === 'NOT_IN_GUILD' ? 409 : error.code === 'DISCORD_SETUP_NOT_READY' ? 503 : 502;
      return res.status(httpStatus).json({ ok: false, status, error: code, message: (error.setup && error.setup.issue) || friendlyDiscordError(error), setup: error.setup ? {
        ready: error.setup.ready, issue: error.setup.issue,
        manageRoles: error.setup.hasManageRoles, hierarchyOk: error.setup.hierarchyOk,
        roleNameMatches: error.setup.roleNameMatches,
      } : undefined });
    }
  }));

  app.post('/api/logout', logoutLimiter, requireAuth, requireCsrf, asyncRoute(async (req, res) => {
    const user = req.session.user;
    let roleRemoval = { confirmed: false, removed: false, errorCode: null };
    try {
      const result = await discord.removeVipRole(user.id);
      roleRemoval = { ...result, errorCode: null };
      database.deletePending(user.id);
      database.updateRoleStatus(user.id, result.memberLeft ? 'left_server' : 'removed', null);
      database.addAudit('logout_role_removal', user.id, 'success', null);
    } catch (error) {
      const code = publicErrorCode(error);
      roleRemoval = { confirmed: false, removed: false, errorCode: code };
      database.queueRemoval(user.id, config.guildId || '', config.vipRoleId, 'Cierre de sesión de Zerqon Hub', code);
      database.updateRoleStatus(user.id, 'removal_pending', code);
      database.addAudit('logout_role_removal', user.id, 'failed', code);
      logger.warn(`[logout] Role removal failed for discordUserId=${user.id}; diagnostic=${code}; queued=true`);
    }

    await new Promise(resolve => req.session.destroy(() => resolve()));
    res.clearCookie('zerqon.sid', { httpOnly: true, secure: production, sameSite: 'lax', path: '/' });
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      loggedOut: true,
      roleRemovalConfirmed: Boolean(roleRemoval.confirmed),
      roleRemoved: Boolean(roleRemoval.removed),
      roleAlreadyAbsent: Boolean(roleRemoval.alreadyAbsent),
      warning: roleRemoval.confirmed ? null : 'La sesión se cerró de forma segura, pero Discord no confirmó la eliminación del rol. El backend dejó un reintento pendiente.',
      diagnostic: roleRemoval.errorCode,
    });
  }));

  app.get('/api/account/audit', requireAuth, (req, res) => {
    const account = database.getAccount(req.session.user.id);
    res.json({ account: account ? {
      discordId: account.discord_id,
      username: account.username,
      roleStatus: account.role_status,
      lastVerifiedAt: account.last_verified_at,
      roleAssignedAt: account.role_assigned_at,
      lastErrorCode: account.last_error_code,
    } : null });
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: production ? '1h' : 0, etag: true }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'No se encontró esta ruta.' }));
  app.use((error, req, res, next) => {
    logger.error(`[http] Unexpected error at ${req.method} ${req.path}: ${error && error.name ? error.name : 'Error'}`);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado. Intentá nuevamente.' });
  });

  app.locals.database = database;
  app.locals.discord = discord;
  app.locals.config = config;
  return app;
}

module.exports = { createApp, publicErrorCode };
