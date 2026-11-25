// Guards against two simultaneous /verify calls creating duplicate roles.
const pending = new Map();

async function getOrCreateRole(guild, name) {
  const existing = guild.roles.cache.find((r) => r.name === name);
  if (existing) return existing;

  const key = `${guild.id}:${name}`;
  if (pending.has(key)) return pending.get(key);

  const promise = guild.roles
    .create({ name, reason: 'AZHEN auto-role' })
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

module.exports = { getOrCreateRole };
