'use strict';

const LOADSTRING = 'loadstring(game:HttpGet("https://raw.githubusercontent.com/Elproxd1234/zerqonhubSAD/main/zerqonhub.lua"))()';
const state = { page: 'home', session: null, status: null, source: null, csrfToken: null, logoutBusy: false };
const byId = id => document.getElementById(id);
const pageIds = new Set(['home', 'script', 'features', 'vip', 'account', 'changelog', 'docs', 'faq', 'privacy', 'terms', 'support', 'status']);

const icons = {
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
};

function toast(title, message, type = 'info', duration = 4500) {
  const region = byId('toast-region');
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
  const content = document.createElement('div');
  const heading = document.createElement('strong'); heading.textContent = title;
  const paragraph = document.createElement('p'); paragraph.textContent = message;
  content.append(heading, paragraph); item.append(icon, content); region.append(item);
  window.setTimeout(() => { item.classList.add('toast-out'); window.setTimeout(() => item.remove(), 270); }, duration);
}

async function api(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 12000);
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      signal: controller.signal,
    });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
    if (!response.ok) {
      const error = new Error(data.message || `Solicitud fallida (${response.status})`);
      error.status = response.status; error.data = data;
      throw error;
    }
    return data;
  } finally { window.clearTimeout(timeout); }
}

function setPage(page, options = {}) {
  const target = pageIds.has(page) ? page : 'not-found';
  state.page = target;
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === `page-${target}`));
  document.querySelectorAll('[data-page]').forEach(el => {
    if (el.classList.contains('nav-link')) el.classList.toggle('active', el.dataset.page === target);
  });
  byId('mobile-menu').hidden = true;
  byId('mobile-menu-button').setAttribute('aria-expanded', 'false');
  if (!options.keepHash) history.replaceState(null, '', `#${target}`);
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  document.title = `${document.querySelector(`#page-${target}`)?.dataset.title || 'No encontrado'} · ZERQON HUB VIP`;
  if (target === 'status') refreshStatus();
  if (target === 'vip' || target === 'account') loadSession().catch(() => {});
}

function getInitialPage() {
  const key = decodeURIComponent(window.location.hash.replace(/^#/, '') || 'home').split('/')[0];
  if (pageIds.has(key)) return key;
  if (['doc-copy', 'doc-discord', 'doc-errors', 'doc-privacy'].includes(key)) return 'docs';
  return 'home';
}

function showLoaderCopyFallback() {
  let fallback = byId('copy-fallback');
  if (!fallback) {
    fallback = document.createElement('div');
    fallback.id = 'copy-fallback';
    fallback.className = 'copy-fallback';
    fallback.innerHTML = '<label for="manual-loader">Copia manual: seleccioná este texto y usá Ctrl+C / ⌘C</label><textarea id="manual-loader" readonly rows="3"></textarea>';
    byId('loader-code').closest('.code-window').after(fallback);
  }
  fallback.hidden = false;
  const textarea = byId('manual-loader');
  textarea.value = LOADSTRING;
  textarea.focus(); textarea.select();
}

async function copyText(text, label) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error('Clipboard API unavailable');
    }
    toast('Copiado correctamente', `${label} quedó en el portapapeles.`, 'success');
    return true;
  } catch {
    try {
      const temporary = document.createElement('textarea');
      temporary.value = text; temporary.setAttribute('readonly', '');
      temporary.style.position = 'fixed'; temporary.style.opacity = '0'; temporary.style.left = '-10000px';
      document.body.append(temporary); temporary.select();
      const copied = document.execCommand('copy'); temporary.remove();
      if (copied) {
        toast('Copiado correctamente', `${label} quedó en el portapapeles.`, 'success');
        return true;
      }
    } catch { /* Use selectable fallback below. */ }
    showLoaderCopyFallback();
    toast('Copia manual disponible', 'El navegador bloqueó la copia automática. Seleccioná el texto que apareció debajo del código y copiá manualmente.', 'error', 6500);
    return false;
  }
}

function mapAuthError(code) {
  const messages = {
    oauth_not_configured: ['OAuth2 no está configurado', 'El backend necesita el dominio publicado y las credenciales privadas de Discord.'],
    discord_denied: ['Autorización cancelada', 'Discord no recibió tu autorización. Podés volver a intentarlo cuando quieras.'],
    oauth_state_invalid: ['Estado de seguridad inválido', 'Volvé al portal e iniciá el acceso de nuevo.'],
    oauth_exchange_failed: ['No se pudo completar Discord OAuth2', 'Revisá el client secret, el callback y la configuración del backend.'],
    session_error: ['Error de sesión', 'No se pudo guardar el intento de autenticación. Reintentá.'],
  };
  return messages[code] || ['No se pudo conectar Discord', 'Revisá el diagnóstico del sistema e intentá nuevamente.'];
}

function startDiscordLogin() {
  if (state.status && !state.status.oauthConfigured) {
    toast('OAuth2 pendiente de configuración', 'Configurá PUBLIC_APP_URL, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET y el redirect exacto antes de iniciar sesión.', 'error', 6000);
    setPage('status'); return;
  }
  window.location.assign('/api/auth/discord');
}

function setHeaderSession(user) {
  const login = byId('header-login');
  const accountButton = byId('header-account');
  if (user) {
    login.classList.add('hidden'); accountButton.classList.remove('hidden'); accountButton.innerHTML = '';
    if (user.avatar) { const img = document.createElement('img'); img.src = user.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer'; accountButton.append(img); }
    else accountButton.textContent = (user.username || 'D').slice(0, 1).toUpperCase();
  } else {
    login.classList.remove('hidden'); accountButton.classList.add('hidden'); accountButton.innerHTML = '';
  }
}

function setStep(id, status, label) {
  const step = byId(id); if (!step) return;
  step.classList.remove('done', 'failed', 'working');
  if (status) step.classList.add(status);
  const indicator = step.querySelector('.step-indicator');
  const stateText = step.querySelector('.step-state');
  if (indicator) indicator.textContent = status === 'done' ? '✓' : status === 'failed' ? '!' : step.id.replace('step-', '').replace('discord', '01').replace('member', '02').replace('role', '03');
  if (stateText) stateText.textContent = label || (status === 'done' ? 'Confirmado' : status === 'failed' ? 'Error' : 'Pendiente');
}

function renderVip(messageType = null, customMessage = null) {
  const session = state.session;
  const user = session && session.user;
  const vipStatus = session && session.vip ? session.vip.status : 'unknown';
  const tag = byId('vip-status-tag');
  const message = byId('verify-message');
  const connect = byId('vip-connect');
  const retry = byId('retry-verification');
  const joinLink = byId('vip-join-link');
  message.classList.remove('success', 'error');
  if (!user) {
    byId('account-name').textContent = 'Cuenta no conectada';
    byId('account-id').textContent = 'Conectá Discord para ver tu estado.';
    byId('account-auth-status').textContent = 'Sin conectar';
    byId('account-role-status').textContent = 'Desconocido';
    byId('account-last-check').textContent = '—';
    byId('account-connect').classList.remove('hidden');
    byId('account-logout').classList.add('hidden');
    byId('account-avatar').innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2Z"/></svg>';
    tag.textContent = 'Sin conectar'; tag.className = 'status-tag';
    byId('vip-card-title').textContent = 'Aún sin verificar';
    byId('vip-card-description').textContent = 'Conectá tu cuenta para consultar el resultado del backend.';
    byId('vip-card-role').textContent = 'zerqonviphub';
    byId('core-role-status').textContent = 'Pending';
    byId('account-connect').classList.remove('hidden');
    byId('account-logout').classList.add('hidden');
    setStep('step-discord', '', 'Pendiente'); setStep('step-member', '', 'Pendiente'); setStep('step-role', '', 'Pendiente');
    message.querySelector('strong').textContent = 'Preparado para verificar';
    message.querySelector('p').textContent = 'El estado real aparecerá después de conectar Discord. La demo visual no otorga permisos.';
    connect.classList.remove('hidden'); retry.classList.add('hidden'); joinLink.classList.remove('hidden');
    if (messageType) message.classList.add(messageType);
    return;
  }
  connect.classList.add('hidden'); retry.classList.remove('hidden');
  byId('account-name').textContent = user.globalName || user.username;
  byId('account-id').textContent = `Discord ID: ${user.id}`;
  byId('account-auth-status').textContent = 'Conectado';
  byId('account-role-status').textContent = vipLabel(vipStatus);
  byId('account-last-check').textContent = session.vip && session.vip.lastVerifiedAt ? formatDate(session.vip.lastVerifiedAt) : '—';
  byId('account-connect').classList.add('hidden'); byId('account-logout').classList.remove('hidden');
  byId('account-avatar').innerHTML = '';
  if (user.avatar) { const img = document.createElement('img'); img.src = user.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer'; byId('account-avatar').append(img); }
  else { byId('account-avatar').textContent = (user.username || 'D').slice(0, 1).toUpperCase(); }
  if (vipStatus === 'verified') {
    tag.textContent = 'VIP confirmado'; tag.className = 'status-tag success';
    byId('vip-card-title').textContent = 'Acceso confirmado'; byId('vip-card-description').textContent = 'Discord confirmó que el rol VIP está presente en tu cuenta.';
    byId('core-role-status').textContent = 'Verified';
    setStep('step-discord', 'done', 'Conectado'); setStep('step-member', 'done', 'Miembro'); setStep('step-role', 'done', 'Confirmado');
    message.classList.add('success'); message.querySelector('strong').textContent = 'Rol VIP confirmado';
    message.querySelector('p').textContent = 'El backend volvió a consultar tu registro de miembro y confirmó el rol configurado.';
    joinLink.classList.add('hidden');
  } else if (vipStatus === 'not_member') {
    tag.textContent = 'Unirse al servidor'; tag.className = 'status-tag error';
    byId('vip-card-title').textContent = 'Membresía requerida'; byId('vip-card-description').textContent = 'Conectaste Discord, pero la cuenta no figura como miembro del servidor.';
    byId('core-role-status').textContent = 'Join server';
    setStep('step-discord', 'done', 'Conectado'); setStep('step-member', 'failed', 'No miembro'); setStep('step-role', '', 'Pendiente');
    message.classList.add('error'); message.querySelector('strong').textContent = 'Primero uníte al servidor'; message.querySelector('p').textContent = 'Después de unirte, tocá Reintentar verificación para asignar y confirmar el rol.';
    joinLink.classList.remove('hidden');
  } else if (vipStatus === 'configuration_error') {
    tag.textContent = 'Configuración pendiente'; tag.className = 'status-tag error';
    byId('vip-card-title').textContent = 'Revisar configuración'; byId('vip-card-description').textContent = 'El backend no pudo validar la configuración o los permisos del bot.';
    byId('core-role-status').textContent = 'Setup issue';
    setStep('step-discord', 'done', 'Conectado'); setStep('step-member', '', 'No confirmado'); setStep('step-role', 'failed', 'Revisar bot');
    message.classList.add('error'); message.querySelector('strong').textContent = 'El bot necesita atención'; message.querySelector('p').textContent = customMessage || 'Revisá System Status: token, servidor, rol, permiso Manage Roles y jerarquía.';
    joinLink.classList.add('hidden');
  } else if (vipStatus === 'error' || vipStatus === 'removal_pending') {
    tag.textContent = 'Verificación incompleta'; tag.className = 'status-tag error';
    byId('vip-card-title').textContent = 'No se pudo confirmar'; byId('vip-card-description').textContent = 'Discord no confirmó la asignación. Podés volver a intentarlo.';
    byId('core-role-status').textContent = 'Retry';
    setStep('step-discord', 'done', 'Conectado'); setStep('step-member', '', 'No confirmado'); setStep('step-role', 'failed', 'Reintentar');
    message.classList.add('error'); message.querySelector('strong').textContent = 'El rol no está confirmado'; message.querySelector('p').textContent = customMessage || 'No se muestra como VIP hasta que el backend confirme el rol en Discord.';
    joinLink.classList.add('hidden');
  } else {
    tag.textContent = 'Estado pendiente'; tag.className = 'status-tag';
    byId('vip-card-title').textContent = 'Verificación pendiente'; byId('vip-card-description').textContent = 'Volvé a comprobar membresía y estado del rol.';
    byId('core-role-status').textContent = 'Pending';
    setStep('step-discord', 'done', 'Conectado'); setStep('step-member', '', 'Pendiente'); setStep('step-role', '', 'Pendiente');
    message.querySelector('strong').textContent = 'Podés reintentar'; message.querySelector('p').textContent = 'La sesión está conectada, pero el estado VIP necesita una comprobación del backend.';
    joinLink.classList.remove('hidden');
  }
  if (messageType) message.classList.add(messageType);
}

function vipLabel(status) {
  return ({ verified: 'VIP confirmado', not_member: 'No está en el servidor', configuration_error: 'Configuración pendiente', error: 'No confirmado', removal_pending: 'Retiro pendiente', removed: 'Rol retirado', left_server: 'Salió del servidor' })[status] || 'Pendiente';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadSession() {
  const session = await api('/api/session', { timeout: 7000 });
  state.session = session; state.csrfToken = session.csrfToken;
  setHeaderSession(session.user);
  renderVip();
  return session;
}

function setStatusIndicator(id, status) {
  const node = byId(id); if (!node) return;
  node.classList.remove('up', 'down', 'unknown'); node.classList.add(status === true ? 'up' : status === false ? 'down' : 'unknown');
}

function setStatusCard(prefix, status, text, foot) {
  setStatusIndicator(`status-${prefix}-dot`, status);
  byId(`status-${prefix}-text`).textContent = text;
  byId(`status-${prefix}-foot`).textContent = foot;
}

async function refreshStatus() {
  const lastCheck = byId('status-last-check');
  lastCheck.textContent = 'Consultando…';
  try {
    const basic = await api('/api/health', { timeout: 7000 });
    setStatusCard('api', Boolean(basic.ok), basic.ok ? 'El servidor respondió a la comprobación de salud.' : 'No se recibió una respuesta válida.', basic.ok ? 'Disponible' : 'No disponible');
  } catch {
    setStatusCard('api', false, 'No se pudo conectar con el backend.', 'No disponible');
  }
  try {
    const data = await api('/api/status', { timeout: 15000 });
    state.status = data;
    const appOrigin = data.publicAppUrl || 'No configurada';
    const cb = data.expectedRedirectUri || 'Pendiente de configurar el dominio público';
    if (data.discordInviteUrl) { byId('community-invite').href = data.discordInviteUrl; byId('vip-join-link').href = data.discordInviteUrl; byId('support-discord-link').href = data.discordInviteUrl; byId('support-destination').href = data.discordInviteUrl; }
    else { byId('support-destination-copy').textContent = 'El enlace de invitación debe configurarse en DISCORD_INVITE_URL.'; }
    if (data.supportUrl) { byId('support-destination').href = data.supportUrl; byId('support-destination').textContent = 'Abrir soporte ↗'; byId('support-destination-copy').textContent = 'Abrí el canal de soporte oficial configurado por el propietario.'; }
    byId('diagnostic-callback').textContent = cb;
    setStatusCard('oauth', Boolean(data.oauthReady && data.redirectConfiguredCorrectly), data.redirectConfiguredCorrectly ? `Callback previsto: ${cb}` : 'El backend necesita PUBLIC_APP_URL y una URI idéntica en Discord Developer Portal.', data.oauthReady ? 'Configuración presente' : 'Configuración incompleta');
    const role = data.roleCheck || {};
    const roleState = Boolean(role.ready);
    let roleText = role.issue || (roleState ? `El bot detectó el rol “${role.actualRoleName || 'VIP'}” y los permisos necesarios.` : 'Los roles y permisos todavía no están confirmados.');
    setStatusCard('role', roleState, roleText, roleState ? 'Rol y permisos confirmados' : 'Revisar configuración');
    const source = await api('/api/source-status', { timeout: 7000 });
    state.source = source;
    setStatusCard('source', source.ok, source.detail || (source.ok === null ? 'No se pudo comprobar la fuente.' : source.ok ? 'GitHub respondió correctamente.' : 'La fuente no respondió correctamente.'), source.ok === true ? `HTTP ${source.httpStatus || 200}` : source.ok === false ? `HTTP ${source.httpStatus || 'error'}` : 'No comprobada');
    const list = byId('diagnostics-checklist'); list.innerHTML = '';
    const checks = [
      ['URL pública', Boolean(data.publicAppUrl), appOrigin],
      ['Redirect URI', Boolean(data.redirectConfiguredCorrectly), data.redirectConfiguredCorrectly ? 'Consistente' : 'No coincide o falta'],
      ['OAuth2', Boolean(data.oauthReady), data.oauthReady ? 'Variables presentes' : 'Faltan credenciales/configuración'],
      ['VIP role', Boolean(role.roleNameMatches && role.roleExists), role.roleNameMatches ? role.actualRoleName : 'ID/nombre sin confirmar'],
      ['Manage Roles', Boolean(role.manageRoles), role.manageRoles ? 'Permiso detectado' : 'No confirmado'],
      ['Jerarquía', Boolean(role.hierarchyOk), role.hierarchyOk ? 'Bot por encima del VIP' : 'No confirmada'],
      ['Gateway', Boolean(data.gatewayReady), data.gatewayReady ? 'Conectado' : 'Sin conexión/pendiente'],
    ];
    for (const [label, ok, detail] of checks) {
      const chip = document.createElement('span'); chip.className = `checklist-item ${ok ? 'ok' : 'bad'}`; chip.textContent = `${label}: ${detail}`; list.append(chip);
    }
    byId('header-status').textContent = data.productionReady ? 'Sistemas listos' : 'Config. pendiente';
    byId('header-status-dot').classList.toggle('unknown', !data.productionReady);
    byId('core-role-status').textContent = roleState ? 'Ready' : 'Pending';
    lastCheck.textContent = formatDate(data.checkedAt || new Date().toISOString());
  } catch (error) {
    byId('diagnostic-callback').textContent = 'No se pudo consultar el backend';
    setStatusCard('oauth', null, 'No se pudo consultar la configuración.', 'Estado desconocido');
    setStatusCard('role', null, 'No se pudo comprobar la configuración del rol.', 'Estado desconocido');
    setStatusCard('source', null, 'La comprobación no está disponible.', 'Estado desconocido');
    byId('header-status').textContent = 'Estado desconocido'; byId('header-status-dot').classList.add('unknown');
    lastCheck.textContent = 'No disponible';
  }
}

async function checkSource() {
  const button = byId('check-source');
  button.disabled = true; button.classList.add('is-loading');
  button.childNodes[0].textContent = 'Comprobando… ';
  try {
    const data = await api('/api/source-status', { timeout: 7000 });
    state.source = data; renderSourceStatus(data);
    if (data.ok === true) toast('Fuente disponible', data.detail || 'GitHub respondió correctamente.', 'success');
    else if (data.ok === false) toast('Fuente no disponible', data.detail || 'La URL no respondió correctamente.', 'error');
    else toast('Estado desconocido', data.detail || 'No se pudo comprobar la fuente.', 'error');
  } catch {
    renderSourceStatus({ ok: null, status: 'unknown', detail: 'El backend no pudo consultar GitHub.' });
    toast('No se pudo comprobar', 'El backend no logró consultar GitHub en este momento.', 'error');
  } finally {
    button.disabled = false; button.classList.remove('is-loading');
    button.innerHTML = 'Comprobar fuente <svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.3 5A7 7 0 0 0 18 15"/></svg>';
  }
}

function renderSourceStatus(data) {
  const text = data.ok === true ? `GitHub disponible · HTTP ${data.httpStatus || 200}` : data.ok === false ? `Fuente no disponible · HTTP ${data.httpStatus || 'error'}` : 'Fuente pendiente de comprobar';
  byId('source-status-text').textContent = text;
  byId('source-panel-title').textContent = data.ok === true ? 'Fuente disponible' : data.ok === false ? 'Fuente no disponible' : 'Comprobación pendiente';
  byId('source-panel-description').textContent = data.detail || (data.ok === true ? 'La fuente respondió correctamente al servidor.' : 'No se confirmó la disponibilidad de la fuente.');
  byId('source-meta').innerHTML = `<i></i> ${data.ok === true ? 'Fuente disponible' : data.ok === false ? 'Fuente no disponible' : 'Fuente sin comprobar'}`;
  if (data.ok === true) byId('source-meta').style.color = 'var(--mint)';
  else if (data.ok === false) byId('source-meta').style.color = 'var(--red)';
  else byId('source-meta').style.color = '';
}

async function retryVerification() {
  const button = byId('retry-verification');
  if (!state.session?.authenticated || !state.csrfToken) { toast('Conectá Discord', 'Necesitás iniciar sesión antes de reintentar.', 'error'); return; }
  button.disabled = true; button.textContent = 'Verificando…';
  const message = byId('verify-message'); message.classList.remove('success', 'error');
  message.querySelector('strong').textContent = 'Consultando Discord…';
  message.querySelector('p').textContent = 'El backend comprueba membresía, permisos y rol VIP.';
  try {
    const result = await api('/api/verification/retry', { method: 'POST', headers: { 'x-csrf-token': state.csrfToken }, body: JSON.stringify({}), timeout: 15000 });
    await loadSession();
    renderVip('success', result.message);
    toast(result.assigned ? 'Rol VIP asignado' : 'Rol VIP confirmado', result.message, 'success');
  } catch (error) {
    if (error.status === 401) { state.session = { authenticated: false, user: null }; renderVip('error', error.message); toast('Sesión expirada', 'Volvé a conectar Discord.', 'error'); }
    else {
      try { await loadSession(); } catch { /* The inline error stays available. */ }
      renderVip('error', error.message || 'No se pudo confirmar el rol.');
      toast('Verificación incompleta', error.message || 'No se pudo confirmar el rol.', 'error', 6000);
      if (error.data?.setup?.issue) {
        byId('verify-message').querySelector('p').textContent = error.data.setup.issue;
      }
    }
  } finally {
    button.disabled = false; button.innerHTML = 'Reintentar verificación <svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.3 5A7 7 0 0 0 18 15"/></svg>';
  }
}

function openLogoutModal() {
  if (!state.session?.authenticated) { toast('Sin sesión activa', 'Conectá Discord antes de cerrar sesión.', 'info'); return; }
  byId('logout-modal').hidden = false; byId('logout-confirm').focus();
}
function closeLogoutModal() { byId('logout-modal').hidden = true; }
async function performLogout() {
  if (state.logoutBusy) return;
  if (!state.csrfToken) { toast('Sesión desactualizada', 'Actualizá la página para renovar el token de seguridad.', 'error'); return; }
  state.logoutBusy = true;
  const button = byId('logout-confirm'); button.disabled = true; button.textContent = 'Quitando VIP y cerrando…';
  try {
    const result = await api('/api/logout', { method: 'POST', headers: { 'x-csrf-token': state.csrfToken }, body: JSON.stringify({}), timeout: 15000 });
    state.session = { authenticated: false, user: null }; state.csrfToken = null;
    setHeaderSession(null); renderVip(); closeLogoutModal(); setPage('home');
    if (result.roleRemovalConfirmed) {
      const message = result.roleRemoved ? 'Discord confirmó que el rol fue retirado y la sesión terminó.' : result.roleAlreadyAbsent ? 'El rol ya no estaba presente. La sesión terminó.' : 'La cuenta ya no pertenecía al servidor. La sesión terminó.';
      toast('Sesión cerrada', message, 'success');
    } else {
      toast('Sesión cerrada con advertencia', result.warning || 'Discord no confirmó la retirada; quedó un reintento pendiente.', 'error', 7000);
    }
    await refreshStatus();
  } catch (error) {
    toast('No se pudo cerrar sesión', error.message || 'Reintentá en unos segundos.', 'error');
  } finally {
    state.logoutBusy = false; button.disabled = false; button.textContent = 'Cerrar sesión y quitar VIP';
  }
}

function handleInitialQuery() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('authError');
  if (authError) {
    const [title, message] = mapAuthError(authError);
    toast(title, message, 'error', 6500);
    history.replaceState(null, '', window.location.hash || '#vip');
    setPage('vip', { keepHash: true });
  }
  if (params.get('auth') === 'complete') {
    setPage('vip', { keepHash: true });
    loadSession().then(session => {
      const status = session.vip?.status;
      if (status === 'verified') toast('Discord conectado', 'El backend confirmó que el rol VIP está presente.', 'success');
      else if (status === 'not_member') toast('Un paso más', 'Uníte al servidor de Discord y después reintentá la verificación.', 'info', 6000);
      else if (status === 'configuration_error') toast('Configuración pendiente', 'El inicio de sesión funcionó, pero el bot necesita configuración.', 'error', 6500);
      else toast('Discord conectado', 'La cuenta se conectó, pero el rol todavía no está confirmado.', 'info', 6000);
      history.replaceState(null, '', '#vip');
    }).catch(() => toast('Discord conectado parcialmente', 'Actualizá la página para consultar el estado.', 'error'));
  }
}

function init() {
  byId('loader-code').textContent = LOADSTRING;
  byId('footer-year').textContent = String(new Date().getFullYear());
  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', event => {
      const page = el.dataset.page;
      if (!page) return;
      event.preventDefault();
      if (page === 'account' && !state.session?.authenticated) {
        setPage('vip'); toast('Conectá Discord primero', 'Después de iniciar sesión vas a poder abrir tu cuenta.', 'info'); return;
      }
      setPage(page);
    });
    if (el.classList.contains('feature-card')) {
      el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPage(el.dataset.page); } });
    }
  });
  byId('header-login').addEventListener('click', startDiscordLogin);
  byId('vip-connect').addEventListener('click', startDiscordLogin);
  byId('account-connect').addEventListener('click', startDiscordLogin);
  byId('header-account').addEventListener('click', () => setPage('account'));
  byId('account-logout').addEventListener('click', openLogoutModal);
  byId('retry-verification').addEventListener('click', retryVerification);
  byId('copy-loader').addEventListener('click', () => copyText(LOADSTRING, 'El loadstring'));
  byId('copy-loader-small').addEventListener('click', () => copyText(LOADSTRING, 'El loadstring'));
  byId('check-source').addEventListener('click', checkSource);
  byId('refresh-status').addEventListener('click', refreshStatus);
  byId('copy-callback').addEventListener('click', () => copyText(byId('diagnostic-callback').textContent, 'El redirect URI'));
  byId('logout-confirm').addEventListener('click', performLogout);
  byId('logout-cancel').addEventListener('click', closeLogoutModal);
  byId('logout-cancel-x').addEventListener('click', closeLogoutModal);
  byId('logout-modal').addEventListener('click', event => { if (event.target === byId('logout-modal')) closeLogoutModal(); });
  byId('mobile-menu-button').addEventListener('click', () => {
    const menu = byId('mobile-menu'); const opening = menu.hidden;
    menu.hidden = !opening; byId('mobile-menu-button').setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeLogoutModal(); });
  window.addEventListener('hashchange', () => { const target = getInitialPage(); if (target !== state.page) setPage(target, { keepHash: true }); });
  setPage(getInitialPage(), { keepHash: true });
  loadSession().then(session => {
    renderVip();
    if (session.authenticated && session.vip?.status === 'verified') {
      byId('header-status').textContent = 'Sesión conectada';
    }
  }).catch(() => { renderVip(); });
  refreshStatus();
  handleInitialQuery();
  window.setInterval(() => { if (state.page === 'status') refreshStatus(); }, 60000);
}

document.addEventListener('DOMContentLoaded', init);
