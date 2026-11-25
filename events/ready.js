const { Events, ActivityType } = require('discord.js');
const { db } = require('../lib/firebase');
const { audit, reportError } = require('../lib/audit');
const { VC_NAME_RE, ROLE_NAME_RE } = require('../lib/match');

async function clearActiveMatches() {
  const snap = await db.collection('active_matches').get();
  let count = 0;
  for (let i = 0; i < snap.docs.length; i += 500) {
    const batch = db.batch();
    snap.docs.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    count += Math.min(500, snap.docs.length - i);
  }
  return count;
}

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    // 1-2. Status + log
    client.user.setPresence({
      activities: [{ name: "SZCUP '26", type: ActivityType.Competing }],
      status: 'online',
    });
    console.log(`AZHEN online as ${client.user.tag}`);

    let cleared = 0;
    let deletedVcs = 0;
    let deletedRoles = 0;

    // 3. Clear active_matches
    try {
      cleared = await clearActiveMatches();
    } catch (e) {
      await reportError(client, 'startup: clear active_matches', e);
    }

    // 4. Orphan cleanup
    try {
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);

      try {
        const cfg = await db.collection('config').doc('match_settings').get();
        const templateId = cfg.exists ? cfg.data().vcId : null;
        if (templateId) {
          const templateVC = await guild.channels.fetch(templateId).catch(() => null);
          if (templateVC) {
            const all = await guild.channels.fetch();
            const children = all.filter((c) => c && c.parentId === templateVC.parentId);
            for (const ch of children.values()) {
              if (!VC_NAME_RE.test(ch.name)) continue;
              try {
                await ch.delete('AZHEN startup cleanup');
                deletedVcs++;
              } catch (e) {
                console.error(`startup: could not delete channel ${ch.name}:`, e.message);
              }
            }
          }
        }
      } catch (e) {
        await reportError(client, 'startup: orphan VC cleanup', e);
      }

      try {
        const roles = await guild.roles.fetch();
        for (const role of roles.values()) {
          if (!ROLE_NAME_RE.test(role.name)) continue;
          try {
            await role.delete('AZHEN startup cleanup');
            deletedRoles++;
          } catch (e) {
            console.error(`startup: could not delete role ${role.name}:`, e.message);
          }
        }
      } catch (e) {
        await reportError(client, 'startup: orphan role cleanup', e);
      }
    } catch (e) {
      await reportError(client, 'startup: fetch guild', e);
    }

    // 5. Audit
    await audit(
      client,
      `🧹 [STARTUP] AZHEN online. Cleared ${cleared} active_matches. Deleted ${deletedVcs} orphaned VCs and ${deletedRoles} orphaned match roles.`
    );
  },
};
