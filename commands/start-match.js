const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const { admin, db } = require('../lib/firebase');
const colors = require('../config/colors');
const { requireAdmin } = require('../lib/guards');
const { audit, reportError } = require('../lib/audit');
const { newMatchId, vcName: buildVcName, matchRoleName: buildRoleName } = require('../lib/match');
const { findTicketRole } = require('../lib/roles');

const COLLECTOR_TIME = 180_000;
const ID_RE = /\d{17,20}/g;

function parseIds(text) {
  return [...new Set(String(text || '').match(ID_RE) || [])];
}

function buildEmbed(teamA, teamB, rosterA, rosterB) {
  const fmt = (s) => (s.size ? [...s].map((id) => `<@${id}>`).join('\n') : '*(no players)*');
  const warn = (rosterA.size === 0 || rosterB.size === 0)
    ? '\n⚠️ One team has no players — add players via Modify before confirming.'
    : '';
  return new EmbedBuilder()
    .setColor(warn ? colors.WARNING : colors.INFO)
    .setTitle(`Match Setup: ${teamA} vs ${teamB}`)
    .setDescription(warn || null)
    .addFields(
      { name: `Team A — ${teamA} (${rosterA.size})`, value: fmt(rosterA), inline: true },
      { name: `Team B — ${teamB} (${rosterB.size})`, value: fmt(rosterB), inline: true }
    );
}

function buildRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('start-match:confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('start-match:modify').setLabel('Modify').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('start-match:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
}

function mentions(ids) {
  return ids.length ? ids.map((id) => `<@${id}>`).join(', ') : 'none';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('start-match')
    .setDescription('Set up and start a PvP match between two teams (admin)')
    .addStringOption((o) =>
      o.setName('team_a_code').setDescription('Team A ticket code').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('team_b_code').setDescription('Team B ticket code').setRequired(true)
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const client = interaction.client;
    const guild = interaction.guild;
    const adminId = interaction.user.id;
    const teamA = interaction.options.getString('team_a_code', true).trim().toUpperCase();
    const teamB = interaction.options.getString('team_b_code', true).trim().toUpperCase();

    if (teamA === teamB) {
      return interaction.reply({ content: 'Team A and Team B must be different tickets.' });
    }

    // ---- Preconditions ----
    await guild.roles.fetch();
    const ticketRoleA = await findTicketRole(guild, teamA);
    const ticketRoleB = await findTicketRole(guild, teamB);
    if (!ticketRoleA) {
      return interaction.reply({ content: `No players verified for ticket ${teamA} yet.` });
    }
    if (!ticketRoleB) {
      return interaction.reply({ content: `No players verified for ticket ${teamB} yet.` });
    }

    let templateVcId;
    try {
      const cfg = await db.collection('config').doc('match_settings').get();
      templateVcId = cfg.exists ? cfg.data().vcId : null;
    } catch (e) {
      await reportError(client, 'start-match: read config', e);
      return interaction.reply({ content: 'Failed to read match settings. Check the audit channel.' });
    }
    if (!templateVcId) {
      return interaction.reply({
        content: 'Match VC not configured. Run /set-match-vc-channel first.',
      });
    }

    // ---- Both teams must be free ----
    try {
      const [activeA, activeB] = await Promise.all([
        db.collection('active_matches').where('ticketCodes', 'array-contains', teamA).where('status', '==', 'active').limit(1).get(),
        db.collection('active_matches').where('ticketCodes', 'array-contains', teamB).where('status', '==', 'active').limit(1).get(),
      ]);
      if (!activeA.empty) {
        return interaction.reply({ content: `Ticket ${teamA} is already in an active match. Run /finish-match <vc> first.` });
      }
      if (!activeB.empty) {
        return interaction.reply({ content: `Ticket ${teamB} is already in an active match. Run /finish-match <vc> first.` });
      }
    } catch (e) {
      await reportError(client, 'start-match: check active matches', e);
      return interaction.reply({ content: 'Failed to check active matches. Check the audit channel.' });
    }

    await audit(client, `🎮 [START-MATCH] Invoked by <@${adminId}>: ${teamA} vs ${teamB}`);

    // ---- Initial rosters ----
    await guild.members.fetch();
    const rosterA = new Set(ticketRoleA.members.map((m) => m.id));
    const rosterB = new Set(ticketRoleB.members.map((m) => m.id));

    await interaction.reply({ embeds: [buildEmbed(teamA, teamB, rosterA, rosterB)], components: [buildRow()] });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      time: COLLECTOR_TIME,
      filter: (i) => i.user.id === adminId,
    });

    // ---- Confirm ----
    async function createMatch() {
      const matchId = newMatchId();
      const roleName = buildRoleName(teamA, teamB, matchId);
      const channelName = buildVcName(teamA, teamB, matchId);
      const playersA = [...rosterA];
      const playersB = [...rosterB];
      const allPlayers = [...new Set([...playersA, ...playersB])];
      let matchRole = null;
      let vc = null;

      try {
        const templateVC = await guild.channels.fetch(templateVcId).catch(() => null);
        if (!templateVC) throw new Error('Template VC not found. Re-run /set-match-vc-channel.');

        matchRole = await guild.roles.create({ name: roleName, reason: `AZHEN match ${matchId}` });

        const overwrites = templateVC.permissionOverwrites.cache.map((o) => ({
          id: o.id, type: o.type, allow: o.allow, deny: o.deny,
        }));
        overwrites.push({
          id: matchRole.id,
          allow: [
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
            PermissionFlagsBits.Stream,
            PermissionFlagsBits.ViewChannel,
          ],
        });

        vc = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildVoice,
          parent: templateVC.parentId,
          permissionOverwrites: overwrites,
          reason: `AZHEN match ${matchId}`,
        });

        for (const id of allPlayers) {
          try {
            const m = await guild.members.fetch(id);
            await m.roles.add(matchRole);
          } catch (e) {
            console.error(`start-match: could not assign match role to ${id}:`, e.message);
          }
        }

        await db.collection('active_matches').doc(matchId).set({
          matchId,
          ticketCodes: [teamA, teamB],
          teams: {
            a: { code: teamA, players: playersA },
            b: { code: teamB, players: playersB },
          },
          players: allPlayers,
          vcId: vc.id,
          matchRoleId: matchRole.id,
          startedAt: admin.firestore.Timestamp.now(),
          startedBy: adminId,
          status: 'active',
        });

        await interaction.editReply({
          content: `✅ Match started: **${teamA}** vs **${teamB}** — VC: <#${vc.id}>`,
          embeds: [],
          components: [],
        });

        await audit(
          client,
          [
            '✅ [START-MATCH] Confirmed',
            `• Admin: <@${adminId}>`,
            `• Team A: ${teamA} (${playersA.length}): ${mentions(playersA)}`,
            `• Team B: ${teamB} (${playersB.length}): ${mentions(playersB)}`,
            `• MatchID: ${matchId}`,
            `• VC: <#${vc.id}> (${channelName})`,
            `• Role: <@&${matchRole.id}>`,
          ].join('\n')
        );
      } catch (e) {
        if (vc) await vc.delete('AZHEN rollback').catch(() => { });
        if (matchRole) await matchRole.delete('AZHEN rollback').catch(() => { });
        await reportError(client, `start-match: create match (${teamA} vs ${teamB})`, e);
        await interaction
          .editReply({
            content: 'Failed to start the match. Nothing was left behind; check the audit channel.',
            embeds: [],
            components: [],
          })
          .catch(() => { });
      }
    }

    // ---- Modify: 4 fields (add/remove per team) ----
    async function handleModify(i) {
      const modalId = `start-match:modal:${i.id}`;
      const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle('Modify Rosters')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('add_a')
              .setLabel(`Add to Team A (${teamA}) — mentions/IDs`)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('remove_a')
              .setLabel(`Remove from Team A (${teamA}) — mentions/IDs`)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('add_b')
              .setLabel(`Add to Team B (${teamB}) — mentions/IDs`)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('remove_b')
              .setLabel(`Remove from Team B (${teamB}) — mentions/IDs`)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          )
        );

      await i.showModal(modal);
      collector.resetTimer();

      const submit = await i
        .awaitModalSubmit({ time: COLLECTOR_TIME, filter: (m) => m.customId === modalId && m.user.id === adminId })
        .catch(() => null);
      if (!submit) return;
      if (collector.ended) {
        await submit.deferUpdate().catch(() => { });
        return;
      }

      const addedA = [], removedA = [], addedB = [], removedB = [];

      const addTo = async (text, roster, ticketRole, addedArr) => {
        for (const id of parseIds(text)) {
          if (roster.has(id)) continue;
          const m = await guild.members.fetch(id).catch(() => null);
          if (!m) continue;
          try {
            if (!m.roles.cache.has(ticketRole.id)) await m.roles.add(ticketRole);
          } catch (e) {
            console.error(`start-match: could not add ticket role to ${id}:`, e.message);
          }
          roster.add(id);
          addedArr.push(id);
        }
      };
      const removeFrom = (text, roster, removedArr) => {
        for (const id of parseIds(text)) {
          if (roster.delete(id)) removedArr.push(id);
        }
      };

      await addTo(submit.fields.getTextInputValue('add_a'), rosterA, ticketRoleA, addedA);
      removeFrom(submit.fields.getTextInputValue('remove_a'), rosterA, removedA);
      await addTo(submit.fields.getTextInputValue('add_b'), rosterB, ticketRoleB, addedB);
      removeFrom(submit.fields.getTextInputValue('remove_b'), rosterB, removedB);

      await submit.update({ embeds: [buildEmbed(teamA, teamB, rosterA, rosterB)], components: [buildRow()] });
      collector.resetTimer();

      await audit(
        client,
        [
          `✏️ [START-MATCH] Rosters modified by <@${adminId}> for ${teamA} vs ${teamB}`,
          `• Team A (+${addedA.length}/-${removedA.length}): added ${mentions(addedA)} | removed ${mentions(removedA)}`,
          `• Team B (+${addedB.length}/-${removedB.length}): added ${mentions(addedB)} | removed ${mentions(removedB)}`,
        ].join('\n')
      );
    }

    collector.on('collect', async (i) => {
      try {
        if (i.customId === 'start-match:modify') {
          await handleModify(i);
        } else if (i.customId === 'start-match:confirm') {
          collector.stop('confirmed');
          await i.deferUpdate();
          await createMatch();
        } else if (i.customId === 'start-match:cancel') {
          collector.stop('cancelled');
          await i.update({ content: '❌ Match setup cancelled.', embeds: [], components: [] });
          await audit(client, `❌ [START-MATCH] Cancelled by <@${adminId}> for ${teamA} vs ${teamB}`);
        }
      } catch (e) {
        await reportError(client, `start-match: handle ${i.customId}`, e);
      }
    });

    collector.on('end', async (_c, reason) => {
      if (reason !== 'time') return;
      try {
        await interaction.editReply({
          content: '⏱️ Match setup timed out. Run /start-match again to resume.',
          embeds: [],
          components: [],
        });
        await audit(client, `⏱️ [START-MATCH] Timed out for ${teamA} vs ${teamB} (admin <@${adminId}>)`);
      } catch (e) {
        console.error('start-match: timeout handling failed:', e);
      }
    });
  },
};