'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DiscordService } = require('../src/discord');

const GUILD = '1559283861945450536';
const VIP = '1560077185170284616';
const BOT = '166000000000000001';
const USER = '166000000000000002';
const BOT_ROLE = '166000000000000003';
const MANAGE_ROLES = String(1n << 28n);

function baseConfig(overrides = {}) {
  return {
    botToken: 'fake-test-token', guildId: GUILD, vipRoleId: VIP, vipRoleName: 'zerqonviphub',
    clientId: '1559391065130270791', clientSecret: 'not-used', redirectUri: 'https://zerqon.example/api/auth/discord/callback',
    roleFlowConfigured: true, ...overrides,
  };
}

function jsonResponse(status, data) {
  return new Response(data === null ? null : JSON.stringify(data), { status, headers: data === null ? {} : { 'content-type': 'application/json' } });
}

function setupFetch({ initialRoles = [], targetRoleName = 'zerqonviphub', botCanManage = true, botAboveVip = true } = {}) {
  let userHasVip = initialRoles.includes(VIP);
  const roles = [
    { id: GUILD, name: '@everyone', position: 0, permissions: '0' },
    { id: VIP, name: targetRoleName, position: 3, permissions: '0' },
    { id: BOT_ROLE, name: 'Zerqon Bot', position: botAboveVip ? 10 : 2, permissions: botCanManage ? MANAGE_ROLES : '0' },
  ];
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const route = new URL(url).pathname.replace('/api/v10', '');
    calls.push({ method: options.method || 'GET', route, headers: options.headers });
    if (route === '/users/@me') return jsonResponse(200, { id: BOT, username: 'ZerqonBot' });
    if (route === `/guilds/${GUILD}/roles`) return jsonResponse(200, roles);
    if (route === `/guilds/${GUILD}/members/${BOT}`) return jsonResponse(200, { user: { id: BOT }, roles: [BOT_ROLE] });
    if (route === `/guilds/${GUILD}/members/${USER}`) return jsonResponse(200, { user: { id: USER }, roles: userHasVip ? [VIP] : [] });
    if (route === `/guilds/${GUILD}/members/${USER}/roles/${VIP}` && options.method === 'PUT') { userHasVip = true; return jsonResponse(204, null); }
    if (route === `/guilds/${GUILD}/members/${USER}/roles/${VIP}` && options.method === 'DELETE') { userHasVip = false; return jsonResponse(204, null); }
    return jsonResponse(404, { message: 'Unknown route' });
  };
  return { fakeFetch, calls, hasVip: () => userHasVip };
}

test('assignVipRole verifies bot configuration, assigns the role and rechecks it', async () => {
  const original = global.fetch;
  const fake = setupFetch(); global.fetch = fake.fakeFetch;
  try {
    const service = new DiscordService(baseConfig(), {}, { warn() {}, log() {} });
    const result = await service.assignVipRole(USER);
    assert.equal(result.confirmed, true);
    assert.equal(result.assigned, true);
    assert.equal(fake.hasVip(), true);
    assert.ok(fake.calls.some(call => call.method === 'PUT' && call.route.endsWith(`/roles/${VIP}`)));
  } finally { global.fetch = original; }
});

test('assignVipRole does not assign a role if the configured role name is wrong', async () => {
  const original = global.fetch;
  const fake = setupFetch({ targetRoleName: 'something-else' }); global.fetch = fake.fakeFetch;
  try {
    const service = new DiscordService(baseConfig(), {}, { warn() {}, log() {} });
    await assert.rejects(() => service.assignVipRole(USER), error => error.code === 'DISCORD_SETUP_NOT_READY');
    assert.equal(fake.calls.some(call => call.method === 'PUT'), false);
  } finally { global.fetch = original; }
});

test('assignVipRole detects bot role hierarchy and permission failures', async () => {
  const original = global.fetch;
  const fake = setupFetch({ botAboveVip: false }); global.fetch = fake.fakeFetch;
  try {
    const service = new DiscordService(baseConfig(), {}, { warn() {}, log() {} });
    await assert.rejects(() => service.assignVipRole(USER), error => error.code === 'DISCORD_SETUP_NOT_READY' && /por encima/.test(error.setup.issue));
    assert.equal(fake.calls.some(call => call.method === 'PUT'), false);
  } finally { global.fetch = original; }
});

test('removeVipRole removes the exact VIP role and confirms absence', async () => {
  const original = global.fetch;
  const fake = setupFetch({ initialRoles: [VIP] }); global.fetch = fake.fakeFetch;
  try {
    const service = new DiscordService(baseConfig(), {}, { warn() {}, log() {} });
    const result = await service.removeVipRole(USER);
    assert.equal(result.confirmed, true);
    assert.equal(result.removed, true);
    assert.equal(fake.hasVip(), false);
    assert.ok(fake.calls.some(call => call.method === 'DELETE' && call.route.endsWith(`/roles/${VIP}`)));
  } finally { global.fetch = original; }
});
