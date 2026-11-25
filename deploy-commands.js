require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
  console.error('DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID are required.');
  process.exit(1);
}

const commandsDir = path.join(__dirname, 'commands');
const body = fs
  .readdirSync(commandsDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => require(path.join(commandsDir, f)).data.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body });
    console.log(`Registered ${body.length} guild commands.`);
  } catch (e) {
    console.error('Command registration failed:', e);
    process.exit(1);
  }
})();
