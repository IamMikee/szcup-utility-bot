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
const { getFormResponseData, getGameFromForm } = require('../lib/form');

const COLLECTOR_TIME = 180_000;
const ID_RE = /\d{17,20}/g;

// Gamemode registry — env keys resolved at execute time
const GAMEMODE_OPTIONS = [
  { key: 'mobile_legends', label: 'Mobile Legends', envKey: 'ML_CATEGORY_ID', keyword: 'mobile legends' },
  { key: 'clash_royale', label: 'Clash Royale', envKey: 'CR_CATEGORY_ID', keyword: 'clash royale' },
];

function resolveGamemode(key) {
  const option = GAMEMODE_OPTIONS.find((g) => g.key === key);
  if (!option) return null;
  const categoryId = process.env[option.envKey];
  return { ...option, categoryId: categoryId || null };
}

function parseIds(text) {
  return [...new Set(String(text || '').match(ID_RE) || [])];
}

async function gameForTicket(ticketCode) {
  const snap = await db.collection('tickets').doc(ticketCode).get();
  if (!snap.exists) return null;
  const form = await getFormResponseData(snap.data());
  return getGameFromForm(form);
}

function buildEmbed(gamemodeLabel, teamA, teamB, rosterA, rosterB) {
  const fmt = (s) => (s.size ? [...s].map((id) => `<@${id}>`).join('\n') : '*(no players)*');
  const warn = (rosterA.size === 0 || rosterB.size === 0)
    ? '\n⚠️ One team has no players — add players via Modify before confirming.'
    : '';
  return new EmbedBuilder()
    .setColor(warn ? colors.WARNING : colors.INFO)
    .setTitle(`Match Setup: ${teamA} vs ${teamB} — ${gamemodeLabel}`)
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
    )
    .addStringOption((o) =>
      o
        .setName('gamemode')
        .setDescription('Game mode (determines voice channel category)')
        .setRequired(true)
        .addChoices(
          { name: 'Mobile Legends', value: 'mobile_legends' },
          { name: 'Clash Royale', value: 'clash_royale' }
        )
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const client = interaction.client;
    const guild = interaction.guild;
    const adminId = interaction.user.id;
    const teamA = interaction.options.getString('team_a_code', true).trim().toUpperCase();
    const teamB = interaction.options.getString('team_b_code', true).trim().toUpperCase();
    const gamemodeKey = interaction.options.getString('gamemode', true);
    const gamemode = resolveGamemode(gamemodeKey);

    if (teamA === teamB) {
      return interaction.reply({ content: 'Team A and Team B must be different tickets.' });
    }
    if (!gamemode) {
      return interaction.reply({ content: 'Invalid gamemode.' });
    }
    if (!gamemode.categoryId) {
      return interaction.reply({
        content: `${gamemode.label} category not configured. Missing \`${gamemode.envKey}\` in \`.env\`.`,
      });
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

    // Validate category exists and is actually a category
    const category = await guild.channels.fetch(gamemode.categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return interaction.reply({
        content: `${gamemode.label} category (${gamemode.categoryId}) not found or not a category.`,
      });
    }

    // ---- Soft guard: team's registered game should match selected gamemode ----
    const [gameA, gameB] = await Promise.all([gameForTicket(teamA), gameForTicket(teamB)]);
    const norm = (s) => String(s || '').toLowerCase().trim();
    const matchesMode = (g) => !g || norm(g).includes(gamemode.keyword); // unknown game = soft pass
    if (!matchesMode(gameA)) {
      return interaction.reply({
        content: `Team ${teamA} is registered for "${gameA}", not ${gamemode.label}. Double-check the ticket codes.`,
      });
    }
    if (!matchesMode(gameB)) {
      return interaction.reply({
        content: `Team ${teamB} is registered for "${gameB}", not ${gamemode.label}. Double-check the ticket codes.`,
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

    await audit(
      client,
      `🎮 [START-MATCH] Invoked by <@${adminId}>: ${teamA} vs ${teamB} (${gamemode.label})`
    );

    // ---- Initial rosters ----
    await guild.members.fetch();
    const rosterA = new Set(ticketRoleA.members.map((m) => m.id));
    const rosterB = new Set(ticketRoleB.members.map((m) => m.id));

    await interaction.reply({
      embeds: [buildEmbed(gamemode.label, teamA, teamB, rosterA, rosterB)],
      components: [buildRow()],
    });
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
        matchRole = await guild.roles.create({ name: roleName, reason: `AZHEN match ${matchId}` });

        // Channel inherits category permissions; we only add the matchRole overwrite.
        vc = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildVoice,
          parent: gamemode.categoryId,
          permissionOverwrites: [
            {
              id: matchRole.id,
              allow: [
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
                PermissionFlagsBits.Stream,
                PermissionFlagsBits.ViewChannel,
              ],
            },
          ],
          reason: `AZHEN match ${matchId} (${gamemode.label})`,
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
          gamemode: gamemode.key,
          gamemodeLabel: gamemode.label,
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
          content: `✅ Match started: **${teamA}** vs **${teamB}** (${gamemode.label}) — VC: <#${vc.id}>`,
          embeds: [],
          components: [],
        });

        await audit(
          client,
          [
            '✅ [START-MATCH] Confirmed',
            `• Admin: <@${adminId}>`,
            `• Gamemode: ${gamemode.label}`,
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

      await submit.update({
        embeds: [buildEmbed(gamemode.label, teamA, teamB, rosterA, rosterB)],
        components: [buildRow()],
      });
      collector.resetTimer();

      await audit(
        client,
        [
          `✏️ [START-MATCH] Rosters modified by <@${adminId}> for ${teamA} vs ${teamB} (${gamemode.label})`,
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
          await audit(client, `❌ [START-MATCH] Cancelled by <@${adminId}> for ${teamA} vs ${teamB} (${gamemode.label})`);
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
        await audit(client, `⏱️ [START-MATCH] Timed out for ${teamA} vs ${teamB} (${gamemode.label}, admin <@${adminId}>)`);
      } catch (e) {
        console.error('start-match: timeout handling failed:', e);
      }
    });
  },
};