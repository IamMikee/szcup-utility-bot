const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../lib/firebase');
const colors = require('../config/colors');
const { normalizeName } = require('../lib/names');
const {
  getFormResponseData,
  getPlayerNamesFromForm,
  getGameFromForm,
} = require('../lib/form');
const { reportError } = require('../lib/audit');
const { formatHistorySummary } = require('../lib/brackets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check-ticket')
    .setDescription('Show the status of a team ticket')
    .addStringOption((o) =>
      o.setName('ticket_code').setDescription('Team ticket code').setRequired(true)
    ),

  async execute(interaction) {
    const ticketCode = interaction.options.getString('ticket_code', true).trim().toUpperCase();
    await interaction.deferReply();

    try {
      const ticketSnap = await db.collection('tickets').doc(ticketCode).get();
      if (!ticketSnap.exists) {
        return interaction.editReply({ content: 'Invalid ticket code.' });
      }
      const ticket = ticketSnap.data();

      const [formData, verSnap, bracketSnap] = await Promise.all([
        getFormResponseData(ticket),
        db.collection('verifications').where('ticketCode', '==', ticketCode).get(),
        db.collection('brackets').doc(ticketCode).get(),
      ]);

      const b = bracketSnap?.data() || {};
      const summary = formatHistorySummary(b.history);
      const stageLabel = b.currentStage || 'q';
      const elim = b.eliminated ? ' *(eliminated)*' : '';

      const game = getGameFromForm(formData) || 'Unknown';

      let bracket = 'unplayed';
      if (bracketSnap.exists) {
        const b = bracketSnap.data();
        bracket = b.currentStage || 'unplayed';
        if (b.eliminated) bracket += ' (eliminated)';
      }

      const claimed = new Map();
      verSnap.docs.forEach((d) => claimed.set(d.data().playerNameNormalized, d.data().discordId));

      const names = new Map();
      const { names: formNames } = getPlayerNamesFromForm(formData);
      for (const n of [...formNames, ticket.name].filter(Boolean)) {
        const key = normalizeName(n);
        if (!names.has(key)) names.set(key, String(n).trim());
      }

      const lines = [...names.entries()].map(([key, name]) =>
        claimed.has(key) ? `${name} — ✅ <@${claimed.get(key)}>` : `${name} — ⬜ unverified`
      );

      const embed = new EmbedBuilder()
        .setColor(colors.INFO)
        .setTitle('Ticket Status')
        .addFields(
          { name: 'Ticket', value: ticketCode, inline: true },
          { name: 'Game', value: game, inline: true },
          {
            name: 'Bracket',
            value: `Stage: **${stageLabel}**${elim}\nRecord: \`${summary}\``,
            inline: true,
          },
          { name: 'Players', value: lines.join('\n').slice(0, 1024) || 'No players found' }
        )

      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      await reportError(interaction.client, `check-ticket (${ticketCode})`, e);
      await interaction.editReply({ content: 'Something went wrong. Check the audit channel.' }).catch(() => { });
    }
  },
};