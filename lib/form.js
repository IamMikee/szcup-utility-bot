// lib/form.js
const { db } = require('./firebase');

/**
 * Answers on the form response are stored as an object:
 *   { [answerId]: value }
 * This helper also defensively handles array-shaped answers.
 */
function extractAnswerValue(data, answerId) {
  const answers = data?.answers;
  if (!answers) return null;
  if (typeof answers === 'object' && !Array.isArray(answers)) {
    return answers[answerId] ?? null;
  }
  if (Array.isArray(answers)) {
    const found = answers.find(
      (a) => a.id === answerId || a.questionId === answerId || a.answerId === answerId
    );
    return found?.value ?? found?.answer ?? found?.text ?? null;
  }
  return null;
}

async function getFormResponseData(ticket) {
  if (!ticket?.formId || !ticket?.responseId) return null;
  const ref = db
    .collection('forms')
    .doc(ticket.formId)
    .collection('responses')
    .doc(ticket.responseId);
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

/**
 * Returns { names, foundIds, missingIds }.
 *
 * Missing answer IDs are EXPECTED — different games use different forms,
 * so NAME_ANSWER_IDS is a union of IDs across all forms. We silently skip
 * missing ones; the caller receives them via `missingIds` for logging.
 *
 * NEVER throws on a missing ID.
 */
function getPlayerNamesFromForm(formData) {
  const ids = (process.env.NAME_ANSWER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!formData) return { names: [], foundIds: [], missingIds: ids };

  const names = [];
  const foundIds = [];
  const missingIds = [];

  for (const id of ids) {
    const val = extractAnswerValue(formData, id);
    if (val === null || val === undefined || String(val).trim() === '') {
      missingIds.push(id);
      continue;
    }
    foundIds.push(id);
    String(val)
      .split(/[,\n;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => names.push(n));
  }

  return { names, foundIds, missingIds };
}

/**
 * GAME_ANSWER_ID is a single shared answer ID (shared form template),
 * so it is present on every valid ticket. Returns null only on corrupt data.
 */
function getGameFromForm(formData) {
  if (!formData) return null;
  const id = process.env.GAME_ANSWER_ID;
  if (!id) return null;
  const val = extractAnswerValue(formData, id);
  return val !== null && val !== undefined && String(val).trim() !== ''
    ? String(val).trim()
    : null;
}

/**
 * TEAM_NAME_ID is a single answer ID holding the team's name. Team name is
 * optional — returns null when unset or empty so callers can fall back to the
 * ticket code.
 */
function getTeamNameFromForm(formData) {
  if (!formData) return null;
  const id = process.env.TEAM_NAME_ID;
  if (!id) return null;
  const val = extractAnswerValue(formData, id);
  return val !== null && val !== undefined && String(val).trim() !== ''
    ? String(val).trim()
    : null;
}

module.exports = {
  extractAnswerValue,
  getFormResponseData,
  getPlayerNamesFromForm,
  getGameFromForm,
  getTeamNameFromForm,
};