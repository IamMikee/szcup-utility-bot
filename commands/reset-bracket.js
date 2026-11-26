const { SlashCommandBuilder } = require('discord.js');
const { db } = require('../lib/firebase');
const { requireAdmin } = require('../lib/guards');
const { audit, reportError } = require('../lib/audit');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reset-bracket')
    .setDescription("Reset a team's bracket back to the start (admin)")
    .addStringOption((o) =>
      o.setName('ticket_code').setDescription('Team ticket code').setRequired(true)
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const client = interaction.client;
    const adminId = interaction.user.id;
    const ticketCode = interaction.options.getString('ticket_code', true).trim().toUpperCase();

    try {
      const ticketSnap = await db.collection('tickets').doc(ticketCode).get();
      if (!ticketSnap.exists) {
        return interaction.reply({ content: 'Invalid ticket code.' });
      }

      // /win and /lose treat a missing brackets doc as "q, not eliminated, no history",
      // so deleting the doc is a full reset.
      const ref = db.collection('brackets').doc(ticketCode);
      const snap = await ref.get();
      if (!snap.exists) {
        return interaction.reply({
          content: `${ticketCode} has no bracket progress to reset.`,
        });
      }

      const b = snap.data();
      const prevStage = b.currentStage || 'q';
      const prevEliminated = Boolean(b.eliminated);
      const prevMatches = Array.isArray(b.history) ? b.history.length : 0;

      await ref.delete();

      await interaction.reply({
        content: `🔄 ${ticketCode} bracket reset. It is back at qualifiers with no match history.`,
      });

      await audit(
        client,
        `🔄 [RESET-BRACKET] <@${adminId}> reset ${ticketCode} | Was: stage ${prevStage}, ` +
          `${prevEliminated ? 'eliminated' : 'not eliminated'}, ${prevMatches} history entr${
            prevMatches === 1 ? 'y' : 'ies'
          }`
      );
    } catch (e) {
      await reportError(client, `reset-bracket (${ticketCode})`, e);
      if (interaction.replied || interaction.deferred) return;
      await interaction
        .reply({ content: 'Something went wrong. Check the audit channel.' })
        .catch(() => {});
    }
  },
};
