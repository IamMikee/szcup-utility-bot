const { MessageFlags } = require('discord.js');

const NO_PERMISSION = 'You do not have permission to use this command.';

function isAdmin(interaction) {
  return Boolean(interaction.member?.roles?.cache?.has(process.env.ADMIN_ROLE_ID));
}

// Replies with the permission error and returns false when the user is not an admin.
// Errors are ephemeral only when the command itself is ephemeral.
async function requireAdmin(interaction, { ephemeral = false } = {}) {
  if (isAdmin(interaction)) return true;
  await interaction.reply({
    content: NO_PERMISSION,
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
  return false;
}

module.exports = { isAdmin, requireAdmin, NO_PERMISSION };
