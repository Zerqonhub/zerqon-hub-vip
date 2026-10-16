'use strict';
const crypto = require('node:crypto');

function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function makeUserPayload(user) {
  const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128` : null;
  return {
    id: String(user.id),
    username: String(user.username || 'Discord user').slice(0, 100),
    globalName: user.global_name ? String(user.global_name).slice(0, 100) : null,
    avatar,
    discriminator: user.discriminator ? String(user.discriminator) : null,
  };
}

module.exports = { secureEqual, makeUserPayload };
