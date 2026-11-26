const { getTeamNameFromForm } = require('./form');

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

// Team role name: "TEAM_NAME-TICKET_CODE", or just the ticket code when the form has
// no team name. The ticket code is always kept intact; a long team name is trimmed.
function ticketRoleNameFor(ticketCode, formData) {
  const teamName = getTeamNameFromForm(formData);
  if (!teamName) return ticketCode;
  const room = 100 - ticketCode.length - 1;
  return `${teamName.slice(0, room).trim()}-${ticketCode}`;
}

// Finds the existing team role for a ticket by its code: either "...-TICKET_CODE" or
// a bare "TICKET_CODE" (fallback roles and ones made before team names existed).
// Matching on the code alone means a team name edited later doesn't orphan the role.
async function findTicketRole(guild, ticketCode) {
  return (
    guild.roles.cache.find(
      (r) => r.name === ticketCode || r.name.endsWith(`-${ticketCode}`)
    ) ?? null
  );
}

// Inverse of ticketRoleNameFor: "TEAM-TICKETCODE" -> { teamName, ticketCode }, or a bare
// "TICKETCODE" -> { teamName: null, ticketCode }. Returns null for any other role name.
// A match is only a candidate: callers must confirm the code exists in Firestore.
const TICKET_ROLE_RE = /^(?:(.+)-)?([A-Za-z0-9]{8})$/;
function parseTicketRoleName(name) {
  const m = TICKET_ROLE_RE.exec(name);
  if (!m) return null;
  return { teamName: m[1] ? m[1].trim() : null, ticketCode: m[2].toUpperCase() };
}

module.exports = { getOrCreateRole, ticketRoleNameFor, findTicketRole, parseTicketRoleName };
