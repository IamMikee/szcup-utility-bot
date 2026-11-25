const {SlashCommandBuilder} = require("discord.js");
const {EmbedBuilder} = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear specific amount of messages in this channel.")
        .addIntegerOption(
            option => 
                option
                    .setName("amount")
                    .setDescription("The amount of messages to clear")
                    .setRequired(true)
        )
        ,

    async execute(interaction) {
        await interaction.deferReply({ephemeral: true});

        const numberOfMsgs = interaction.options.getInteger('amount');

        if(numberOfMsgs < 1)
            return await interaction.followUp({content: "You cannot remove less than 1 message."});

        interaction.channel.bulkDelete(parseInt(numberOfMsgs))
            .then(msgs => {
                interaction.followUp({embeds: [
                new EmbedBuilder()
                    .setTitle("Clear Successful")
                    .setDescription(`\`Cleared ${numberOfMsgs} messages.\``)
                    .setFooter({text: `Clear executed by ${interaction.user.name}.`})
                ]})
                .then(() => {
                    setTimeout(() => interaction.deleteReply(), 5000)
                })
                .catch(err => {console.log(err)});
                console.log(msgs)
            })
            .catch(err => {console.log(err)});
    }
}