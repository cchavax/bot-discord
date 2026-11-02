/**
 * Puente con el servidor de Minecraft (el plugin es un proyecto aparte: ../minecraft-plugin).
 *
 * El plugin le pega por HTTP a este bot (nunca al revés) para avisar sanciones, reportes,
 * mensajes del staff chat y vínculos de cuenta. Ver src/features/mcBridge/server.ts.
 *
 * Config con `/mcbridge canal <reportes|sanciones|staffchat> <canal>`.
 * Un jugador vincula su cuenta con `/vincular` (acá) y después `/mclink <código>` en el juego.
 */
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  InteractionContextType,
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { Command, Feature, HealthCheck } from "../../types.js";
import { ephemeral } from "../../ui.js";
import { createLinkCode, getConfig, pushStaffChatToMinecraft, setChannel, setWhitelistRole } from "./store.js";
import { attachClient, startMcBridgeServer } from "./server.js";

const CHANNEL_KIND = {
  reportes: "reportChannelId",
  sanciones: "sanctionChannelId",
  staffchat: "staffChatChannelId",
} as const;

const mcBridgeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("mcbridge")
    .setDescription("Puente con el servidor de Minecraft")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("canal")
        .setDescription("Configura en qué canal se avisa cada cosa del servidor de Minecraft")
        .addStringOption((o) =>
          o
            .setName("tipo")
            .setDescription("Qué se avisa en ese canal")
            .setRequired(true)
            .addChoices(
              { name: "Reportes de jugadores", value: "reportes" },
              { name: "Sanciones (ban/mute/kick)", value: "sanciones" },
              { name: "Staff chat (dos vías)", value: "staffchat" },
            ),
        )
        .addChannelOption((o) => o.setName("canal").setDescription("Canal de texto").addChannelTypes(ChannelType.GuildText).setRequired(true)),
    )
    .addSubcommand((s) => s.setName("estado").setDescription("Muestra cómo está configurado el puente"))
    .addSubcommand((s) =>
      s
        .setName("rol-whitelist")
        .setDescription("Rol de Discord que, con la cuenta vinculada, deja entrar a un server con whitelist")
        .addRoleOption((o) => o.setName("rol").setDescription("Rol (ej. Beta Tester). Vacío para desactivar").setRequired(false)),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "estado") {
      const cfg = await getConfig(guild.id);
      await interaction.reply(
        ephemeral(
          [
            `Reportes: ${cfg.reportChannelId ? `<#${cfg.reportChannelId}>` : "*(sin configurar)*"}`,
            `Sanciones: ${cfg.sanctionChannelId ? `<#${cfg.sanctionChannelId}>` : "*(sin configurar)*"}`,
            `Staff chat: ${cfg.staffChatChannelId ? `<#${cfg.staffChatChannelId}>` : "*(sin configurar)*"}`,
            `Secreto del puente (MC_BRIDGE_SECRET): ${process.env.MC_BRIDGE_SECRET ? "configurado ✅" : "⚠️ falta en el .env, el puente está apagado"}`,
            `Rol de whitelist: ${cfg.whitelistRoleId ? `<@&${cfg.whitelistRoleId}>` : "*(sin configurar)*"}`,
          ].join("\n"),
        ),
      );
      return;
    }

    if (sub === "rol-whitelist") {
      const role = interaction.options.getRole("rol");
      await setWhitelistRole(guild.id, role?.id ?? null);
      await interaction.reply(
        ephemeral(role ? `✅ Rol de whitelist ahora es ${role}.` : "✅ Rol de whitelist desactivado."),
      );
      return;
    }

    // sub === "canal"
    const tipo = interaction.options.getString("tipo", true) as keyof typeof CHANNEL_KIND;
    const channel = interaction.options.getChannel("canal", true);
    await setChannel(guild.id, CHANNEL_KIND[tipo], channel.id);
    await interaction.reply(ephemeral(`✅ El canal de **${tipo}** del puente con Minecraft ahora es <#${channel.id}>.`));
  },
};

const vincularCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("vincular")
    .setDescription("Generá un código para vincular tu cuenta de Minecraft con tu Discord")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const code = createLinkCode(guild.id, interaction.user.id);
    await interaction.reply(
      ephemeral(
        `🔗 Tu código es \`${code}\` (vale 10 minutos).\nEntrá al servidor de Minecraft y escribí \`/mclink ${code}\`.\n` +
          `⚠️ Esto reemplaza cualquier otra cuenta que ya tengas vinculada (solo se puede tener una a la vez).`,
      ),
    );
  },
};

/** Para programadores: suma una cuenta extra (de test/dev) sin pisar la que ya tenías vinculada. */
const vincularDevCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("vincular-dev")
    .setDescription("Vincula una cuenta extra de Minecraft (test/dev) sin reemplazar la que ya tenés")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const code = createLinkCode(guild.id, interaction.user.id, true);
    await interaction.reply(
      ephemeral(
        `🔗 Tu código es \`${code}\` (vale 10 minutos).\nEntrá al servidor de Minecraft (con la cuenta extra) y escribí \`/mclink ${code}\`.\n` +
          `✅ Esta NO reemplaza tus otras cuentas vinculadas.`,
      ),
    );
  },
};

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  const configured = [cfg.reportChannelId, cfg.sanctionChannelId, cfg.staffChatChannelId].filter(Boolean).length;
  if (!process.env.MC_BRIDGE_SECRET) {
    return { label: "Puente con Minecraft", ok: false, detail: "falta MC_BRIDGE_SECRET en el .env, está apagado" };
  }
  if (configured === 0) {
    return { label: "Puente con Minecraft", ok: false, detail: "ningún canal configurado (`/mcbridge canal`)" };
  }
  return { label: "Puente con Minecraft", ok: true, detail: `${configured}/3 canal(es) configurado(s)` };
}

export const mcBridge: Feature = {
  name: "mcBridge",
  commands: [mcBridgeCommand, vincularCommand, vincularDevCommand],
  checkHealth,
  register(client: Client): void {
    attachClient(client);
    startMcBridgeServer();

    // Discord -> Minecraft: lo que se escribe en el canal de staff chat configurado se encola
    // para que el plugin lo retire con /api/guilds/:id/staffchat/poll.
    client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot || !message.guildId) return;
      const cfg = await getConfig(message.guildId);
      if (message.channelId !== cfg.staffChatChannelId) return;
      const text = message.content.trim();
      if (!text) return;
      pushStaffChatToMinecraft(message.guildId, message.member?.displayName ?? message.author.username, text);
    });
  },
};
