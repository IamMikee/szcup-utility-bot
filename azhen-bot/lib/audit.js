// Discord message limit is 2000 chars.
function clip(content) {
  const text = String(content);
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

async function audit(client, content) {
  try {
    const ch = await client.channels.fetch(process.env.AUDIT_CHANNEL_ID);
    if (ch?.isTextBased()) {
      await ch.send({ content: clip(content), allowedMentions: { parse: [] } });
    }
  } catch (e) {
    console.error('Audit send failed:', e);
  }
}

// Console + audit channel, used for failed DB writes and unexpected errors.
async function reportError(client, context, err) {
  console.error(`[ERROR] ${context}:`, err);
  await audit(client, `⚠️ [ERROR] ${context}: ${err?.message || err}`);
}

module.exports = { audit, reportError };
