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
    .setName('win')
    .setDescription('Record a win for a team at its current stage (admin)')
    .addStringOption((o) =>
      o.setName('ticket_code').setDescription('Team ticket code').setRequired(true)
    )
    .addBooleanOption((o) =>
      o
        .setName('promote-to-qf')
        .setDescription('Promote from qualifiers (q) to quarterfinals (qf). Only applies at stage q.')
        .setRequired(false)
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const client = interaction.client;
    const adminId = interaction.user.id;
    const ticketCode = interaction.options.getString('ticket_code', true).trim().toUpperCase();
    const promoteFlag = interaction.options.getBoolean('promote-to-qf') ?? false;

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

        if (currentStage === 'completed') {
          return { error: 'Team is already at the final stage.' };
        }

        const history = [
          ...(b.history || []),
          { matchId: null, result: 'win', stage: currentStage, timestamp: now },
        ];

        let toStage = currentStage;
        let promoted = false;
        let promoteIgnored = false;

        if (currentStage === 'q') {
          if (promoteFlag) {
            toStage = 'qf';
            promoted = true;
          }
        } else if (currentStage === 'qf') {
          toStage = 'sf';
          if (promoteFlag) promoteIgnored = true;
        } else if (currentStage === 'sf') {
          toStage = 'completed';
          if (promoteFlag) promoteIgnored = true;
        }

        tx.set(ref, {
          ticketCode,
          currentStage: toStage,
          eliminated: Boolean(b.eliminated),
          updatedAt: now,
          history,
        });

        return { fromStage: currentStage, toStage, promoted, promoteIgnored };
      });

      if (result.error) return interaction.reply({ content: result.error });

      const fromLabel = STAGE_LABELS[result.fromStage] || result.fromStage;
      const toLabel = STAGE_LABELS[result.toStage] || result.toStage;
      let content;
      if (result.promoted) {
        content = `🏆 ${ticketCode} recorded a qualifying win and was promoted to quarterfinals.`;
      } else if (result.fromStage === 'q') {
        content = `🏆 ${ticketCode} recorded a qualifying win.`;
      } else if (result.fromStage === result.toStage) {
        content = `🏆 ${ticketCode} recorded a win at ${fromLabel}.`;
      } else {
        content = `🏆 ${ticketCode} won at ${fromLabel} and advances to ${toLabel}.`;
      }
      await interaction.reply({ content });

      // Announce only when reaching semifinals or beyond
      if (result.toStage === 'sf' || result.toStage === 'completed') {
        const ch = await client.channels.fetch(process.env.ANNOUNCEMENT_CHANNEL_ID).catch(() => null);
        if (ch?.isTextBased()) {
          const announceLabel = result.toStage === 'sf' ? 'semifinals' : 'the finals';
          await ch
            .send(`🎉 ${ticketCode} advances to ${announceLabel}!`)
            .catch((e) => console.error(e));
        }
      }

      let auditMsg;
      if (result.promoted) {
        auditMsg = `🏆 [WIN] <@${adminId}> recorded qualifying win for ${ticketCode} and promoted to qf.`;
      } else if (result.fromStage === 'q') {
        auditMsg = `🏆 [WIN] <@${adminId}> recorded qualifying win for ${ticketCode} (remains in q).`;
      } else if (result.fromStage === result.toStage) {
        auditMsg = `🏆 [WIN] <@${adminId}> recorded win for ${ticketCode} at ${result.fromStage}.`;
      } else {
        auditMsg = `🏆 [WIN] <@${adminId}> marked ${ticketCode} as winner at ${result.fromStage} → ${result.toStage}.`;
      }
      if (result.promoteIgnored) {
        auditMsg += ` (promote-to-qf ignored: already at ${result.fromStage})`;
      }
      await audit(client, auditMsg);
    } catch (e) {
      await reportError(client, `win (${ticketCode})`, e);
      if (interaction.replied || interaction.deferred) return;
      await interaction
        .reply({ content: 'Something went wrong. Check the audit channel.' })
        .catch(() => { });
    }
  },
};