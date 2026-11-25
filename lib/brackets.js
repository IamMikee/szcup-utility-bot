const STAGE_ORDER = ['q', 'qf', 'sf', 'completed'];

function summarizeByStage(history) {
    const out = {};
    for (const h of history || []) {
        if (!h.stage) continue;
        if (!out[h.stage]) out[h.stage] = { wins: 0, losses: 0 };
        if (h.result === 'win') out[h.stage].wins += 1;
        else if (h.result === 'lose') out[h.stage].losses += 1;
    }
    return out;
}

/**
 * Example output: "q: win, win | qf: win"
 */
function formatHistorySummary(history) {
    const byStage = summarizeByStage(history);
    const parts = [];
    for (const stage of STAGE_ORDER) {
        const s = byStage[stage];
        if (!s) continue;
        const events = [];
        for (let i = 0; i < s.wins; i++) events.push('win');
        for (let i = 0; i < s.losses; i++) events.push('lose');
        if (events.length) parts.push(`${stage}: ${events.join(', ')}`);
    }
    return parts.length ? parts.join(' | ') : 'no matches yet';
}

module.exports = { summarizeByStage, formatHistorySummary, STAGE_ORDER };