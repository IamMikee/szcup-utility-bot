const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { db } = require('../lib/firebase');
const colors = require('../config/colors');
const { requireAdmin } = require('../lib/guards');
const { audit, reportError } = require('../lib/audit');
const { getFormResponseData, getGameFromForm } = require('../lib/form');
const { findTicketRole } = require('../lib/roles');

async function gameForTicket(ticketCode) {
    const snap = await db.collection('tickets').doc(ticketCode).get();
    if (!snap.exists) return null;
    const formData = await getFormResponseData(snap.data());
    return getGameFromForm(formData);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clean-role')
        .setDescription('Remove verification data and roles for a ticket (admin)')
        .addStringOption((o) =>
            o.setName('ticket_code').setDescription('Team ticket code').setRequired(true)
        )
        .addUserOption((o) =>
            o
                .setName('user')
                .setDescription('Only clean this user (omit to clean the whole ticket)')
                .setRequired(false)
        ),

    async execute(interaction) {
        if (!(await requireAdmin(interaction))) return;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const client = interaction.client;
        const guild = interaction.guild;
        const adminId = interaction.user.id;
        const ticketCode = interaction.options.getString('ticket_code', true).trim().toUpperCase();
        const targetUser = interaction.options.getUser('user');
        const targetId = targetUser?.id ?? null;

        try {
            // ---- Active match guard ----
            const active = await db
                .collection('active_matches')
                .where('ticketCodes', 'array-contains', ticketCode)
                .where('status', '==', 'active')
                .limit(1)
                .get();
            if (!active.empty) {
                return interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(colors.ERROR)
                            .setDescription(
                                `Ticket **${ticketCode}** has an active match. Run \`/finish-match\` first.`
                            ),
                    ],
                });
            }

            // ---- Fetch verifications to clean ----
            let verQuery = db.collection('verifications').where('ticketCode', '==', ticketCode);
            if (targetId) verQuery = verQuery.where('discordId', '==', targetId);
            const verSnap = await verQuery.get();

            if (verSnap.empty) {
                return interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(colors.WARNING)
                            .setDescription(
                                targetId
                                    ? `<@${targetId}> has no verification for ticket **${ticketCode}**.`
                                    : `No verifications found for ticket **${ticketCode}**.`
                            ),
                    ],
                });
            }

            // ---- Resolve roles ----
            await guild.roles.fetch();
            const ticketRole = await findTicketRole(guild, ticketCode);
            const game = await gameForTicket(ticketCode);
            const gameRole = game ? guild.roles.cache.find((r) => r.name === game) ?? null : null;

            // ---- Clean each verification ----
            const result = { tickets: 0, games: 0, deleted: 0, errors: [] };

            for (const doc of verSnap.docs) {
                const { discordId } = doc.data();
                const member =
                    guild.members.cache.get(discordId) ??
                    (await guild.members.fetch(discordId).catch(() => null));

                if (member) {
                    // Ticket role
                    if (ticketRole && member.roles.cache.has(ticketRole.id)) {
                        try {
                            await member.roles.remove(ticketRole);
                            result.tickets++;
                        } catch (e) {
                            result.errors.push(`ticket role from <@${discordId}>: ${e.message}`);
                        }
                    }

                    // Player role
                    const playerRoleId = process.env.PLAYER_ROLE_ID;
                    if (playerRoleId && member.roles.cache.has(playerRoleId)) {
                        try {
                            await member.roles.remove(playerRoleId);
                        } catch (e) {
                            result.errors.push(`player role from <@${discordId}>: ${e.message}`);
                        }
                    }

                    // Game role — only if no other verifications for a same-game ticket remain
                    if (gameRole && member.roles.cache.has(gameRole.id) && game) {
                        const userVers = await db
                            .collection('verifications')
                            .where('discordId', '==', discordId)
                            .get();

                        let stillSameGame = false;
                        for (const ov of userVers.docs) {
                            const ovCode = ov.data().ticketCode;
                            if (ovCode === ticketCode) continue; // this one is being deleted
                            if (targetId && ovCode === ticketCode) continue;
                            // Skip docs that belong to the current cleanup batch
                            if (!targetId && verSnap.docs.some((d) => d.id === ov.id)) continue;

                            const ovGame = await gameForTicket(ovCode);
                            if (ovGame === game) {
                                stillSameGame = true;
                                break;
                            }
                        }

                        if (!stillSameGame) {
                            try {
                                await member.roles.remove(gameRole);
                                result.games++;
                            } catch (e) {
                                result.errors.push(`game role from <@${discordId}>: ${e.message}`);
                            }
                        }
                    }
                }

                try {
                    await doc.ref.delete();
                    result.deleted++;
                } catch (e) {
                    result.errors.push(`verification ${doc.id}: ${e.message}`);
                }
            }

            // ---- Post-clean state ----
            const remaining = await db
                .collection('verifications')
                .where('ticketCode', '==', ticketCode)
                .limit(1)
                .get();
            const fullyCleaned = remaining.empty;

            if (fullyCleaned) {
                if (ticketRole) {
                    try {
                        await ticketRole.delete('AZHEN clean-role');
                    } catch (e) {
                        result.errors.push(`ticket role deletion: ${e.message}`);
                    }
                }
                const ticketSnap = await db.collection('tickets').doc(ticketCode).get();
                if (ticketSnap.exists) {
                    try {
                        await db.collection('tickets').doc(ticketCode).update({
                            checkedIn: false,
                            checkedInAt: null,
                            checkedInBy: null,
                        });
                    } catch (e) {
                        result.errors.push(`ticket check-in reset: ${e.message}`);
                    }
                }
            }

            // ---- Reply ----
            const scope = targetId ? `<@${targetId}> on ticket **${ticketCode}**` : `ticket **${ticketCode}**`;
            const lines = [
                `🧹 Cleaned ${scope}.`,
                `• Verifications deleted: **${result.deleted}**`,
                `• Ticket roles removed: **${result.tickets}**`,
                `• Game roles removed: **${result.games}**`,
                `• Ticket fully cleaned: **${fullyCleaned ? 'yes' : 'no'}** (checked-in reset: ${fullyCleaned ? 'yes' : 'no'})`,
            ];
            if (result.errors.length) {
                lines.push(`\n⚠️ Errors (${result.errors.length}):\n${result.errors.slice(0, 5).join('\n')}${result.errors.length > 5 ? '\n…' : ''}`);
            }
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(result.errors.length ? colors.WARNING : colors.SUCCESS)
                        .setDescription(lines.join('\n')),
                ],
            });

            // ---- Audit ----
            const auditLines = [
                `🧹 [CLEAN-ROLE] <@${adminId}> cleaned ${scope}`,
                `• Verifications deleted: ${result.deleted}`,
                `• Ticket roles removed: ${result.tickets}`,
                `• Game roles removed: ${result.games}`,
                `• Fully cleaned: ${fullyCleaned}${fullyCleaned && ticketRole ? ` (deleted role ${ticketCode})` : ''}`,
            ];
            if (result.errors.length) {
                auditLines.push(`• Errors: ${result.errors.length} (see console)`);
                result.errors.forEach((e) => console.error('[clean-role]', e));
            }
            await audit(client, auditLines.join('\n'));
        } catch (e) {
            await reportError(client, `clean-role (${ticketCode})`, e);
            await interaction
                .editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(colors.ERROR)
                            .setDescription('Something went wrong. Check the audit channel.'),
                    ],
                })
                .catch(() => { });
        }
    },
};