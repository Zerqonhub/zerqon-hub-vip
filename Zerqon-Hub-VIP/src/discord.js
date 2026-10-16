'use strict';

const API_BASE = 'https://discord.com/api/v10';

class DiscordApiError extends Error {
  constructor(message, status, code, retryAfter = null) {
    super(message);
    this.name = 'DiscordApiError';
    this.status = status;
    this.code = code || `DISCORD_HTTP_${status}`;
    this.retryAfter = retryAfter;
  }
}

function friendlyDiscordError(error) {
  if (error && error.code === 'ROLE_CONFIGURATION_MISMATCH') return 'El ID del rol no coincide con el rol zerqonviphub configurado.';
  if (error && error.code === 'ROLE_HIERARCHY') return 'El rol más alto del bot debe estar por encima de zerqonviphub.';
  if (error && error.code === 'MANAGE_ROLES_REQUIRED') return 'Al bot le falta el permiso Manage Roles.';
  if (error && error.code === 'NOT_IN_GUILD') return 'Primero uníte al servidor de Discord y volvé a verificar.';
  if (error && error.code === 'BOT_NOT_IN_GUILD') return 'El bot no está en el servidor configurado.';
  if (error && error.code === 'ROLE_ASSIGNMENT_NOT_CONFIRMED') return 'Discord respondió a la asignación, pero no se pudo confirmar el rol. Reintentá la verificación.';
  if (error instanceof DiscordApiError) {
    if (error.status === 401) return 'El token del bot no es válido. Regeneralo y actualizá el secreto del backend.';
    if (error.status === 403) return 'Discord denegó la acción. Revisá Manage Roles y la jerarquía de roles del bot.';
    if (error.status === 404) return 'No se encontró el servidor, el miembro o el rol configurado. Revisá sus IDs.';
    if (error.status === 429) return 'Discord está limitando temporalmente las solicitudes. Esperá un momento y reintentá.';
  }
  if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'Discord tardó demasiado en responder. Reintentá en unos segundos.';
  return 'No se pudo completar la operación con Discord. Revisá el estado del servicio e intentá nuevamente.';
}

class DiscordService {
  constructor(config, database, logger = console) {
    this.config = config;
    this.database = database;
    this.logger = logger;
    this.lastSetupCheck = null;
    this.lastSetupCheckAt = 0;
    this.sourceCheck = { checkedAt: null, ok: null, status: 'unknown', detail: 'Aún no comprobada' };
    this.sourceCheckAt = 0;
  }

  assertBotConfig() {
    if (!this.config.botToken) throw Object.assign(new Error('Bot token missing'), { code: 'BOT_CONFIG_MISSING' });
    if (!this.config.guildId) throw Object.assign(new Error('Guild ID missing'), { code: 'GUILD_CONFIG_MISSING' });
    if (!this.config.vipRoleId) throw Object.assign(new Error('VIP role ID missing'), { code: 'ROLE_CONFIG_MISSING' });
  }

  async request(method, route, { body, reason, tokenType = 'Bot' } = {}) {
    this.assertBotConfig();
    const headers = { Authorization: `${tokenType} ${tokenType === 'Bot' ? this.config.botToken : ''}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason.slice(0, 450));
    const response = await fetch(`${API_BASE}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    let payload = null;
    if (response.status !== 204) {
      const raw = await response.text();
      if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = null; }
      }
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after') || (payload && payload.retry_after) || 0) || null;
      const detail = payload && payload.message ? String(payload.message) : `Discord API returned ${response.status}`;
      throw new DiscordApiError(detail, response.status, `DISCORD_HTTP_${response.status}`, retryAfter);
    }
    return payload;
  }

  async exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
    });
    const response = await fetch(`${API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw Object.assign(new Error('Discord OAuth token exchange failed'), { code: 'OAUTH_TOKEN_EXCHANGE_FAILED', status: response.status });
    }
    return data;
  }

  async getOAuthUser(accessToken) {
    const response = await fetch(`${API_BASE}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id) throw Object.assign(new Error('Discord user lookup failed'), { code: 'OAUTH_USER_LOOKUP_FAILED', status: response.status });
    return data;
  }

  async getMember(userId) {
    try {
      return await this.request('GET', `/guilds/${this.config.guildId}/members/${userId}`);
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getRoles() {
    return this.request('GET', `/guilds/${this.config.guildId}/roles`);
  }

  async validateSetup({ force = false } = {}) {
    if (!force && this.lastSetupCheck && Date.now() - this.lastSetupCheckAt < 60000) return this.lastSetupCheck;
    const result = {
      checkedAt: new Date().toISOString(),
      botTokenConfigured: Boolean(this.config.botToken),
      guildConfigured: Boolean(this.config.guildId),
      roleConfigured: Boolean(this.config.vipRoleId),
      botInGuild: false,
      roleExists: false,
      roleNameMatches: false,
      hasManageRoles: false,
      hierarchyOk: false,
      ready: false,
      issue: null,
    };
    if (!this.config.botToken || !this.config.guildId || !this.config.vipRoleId) {
      result.issue = 'Faltan variables privadas de Discord en el backend.';
      this.lastSetupCheck = result; this.lastSetupCheckAt = Date.now(); return result;
    }
    try {
      const [bot, roles] = await Promise.all([
        this.request('GET', '/users/@me'),
        this.getRoles(),
      ]);
      const target = roles.find(role => role.id === this.config.vipRoleId);
      result.botInGuild = true; // The successful guild role request confirms the bot can access this guild.
      result.roleExists = Boolean(target);
      result.roleName = target ? target.name : null;
      result.roleNameMatches = Boolean(target && target.name.trim().toLowerCase() === this.config.vipRoleName.toLowerCase());
      result.rolePosition = target ? target.position : null;
      if (!target) {
        result.issue = 'El ID configurado no existe como rol en el servidor seleccionado.';
      } else if (!result.roleNameMatches) {
        result.issue = `El ID configurado pertenece a "${target.name}", no a "${this.config.vipRoleName}".`;
      }
      try {
        const botMember = await this.request('GET', `/guilds/${this.config.guildId}/members/${bot.id}`);
        const botRoleIds = new Set(botMember.roles || []);
        const botRoles = roles.filter(role => botRoleIds.has(role.id));
        const permissions = roles.filter(role => role.id === this.config.guildId || botRoleIds.has(role.id))
          .reduce((bits, role) => bits | BigInt(role.permissions || '0'), 0n);
        const ADMINISTRATOR = 1n << 3n;
        const MANAGE_ROLES = 1n << 28n;
        result.hasManageRoles = (permissions & ADMINISTRATOR) !== 0n || (permissions & MANAGE_ROLES) !== 0n;
        const highestBotPosition = botRoles.reduce((highest, role) => Math.max(highest, role.position || 0), 0);
        result.botHighestRolePosition = highestBotPosition;
        result.hierarchyOk = Boolean(target && highestBotPosition > target.position);
        if (!result.hasManageRoles) result.issue = 'El bot no tiene Manage Roles.';
        else if (!result.hierarchyOk) result.issue = 'El rol más alto del bot debe estar por encima del rol VIP.';
      } catch (error) {
        if (!result.issue) result.issue = error.status === 404 ? 'El bot no figura como miembro de este servidor.' : 'No se pudo comprobar los permisos del bot.';
      }
      result.ready = result.botInGuild && result.roleExists && result.roleNameMatches && result.hasManageRoles && result.hierarchyOk;
      if (result.ready) result.issue = null;
    } catch (error) {
      result.issue = error instanceof DiscordApiError && error.status === 401
        ? 'El token del bot fue rechazado por Discord.'
        : error instanceof DiscordApiError && error.status === 404
          ? 'No se encontró el servidor configurado o el bot no tiene acceso.'
          : 'No fue posible validar el bot y el servidor con Discord.';
      result.errorCode = error.code || 'DISCORD_SETUP_CHECK_FAILED';
    }
    this.lastSetupCheck = result;
    this.lastSetupCheckAt = Date.now();
    return result;
  }

  async assignVipRole(userId) {
    const setup = await this.validateSetup({ force: true });
    if (!setup.ready) {
      throw Object.assign(new Error(setup.issue || 'Discord bot is not ready'), { code: 'DISCORD_SETUP_NOT_READY', setup });
    }
    let member = await this.getMember(userId);
    if (!member) throw Object.assign(new Error('User is not a member of the configured server'), { code: 'NOT_IN_GUILD' });
    if ((member.roles || []).includes(this.config.vipRoleId)) {
      return { assigned: false, alreadyHadRole: true, confirmed: true, member };
    }
    await this.request('PUT', `/guilds/${this.config.guildId}/members/${userId}/roles/${this.config.vipRoleId}`, {
      reason: 'Zerqon Hub VIP: asignación tras verificación OAuth2',
    });
    member = await this.getMember(userId);
    if (!member || !(member.roles || []).includes(this.config.vipRoleId)) {
      throw Object.assign(new Error('Role assignment not confirmed after rechecking member'), { code: 'ROLE_ASSIGNMENT_NOT_CONFIRMED' });
    }
    return { assigned: true, alreadyHadRole: false, confirmed: true, member };
  }

  async removeVipRole(userId, reason = 'Zerqon Hub VIP: cierre de sesión del sitio') {
    const member = await this.getMember(userId);
    if (!member) return { removed: false, alreadyAbsent: true, memberLeft: true, confirmed: true };
    if (!(member.roles || []).includes(this.config.vipRoleId)) {
      return { removed: false, alreadyAbsent: true, memberLeft: false, confirmed: true };
    }
    const setup = await this.validateSetup({ force: true });
    if (!setup.ready) throw Object.assign(new Error(setup.issue || 'Discord role configuration is not ready'), { code: 'DISCORD_SETUP_NOT_READY', setup });
    await this.request('DELETE', `/guilds/${this.config.guildId}/members/${userId}/roles/${this.config.vipRoleId}`, { reason });
    const fresh = await this.getMember(userId);
    if (!fresh) return { removed: true, alreadyAbsent: false, memberLeft: true, confirmed: true };
    if ((fresh.roles || []).includes(this.config.vipRoleId)) {
      throw Object.assign(new Error('Role still present after removal'), { code: 'ROLE_REMOVAL_NOT_CONFIRMED' });
    }
    return { removed: true, alreadyAbsent: false, memberLeft: false, confirmed: true };
  }

  async checkScriptSource() {
    if (this.sourceCheckAt && Date.now() - this.sourceCheckAt < 60000) return this.sourceCheck;
    const url = 'https://raw.githubusercontent.com/Elproxd1234/zerqonhubSAD/main/zerqonhub.lua';
    try {
      let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
      if (response.status === 405 || response.status === 403) {
        response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(5000) });
      }
      this.sourceCheck = {
        checkedAt: new Date().toISOString(),
        ok: response.ok,
        status: response.ok ? 'available' : 'unavailable',
        httpStatus: response.status,
        detail: response.ok ? 'GitHub respondió correctamente.' : `GitHub respondió HTTP ${response.status}.`,
      };
    } catch {
      this.sourceCheck = { checkedAt: new Date().toISOString(), ok: null, status: 'unknown', detail: 'No se pudo comprobar la fuente desde el servidor.' };
    }
    this.sourceCheckAt = Date.now();
    return this.sourceCheck;
  }

  async retryPendingRoleRemovals() {
    const jobs = this.database.getPendingRemovals(10);
    for (const job of jobs) {
      try {
        const result = await this.removeVipRole(job.discord_id, `Zerqon Hub: reintento pendiente (${job.reason})`);
        if (result.confirmed) {
          this.database.deletePending(job.discord_id);
          this.database.updateRoleStatus(job.discord_id, result.memberLeft ? 'left_server' : 'removed', null);
          this.database.addAudit('vip_role_remove_retry', job.discord_id, 'success', null);
        }
      } catch (error) {
        this.database.failPending(job.discord_id, job.attempts, error.code || 'ROLE_REMOVE_RETRY_FAILED');
        this.database.addAudit('vip_role_remove_retry', job.discord_id, 'failed', error.code || 'ROLE_REMOVE_RETRY_FAILED');
        this.logger.warn(`[discord] Pending role removal failed; diagnostic=${error.code || 'ROLE_REMOVE_RETRY_FAILED'}`);
      }
    }
  }
}

module.exports = { DiscordService, DiscordApiError, friendlyDiscordError, API_BASE };
