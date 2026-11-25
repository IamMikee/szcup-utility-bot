const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { admin, db } = require('../lib/firebase');
const { requireAdmin } = require('../lib/guards');
const { audit, reportError } = require('../lib/audit');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-match-vc-channel')
    .setDescription('Set the template voice channel used for match VCs (admin)')
    .addChannelOption((o) =>
      o
        .setName('vc')
        .setDescription('Template voice channel')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction, { ephemeral: true }))) return;
    const vc = interaction.options.getChannel('vc', true);

    try {
      await db.collection('config').doc('match_settings').set(
        {
          vcId: vc.id,
          updatedAt: admin.firestore.Timestamp.now(),
          updatedBy: interaction.user.id,
        },
        { merge: true }
      );
    } catch (e) {
      await reportError(interaction.client, 'set-match-vc-channel: write config', e);
      return interaction.reply({
        content: 'Failed to save the setting. Check the audit channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({
      content: `Match template VC set to <#${vc.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    await audit(
      interaction.client,
      `⚙️ [VC-CONFIG] <@${interaction.user.id}> set match template VC to <#${vc.id}> (${vc.name})`
    );
  },
};
