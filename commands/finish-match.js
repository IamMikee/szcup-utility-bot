const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const { db } = require('../lib/firebase');
const colors = require('../config/colors');
const { requireAdmin } = require('../lib/guards');
const { audit, reportError } = require('../lib/audit');

const COLLECTOR_TIME = 180_000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('finish-match')
    .setDescription('Finish a match and clean up its VC and role (admin)')
    .addChannelOption((o) =>
      o
        .setName('vc')
        .setDescription('The match voice channel')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const client = interaction.client;
    const guild = interaction.guild;
    const adminId = interaction.user.id;
    const vc = interaction.options.getChannel('vc', true);

    let matchDoc;
    try {
      const snap = await db
        .collection('active_matches')
        .where('vcId', '==', vc.id)
        .where('status', '==', 'active')
        .limit(1)
        .get();
      if (snap.empty) {
        return interaction.reply({ content: 'No active match found for this VC.' });
      }
      matchDoc = snap.docs[0];
    } catch (e) {
      await reportError(client, 'finish-match: lookup', e);
      return interaction.reply({ content: 'Failed to look up the match. Check the audit channel.' });
    }

    const match = matchDoc.data();
    const { matchId, ticketCode } = match;
    const players = Array.isArray(match.players) ? match.players : [];

    await audit(
      client,
      `🏁 [FINISH-MATCH] Invoked by <@${adminId}> for VC <#${vc.id}> (${vc.name}) | MatchID: ${matchId} | Ticket: ${ticketCode}`
    );

    const embed = new EmbedBuilder()
      .setColor(colors.WARNING)
      .setTitle(`Finish Match: ${ticketCode}`)
      .setDescription(
        `End the match in <#${vc.id}>?\nPlayers (${players.length}): ${
          players.map((id) => `<@${id}>`).join(', ') || 'none'
        }`
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('finish-match:confirm')
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('finish-match:cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      time: COLLECTOR_TIME,
      filter: (i) => i.user.id === adminId,
    });

    collector.on('collect', async (i) => {
      try {
        if (i.customId === 'finish-match:cancel') {
          collector.stop('cancelled');
          await i.update({ content: '❌ Finish cancelled.', embeds: [], components: [] });
          await audit(
            client,
            `❌ [FINISH-MATCH] Cancelled by <@${adminId}> for MatchID ${matchId} (ticket ${ticketCode})`
          );
          return;
        }
        if (i.customId !== 'finish-match:confirm') return;

        collector.stop('confirmed');
        await i.deferUpdate();

        await guild.roles.fetch();
        const matchRole = guild.roles.cache.get(match.matchRoleId);

        // 1. Remove match role from all roster players
        const members = [];
        for (const id of players) {
          const m = await guild.members.fetch(id).catch(() => null);
          if (!m) continue;
          members.push(m);
          if (matchRole) {
            try {
              await m.roles.remove(matchRole, 'Match finished');
            } catch (e) {
              console.error(`finish-match: remove role from ${id}:`, e.message);
            }
          }
        }

        // 2. Delete match role
        if (matchRole) await matchRole.delete('Match finished').catch((e) => console.error(e.message));

        // 3. Disconnect roster players from any VC
        const disconnected = [];
        for (const m of members) {
          if (!m.voice?.channelId) continue;
          try {
            await m.voice.disconnect('Match finished');
            disconnected.push(m.id);
          } catch (e) {
            console.error(`finish-match: disconnect ${m.id}:`, e.message);
          }
        }

        // 4. Delete temp VC
        const vcName = vc.name;
        const liveVc = await guild.channels.fetch(vc.id).catch(() => null);
        if (liveVc) await liveVc.delete('Match finished').catch((e) => console.error(e.message));

        // 5. Delete active_matches doc
        try {
          await db.collection('active_matches').doc(matchDoc.id).delete();
        } catch (e) {
          await reportError(client, `finish-match: delete active_matches/${matchId}`, e);
        }

        // 6. Edit message
        await interaction.editReply({
          content: '🏁 Match finished. VC cleaned up.',
          embeds: [],
          components: [],
        });

        // 7. Audit
        await audit(
          client,
          [
            '🔚 [FINISH-MATCH] Ended',
            `• Admin: <@${adminId}>`,
            `• Ticket: ${ticketCode}`,
            `• MatchID: ${matchId}`,
            `• VC: ${vcName} (deleted)`,
            `• Players disconnected (${disconnected.length}): ${
              disconnected.map((id) => `<@${id}>`).join(', ') || 'none'
            }`,
          ].join('\n')
        );
      } catch (e) {
        await reportError(client, `finish-match: handle ${i.customId}`, e);
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (reason !== 'time') return;
      try {
        await interaction.editReply({
          content: '⏱️ Finish request timed out. Run /finish-match again.',
          embeds: [],
          components: [],
        });
      } catch (e) {
        console.error('finish-match: timeout handling failed:', e);
      }
    });
  },
};
