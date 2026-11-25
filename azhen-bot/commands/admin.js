const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const colors = require('../config/colors');
const { requireAdmin } = require('../lib/guards');
const { audit, reportError } = require('../lib/audit');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('admin')
        .setDescription('Grant or revoke the admin role for a user (admin)')
        .addUserOption((o) =>
            o.setName('user').setDescription('Target user').setRequired(true)
        ),

    async execute(interaction) {
        if (!(await requireAdmin(interaction))) return;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const client = interaction.client;
        const guild = interaction.guild;
        const adminId = interaction.user.id;
        const targetUser = interaction.options.getUser('user', true);

        const fail = (msg) =>
            interaction.editReply({
                embeds: [new EmbedBuilder().setColor(colors.ERROR).setDescription(msg)],
            });

        try {
            if (targetUser.id === adminId) {
                return fail('You cannot modify your own admin status.');
            }
            if (targetUser.bot) {
                return fail('You cannot modify bot admin status.');
            }

            const adminRole = guild.roles.cache.get(process.env.ADMIN_ROLE_ID);
            if (!adminRole) {
                return fail('Admin role not found. Check `ADMIN_ROLE_ID` in `.env`.');
            }

            const member = await guild.members.fetch(targetUser.id).catch(() => null);
            if (!member) {
                return fail('User is not in this server.');
            }

            const hasAdmin = member.roles.cache.has(adminRole.id);

            if (hasAdmin) {
                // Lockout guard: refuse to remove the last admin
                const roleMembers = await guild.members.fetch({ role: adminRole.id }).catch(() => null);
                const adminCount = roleMembers?.size ?? 0;
                if (adminCount <= 1) {
                    return fail(
                        'Cannot remove the last admin. Grant admin to another user first.'
                    );
                }

                await member.roles.remove(adminRole);
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(colors.SUCCESS)
                            .setDescription(`🔓 Removed admin role from <@${targetUser.id}>.`),
                    ],
                });
                await audit(
                    client,
                    `🔓 [ADMIN] <@${adminId}> removed admin role from <@${targetUser.id}> (${targetUser.tag})`
                );
            } else {
                await member.roles.add(adminRole);
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(colors.SUCCESS)
                            .setDescription(`🔐 Granted admin role to <@${targetUser.id}>.`),
                    ],
                });
                await audit(
                    client,
                    `🔐 [ADMIN] <@${adminId}> granted admin role to <@${targetUser.id}> (${targetUser.tag})`
                );
            }
        } catch (e) {
            await reportError(client, `admin (${targetUser.id})`, e);
            await fail('Something went wrong. Check the audit channel.');
        }
    },
};