const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { db } = require('../lib/firebase');
const colors = require('../config/colors');
const { requireAdmin } = require('../lib/guards');
const { reportError } = require('../lib/audit');
const { getFormResponseData, getGameFromForm } = require('../lib/form');
const { parseTicketRoleName } = require('../lib/roles');

const PAGE_SIZE = 10;
const COLLECTOR_TIME = 180_000;
const TEAM_W = 24;
const CODE_W = 8;
const GAME_W = 16;

const fit = (text, width) => {
  const t = String(text).replace(/`/g, "'");
  return (t.length > width ? `${t.slice(0, width - 1)}…` : t).padEnd(width);
};

// One monospace table per page: team name | ticket code | game.
function buildPage(entries, page) {
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const slice = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = slice.map(
    (e) => `${fit(e.teamName || '(no team name)', TEAM_W)}  ${fit(e.ticketCode, CODE_W)}  ${fit(e.game, GAME_W)}`
  );
  const header = `${fit('TEAM', TEAM_W)}  ${fit('TICKET', CODE_W)}  ${fit('GAME', GAME_W)}`;
  const rule = '─'.repeat(TEAM_W + CODE_W + GAME_W + 4);
  return new EmbedBuilder()
    .setColor(colors.INFO)
    .setTitle('Registered Teams')
    .setDescription(`\`\`\`\n${header}\n${rule}\n${rows.join('\n')}\n\`\`\``)
    .setFooter({ text: `Page ${page + 1} of ${pages} • ${entries.length} team${entries.length === 1 ? '' : 's'}` });
}

function buildRow(page, pages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('view-teams-list:prev')
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId('view-teams-list:next')
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= pages - 1)
  );
}

module.exports = {
  buildPage,
  data: new SlashCommandBuilder()
    .setName('view-teams-list')
    .setDescription('List every team with its ticket code and game (admin)'),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;
    await interaction.deferReply();

    const client = interaction.client;
    const adminId = interaction.user.id;

    try {
      // Candidate team roles come from role names; Firestore confirms the code is a real ticket
      // (so e.g. a role named "Verified" is not mistaken for a ticket code).
      const roles = await interaction.guild.roles.fetch();
      const candidates = new Map(); // ticketCode -> teamName
      for (const role of roles.values()) {
        const parsed = parseTicketRoleName(role.name);
        if (!parsed) continue;
        const existing = candidates.get(parsed.ticketCode);
        // Prefer the "TEAM-CODE" role over a bare-code role for the same ticket.
        if (!existing || (!existing.teamName && parsed.teamName)) candidates.set(parsed.ticketCode, parsed);
      }

      const codes = [...candidates.keys()];
      const entries = [];
      if (codes.length) {
        const snaps = await db.getAll(...codes.map((c) => db.collection('tickets').doc(c)));
        const found = snaps.filter((s) => s.exists);
        const games = await Promise.all(
          found.map(async (s) => {
            try {
              return getGameFromForm(await getFormResponseData(s.data()));
            } catch (e) {
              console.error(`view-teams-list: form lookup failed for ${s.id}:`, e.message);
              return null;
            }
          })
        );
        found.forEach((s, i) =>
          entries.push({
            ticketCode: s.id,
            teamName: candidates.get(s.id).teamName,
            game: games[i] || 'Unknown',
          })
        );
      }

      entries.sort(
        (a, b) =>
          a.game.localeCompare(b.game) ||
          (a.teamName || '').localeCompare(b.teamName || '') ||
          a.ticketCode.localeCompare(b.ticketCode)
      );

      if (!entries.length) {
        return interaction.editReply({ content: 'No verified teams yet.' });
      }

      const pages = Math.ceil(entries.length / PAGE_SIZE);
      let page = 0;

      if (pages === 1) {
        return interaction.editReply({ embeds: [buildPage(entries, 0)] });
      }

      const message = await interaction.editReply({
        embeds: [buildPage(entries, page)],
        components: [buildRow(page, pages)],
      });

      const collector = message.createMessageComponentCollector({
        time: COLLECTOR_TIME,
        filter: (i) => i.user.id === adminId,
      });

      collector.on('collect', async (i) => {
        try {
          if (i.customId === 'view-teams-list:prev') page = Math.max(0, page - 1);
          else if (i.customId === 'view-teams-list:next') page = Math.min(pages - 1, page + 1);
          else return;
          collector.resetTimer();
          await i.update({ embeds: [buildPage(entries, page)], components: [buildRow(page, pages)] });
        } catch (e) {
          await reportError(client, 'view-teams-list: paginate', e);
        }
      });

      // Keep the list visible when the buttons expire; just remove them.
      collector.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => {});
      });
    } catch (e) {
      await reportError(client, 'view-teams-list', e);
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply({ content: 'Something went wrong. Check the audit channel.' })
          .catch(() => {});
      }
    }
  },
};
