'use strict';

const CALLBACK_PATH = '/api/auth/discord/callback';

function normalizeOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) return null;
    return url.origin.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isPlaceholder(value) {
  return !value || /^(replace-with|your[-_ ]|change[-_ ]me|paste[-_ ]here)/i.test(String(value).trim());
}

function buildConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const appOrigin = normalizeOrigin(env.PUBLIC_APP_URL || (!isProduction ? 'http://localhost:3000' : ''));
  const expectedRedirectUri = appOrigin ? `${appOrigin}${CALLBACK_PATH}` : null;
  const configuredRedirectUri = env.DISCORD_REDIRECT_URI ? env.DISCORD_REDIRECT_URI.trim() : expectedRedirectUri;
  const redirectMatches = Boolean(expectedRedirectUri && configuredRedirectUri === expectedRedirectUri);
  const vipRoleId = (env.DISCORD_VIP_ROLE_ID || '1560077185170284616').trim();
  const guildId = (env.DISCORD_GUILD_ID || '').trim();
  const clientId = (env.DISCORD_CLIENT_ID || '').trim();
  const rawClientSecret = (env.DISCORD_CLIENT_SECRET || '').trim();
  const rawBotToken = (env.DISCORD_BOT_TOKEN || '').trim();
  const clientSecret = isPlaceholder(rawClientSecret) ? '' : rawClientSecret;
  const botToken = isPlaceholder(rawBotToken) ? '' : rawBotToken;
  const rawSessionSecret = (env.SESSION_SECRET || '').trim();
  const devSecret = 'local-development-only-change-this-before-deploying-32chars';
  const sessionSecret = isPlaceholder(rawSessionSecret) ? (isProduction ? '' : devSecret) : rawSessionSecret;
  const inviteUrl = (env.DISCORD_INVITE_URL || '').trim();
  const supportUrl = (env.SUPPORT_URL || '').trim();
  const roleName = (env.DISCORD_VIP_ROLE_NAME || 'zerqonviphub').trim();

  const problems = [];
  if (!appOrigin) problems.push('PUBLIC_APP_URL falta o no es una URL válida.');
  if (!expectedRedirectUri) problems.push('No se puede calcular el callback de Discord.');
  if (!redirectMatches) problems.push(`DISCORD_REDIRECT_URI debe coincidir exactamente con ${expectedRedirectUri || 'PUBLIC_APP_URL + ' + CALLBACK_PATH}.`);
  if (!clientId) problems.push('Falta DISCORD_CLIENT_ID.');
  if (!clientSecret) problems.push('Falta DISCORD_CLIENT_SECRET.');
  if (!botToken) problems.push('Falta DISCORD_BOT_TOKEN.');
  if (!guildId) problems.push('Falta DISCORD_GUILD_ID.');
  if (!vipRoleId || !/^\d{17,20}$/.test(vipRoleId)) problems.push('DISCORD_VIP_ROLE_ID no parece un ID de Discord válido.');
  if (!sessionSecret || sessionSecret.length < 32) problems.push('SESSION_SECRET debe tener al menos 32 caracteres.');
  if (isProduction && appOrigin && !appOrigin.startsWith('https://')) problems.push('PUBLIC_APP_URL debe usar HTTPS en producción.');
  if (isProduction && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) problems.push('Configura un SESSION_SECRET aleatorio de al menos 32 caracteres para producción.');

  return {
    nodeEnv: env.NODE_ENV || 'development',
    isProduction,
    port: Number.parseInt(env.PORT || '3000', 10),
    databasePath: env.DATABASE_PATH || './data/zerqon.sqlite',
    appOrigin,
    callbackPath: CALLBACK_PATH,
    redirectUri: redirectMatches ? expectedRedirectUri : null,
    expectedRedirectUri,
    configuredRedirectUri,
    redirectMatches,
    clientId,
    clientSecret,
    botToken,
    guildId,
    vipRoleId,
    vipRoleName: roleName,
    inviteUrl,
    supportUrl,
    sessionSecret,
    gatewayEnabled: env.ENABLE_DISCORD_GATEWAY !== 'false',
    problems,
    oauthReady: Boolean(appOrigin && redirectMatches && clientId && clientSecret && sessionSecret.length >= 32),
    roleFlowConfigured: Boolean(botToken && guildId && vipRoleId),
  };
}

module.exports = { buildConfig, CALLBACK_PATH, normalizeOrigin, isPlaceholder };
