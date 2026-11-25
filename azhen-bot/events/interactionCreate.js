const { Events, MessageFlags } = require('discord.js');
const { reportError } = require('../lib/audit');

// Buttons and modals created by a command use the "<command>:<action>" customId
// convention. Today they are all handled by collectors inside the command itself;
// a command may additionally export handleButton / handleModal to be routed here.
function findCommandByPrefix(client, customId) {
  return client.commands.get(customId.split(':')[0]);
}

module.exports = {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    const client = interaction.client;

    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;
        await command.execute(interaction);
      } else if (interaction.isButton()) {
        const command = findCommandByPrefix(client, interaction.customId);
        if (command?.handleButton) await command.handleButton(interaction);
      } else if (interaction.isModalSubmit()) {
        const command = findCommandByPrefix(client, interaction.customId);
        if (command?.handleModal) await command.handleModal(interaction);
      }
    } catch (e) {
      await reportError(client, `interactionCreate (${interaction.commandName || interaction.customId})`, e);
      const payload = { content: 'Something went wrong. Please contact an admin.' };
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        } else if (interaction.isRepliable()) {
          await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        }
      } catch (_) {
        /* interaction already expired */
      }
    }
  },
};
