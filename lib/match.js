const { randomUUID } = require('crypto');

function newMatchId() { return randomUUID(); }
function shortId(matchId) { return matchId.replace(/-/g, '').slice(0, 6); }

function vcName(codeA, codeB, matchId) {
  return `${codeA}-vs-${codeB}-${shortId(matchId)}`.slice(0, 100);
}
function matchRoleName(codeA, codeB, matchId) {
  return `Match-${codeA}-vs-${codeB}-${shortId(matchId)}`.slice(0, 100);
}

// Accepts BOTH the new PvP pattern and the old single-team pattern,
// so any leftover VCs/roles from before this change are still cleaned up.
const VC_NAME_RE = /^([A-Za-z0-9]{8}-vs-[A-Za-z0-9]{8}-[a-f0-9]{6}|[A-Za-z0-9]{8}-match-[a-f0-9]{6})$/;
const ROLE_NAME_RE = /^(Match-[A-Za-z0-9]{8}-vs-[A-Za-z0-9]{8}-[a-f0-9]{6}|Match-[A-Za-z0-9]{8}-[a-f0-9]{6})$/;

module.exports = { newMatchId, shortId, vcName, matchRoleName, VC_NAME_RE, ROLE_NAME_RE };