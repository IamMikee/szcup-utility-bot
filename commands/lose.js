const { SlashCommandBuilder } = require('discord.js');
const { admin, db } = require('../lib/firebase');
const { requireAdmin } = require('../lib/guards');
const { audit, reportError } = require('../lib/audit');

const STAGE_LABELS = {
  q: 'qualifiers',
  qf: 'quarterfinals',
  sf: 'semifinals',
  completed: 'the finals',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lose')
    .setDescription('Mark a team as eliminated (admin)')
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

      const ref = db.collection('brackets').doc(ticketCode);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const b = snap.exists
          ? snap.data()
          : { ticketCode, currentStage: 'q', eliminated: false, history: [] };

        const currentStage = b.currentStage || 'q';
        const now = admin.firestore.Timestamp.now();
        const wasEliminated = Boolean(b.eliminated);

        const history = [
          ...(b.history || []),
          { matchId: null, result: 'lose', stage: currentStage, timestamp: now },
        ];

        tx.set(ref, {
          ticketCode,
          currentStage,
          eliminated: true,
          updatedAt: now,
          history,
        });

        return { stage: currentStage, wasEliminated };
      });

      const label = STAGE_LABELS[result.stage] || result.stage;
      const content = result.wasEliminated
        ? `🪦 ${ticketCode} recorded a loss at ${label} (already eliminated).`
        : `🪦 ${ticketCode} has been eliminated at ${label}.`;
      await interaction.reply({ content });

      // Announce only on the *first* elimination
      if (!result.wasEliminated) {
        const ch = await client.channels.fetch(process.env.ANNOUNCEMENT_CHANNEL_ID).catch(() => null);
        if (ch?.isTextBased()) {
          await ch.send(`💀 ${ticketCode} has been eliminated.`).catch((e) => console.error(e));
        }
      }

      const auditMsg = result.wasEliminated
        ? `🪦 [LOSE] <@${adminId}> recorded loss for ${ticketCode} at ${result.stage} (already eliminated).`
        : `🪦 [LOSE] <@${adminId}> marked ${ticketCode} as eliminated at ${result.stage}.`;
      await audit(client, auditMsg);
    } catch (e) {
      await reportError(client, `lose (${ticketCode})`, e);
      if (interaction.replied || interaction.deferred) return;
      await interaction
        .reply({ content: 'Something went wrong. Check the audit channel.' })
        .catch(() => { });
    }
  },
};