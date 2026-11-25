const { Events } = require('discord.js');
const { audit } = require('../lib/audit');

module.exports = {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    if (member.guild.id !== process.env.DISCORD_GUILD_ID) return;

    try {
      await member.roles.set([]);
    } catch (e) {
      // Roles above the bot's own cannot be stripped; ignore.
      console.error(`guildMemberAdd: could not strip roles for ${member.id}:`, e.message);
    }

    await audit(member.client, `🆕 [JOIN] <@${member.id}> joined; roles stripped.`);
  },
};
