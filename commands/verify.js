const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { admin, db } = require('../lib/firebase');
const colors = require('../config/colors');
const { normalizeName } = require('../lib/names');
const {
  getFormResponseData,
  getPlayerNamesFromForm,
  getGameFromForm,
} = require('../lib/form');
const { getOrCreateRole } = require('../lib/roles');
const { audit, reportError } = require('../lib/audit');

function errorEmbed(message) {
  return new EmbedBuilder().setColor(colors.ERROR).setDescription(message);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify yourself as a registered player')
    .addStringOption((o) =>
      o
        .setName('full_name')
        .setDescription('Your full name exactly as submitted during registration')
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('ticket_code').setDescription('Your team ticket code').setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const client = interaction.client;
    const guild = interaction.guild;
    const member = interaction.member;

    const inputName = interaction.options.getString('full_name', true);
    const ticketCode = interaction.options.getString('ticket_code', true).trim().toUpperCase();
    const inputNormalized = normalizeName(inputName);

    try {
      // 2. Ticket lookup
      const ticketSnap = await db.collection('tickets').doc(ticketCode).get();
      if (!ticketSnap.exists) {
        return interaction.editReply({ embeds: [errorEmbed('Invalid ticket code.')] });
      }
      const ticket = ticketSnap.data();

      // 3. Candidate names (form players + leader), deduped by normalized form.
      //    Missing answer IDs are EXPECTED across cross-game forms — skip silently.
      const formData = await getFormResponseData(ticket);
      const { names: formNames, missingIds } = getPlayerNamesFromForm(formData);

      console.log(
        `[verify] ${ticketCode}: resolved ${formNames.length} form name(s); ` +
        `skipped missing answer IDs (expected cross-form): [${missingIds.join(', ') || 'none'}]`
      );

      const candidates = new Map();
      for (const n of [...formNames, ticket.name].filter(Boolean)) {
        const key = normalizeName(n);
        if (!candidates.has(key)) candidates.set(key, String(n).trim());
      }

      // 3b. Zero-names guard — treat as data corruption, not a user error.
      if (candidates.size === 0) {
        await audit(
          client,
          `⚠️ [DATA] Ticket ${ticketCode}: no player names found ` +
          `(formId=${ticket.formId ?? 'null'}, responseId=${ticket.responseId ?? 'null'}) ` +
          `and no leader name.`
        );
        return interaction.editReply({
          embeds: [errorEmbed('This ticket has no player names on record. Contact an admin.')],
        });
      }

      // 4. Exact (normalized) match
      if (!candidates.has(inputNormalized)) {
        return interaction.editReply({
          embeds: [
            errorEmbed(
              'Make sure the name is exactly as the one you submitted during registration.'
            ),
          ],
        });
      }
      const matchedName = candidates.get(inputNormalized);

      // 5. Claim check
      const claimSnap = await db
        .collection('verifications')
        .where('ticketCode', '==', ticketCode)
        .where('playerNameNormalized', '==', inputNormalized)
        .get();
      const claimedByOther = claimSnap.docs.find((d) => d.data().discordId !== interaction.user.id);
      if (claimedByOther) {
        return interaction.editReply({
          embeds: [
            errorEmbed(
              `This name has already been claimed by <@${claimedByOther.data().discordId}> for this ticket.`
            ),
          ],
        });
      }

      // 6. Same user, same ticket
      const selfSnap = await db
        .collection('verifications')
        .where('discordId', '==', interaction.user.id)
        .where('ticketCode', '==', ticketCode)
        .get();
      if (!selfSnap.empty) {
        return interaction.editReply({
          embeds: [errorEmbed('You have already verified for this ticket.')],
        });
      }

      // 7. Roles
      let game = getGameFromForm(formData);
      if (!game) {
        game = 'General';
        await audit(
          client,
          `⚠️ [DATA] Ticket ${ticketCode}: missing game answer ` +
          `(GAME_ANSWER_ID=${process.env.GAME_ANSWER_ID ?? 'unset'}) despite shared form template. ` +
          `formId=${ticket.formId ?? 'null'}, responseId=${ticket.responseId ?? 'null'}. ` +
          `Falling back to role "General".`
        );
      }
      await guild.roles.fetch();
      const gameRole = await getOrCreateRole(guild, game);
      const ticketRole = await getOrCreateRole(guild, ticketCode);
      const rolesToAdd = [gameRole, ticketRole];
      if (process.env.PLAYER_ROLE_ID) rolesToAdd.push(process.env.PLAYER_ROLE_ID);
      await member.roles.add(rolesToAdd);

      // 8. Verification doc
      try {
        await db.collection('verifications').add({
          discordId: interaction.user.id,
          ticketCode,
          playerName: matchedName,
          playerNameNormalized: inputNormalized,
          verifiedAt: admin.firestore.Timestamp.now(),
          formId: ticket.formId ?? null,
          responseId: ticket.responseId ?? null,
        });
      } catch (e) {
        await reportError(client, `verify: write verification (${ticketCode})`, e);
        return interaction.editReply({
          embeds: [errorEmbed('Something went wrong while saving your verification.')],
        });
      }

      // 9. Check-in (first verification only)
      if (!ticket.checkedIn) {
        try {
          await db.collection('tickets').doc(ticketCode).update({
            checkedIn: true,
            checkedInAt: admin.firestore.Timestamp.now(),
            checkedInBy: 'SZCUP-ADMIN',
          });
        } catch (e) {
          await reportError(client, `verify: check-in ticket ${ticketCode}`, e);
        }
      }

      // 10. Reply
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(colors.SUCCESS)
            .setTitle('Verified')
            .setDescription(
              `Welcome, **${matchedName}**!\nYou have been given <@&${gameRole.id}> and <@&${ticketRole.id}>.`
            ),
        ],
      });

      // 11. Audit
      await audit(
        client,
        `✅ [VERIFY] <@${interaction.user.id}> verified as "${matchedName}" for ticket ${ticketCode} (game: ${game})`
      );
    } catch (e) {
      await reportError(client, `verify (${ticketCode})`, e);
      await interaction
        .editReply({ embeds: [errorEmbed('Something went wrong. Please contact an admin.')] })
        .catch(() => {});
    }
  },
};