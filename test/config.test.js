'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig, CALLBACK_PATH, normalizeOrigin } = require('../src/config');
const { secureEqual, makeUserPayload } = require('../src/security');

const BASE_ENV = {
  NODE_ENV: 'production',
  PORT: '3000',
  PUBLIC_APP_URL: 'https://zerqon.example',
  DISCORD_CLIENT_ID: '1559391065130270791',
  DISCORD_CLIENT_SECRET: 'not-a-real-secret',
  DISCORD_BOT_TOKEN: 'not-a-real-token',
  DISCORD_GUILD_ID: '1559283861945450536',
  DISCORD_VIP_ROLE_ID: '1560077185170284616',
  DISCORD_VIP_ROLE_NAME: 'zerqonviphub',
  DISCORD_INVITE_URL: 'https://discord.gg/KP5X63RWeU',
  SESSION_SECRET: 'a-realistic-test-session-secret-with-more-than-32-chars',
};

test('canonical Discord callback is derived from the actual origin', () => {
  const config = buildConfig({ ...BASE_ENV });
  assert.equal(config.expectedRedirectUri, `https://zerqon.example${CALLBACK_PATH}`);
  assert.equal(config.redirectUri, `https://zerqon.example${CALLBACK_PATH}`);
  assert.equal(config.redirectMatches, true);
});

test('mismatched Discord redirect URI is rejected', () => {
  const config = buildConfig({ ...BASE_ENV, DISCORD_REDIRECT_URI: 'https://old.example/api/auth/discord/callback' });
  assert.equal(config.redirectMatches, false);
  assert.equal(config.redirectUri, null);
  assert.equal(config.oauthReady, false);
});

test('production refuses a plain HTTP public origin', () => {
  const config = buildConfig({ ...BASE_ENV, PUBLIC_APP_URL: 'http://zerqon.example' });
  assert.ok(config.problems.some(problem => problem.includes('HTTPS')));
});

test('normalizeOrigin only accepts an origin and rejects paths, queries and credentials', () => {
  assert.equal(normalizeOrigin('https://zerqon.example/some-path'), null);
  assert.equal(normalizeOrigin('https://zerqon.example/?x=1'), null);
  assert.equal(normalizeOrigin('https://user:password@zerqon.example'), null);
});

test('constant-time token comparison rejects missing and mismatched values', () => {
  assert.equal(secureEqual('abc123', 'abc123'), true);
  assert.equal(secureEqual('abc123', 'abc124'), false);
  assert.equal(secureEqual('abc', 'abcd'), false);
  assert.equal(secureEqual(undefined, 'abc'), false);
});

test('Discord user payload is built from provider ID and has a safe avatar URL', () => {
  const user = makeUserPayload({ id: '123456789012345678', username: 'testuser', global_name: 'Test', avatar: 'hash' });
  assert.equal(user.id, '123456789012345678');
  assert.equal(user.username, 'testuser');
  assert.equal(user.avatar, 'https://cdn.discordapp.com/avatars/123456789012345678/hash.png?size=128');
});


test('placeholder secrets never count as production credentials', () => {
  const config = buildConfig({
    ...BASE_ENV,
    DISCORD_CLIENT_SECRET: 'replace-with-new-client-secret',
    DISCORD_BOT_TOKEN: 'replace-with-new-bot-token',
    SESSION_SECRET: 'replace-with-a-long-random-session-secret-at-least-32-characters',
  });
  assert.equal(config.clientSecret, '');
  assert.equal(config.botToken, '');
  assert.equal(config.sessionSecret, '');
  assert.equal(config.oauthReady, false);
  assert.equal(config.roleFlowConfigured, false);
});
