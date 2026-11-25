const { db } = require('./firebase');
const { getFormResponseData, getTeamNameFromForm } = require('./form');

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

// Name of the team role for a ticket: team name if the form has one, else the ticket code.
function ticketRoleNameFor(ticketCode, formData) {
  return (getTeamNameFromForm(formData) || ticketCode).slice(0, 100);
}

// Finds the existing team role for a ticket. Falls back to a role named after the
// ticket code, so players verified before team-name roles existed still resolve.
async function findTicketRole(guild, ticketCode) {
  let formData = null;
  try {
    const snap = await db.collection('tickets').doc(ticketCode).get();
    if (snap.exists) formData = await getFormResponseData(snap.data());
  } catch (e) {
    console.error(`findTicketRole: could not read ticket ${ticketCode}:`, e.message);
  }
  const name = ticketRoleNameFor(ticketCode, formData);
  return (
    guild.roles.cache.find((r) => r.name === name) ??
    guild.roles.cache.find((r) => r.name === ticketCode) ??
    null
  );
}

module.exports = { getOrCreateRole, ticketRoleNameFor, findTicketRole };
