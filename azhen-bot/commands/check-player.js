const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../lib/firebase');
const colors = require('../config/colors');
const { getFormResponseData, getGameFromForm } = require('../lib/form');
const { reportError } = require('../lib/audit');
const { formatHistorySummary } = require('../lib/brackets');

const STAGE_RANK = { q: 0, qf: 1, sf: 2, completed: 3 };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check-player')
    .setDescription('Show verification and bracket info for a player')
    .addUserOption((o) => o.setName('user').setDescription('Discord user').setRequired(true)),

  async execute(interaction) {
    const user = interaction.options.getUser('user', true);
    await interaction.deferReply();

    try {
      const verSnap = await db
        .collection('verifications')
        .where('discordId', '==', user.id)
        .get();

      if (verSnap.empty) {
        return interaction.editReply({
          content: `<@${user.id}> is not verified for any ticket.`,
          allowedMentions: { parse: [] },
        });
      }

      const fields = [];
      let bestStage = null;
      let bestSummary = 'no matches yet';
      let bestElim = '';

      for (const doc of verSnap.docs.slice(0, 25)) {
        const v = doc.data();
        const [ticketSnap, bracketSnap] = await Promise.all([
          db.collection('tickets').doc(v.ticketCode).get(),
          db.collection('brackets').doc(v.ticketCode).get(),
        ]);

        const b = bracketSnap.exists ? bracketSnap.data() : {};
        const summary = formatHistorySummary(b.history);
        const stageLabel = b.currentStage || 'q';
        const elim = b.eliminated ? ' *(eliminated)*' : '';

        let game = 'Unknown';
        if (ticketSnap.exists) {
          const formData = await getFormResponseData(ticketSnap.data());
          game = getGameFromForm(formData) || 'Unknown';
        }

        fields.push({
          name: `Ticket ${v.ticketCode}`,
          value: [`**Name:** ${v.playerName}`, `**Game:** ${game}`]
            .join('\n')
            .slice(0, 1024),
        });

        // Track the most-progressed ticket for the outer summary field
        const rank = STAGE_RANK[stageLabel] ?? 0;
        if (bestStage === null || rank > (STAGE_RANK[bestStage] ?? 0)) {
          bestStage = stageLabel;
          bestSummary = summary;
          bestElim = elim;
        }
      }

      const embed = new EmbedBuilder()
        .setColor(colors.INFO)
        .setTitle('Player Info')
        .setDescription(`<@${user.id}>`)
        .addFields(fields)
        .addFields({
          name: 'Best Progress',
          value: `Stage: **${bestStage}**${bestElim}\nRecord: \`${bestSummary}\``,
        });

      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (e) {
      await reportError(interaction.client, `check-player (${user.id})`, e);
      await interaction
        .editReply({ content: 'Something went wrong. Check the audit channel.' })
        .catch(() => { });
    }
  },
};