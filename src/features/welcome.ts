/** Sistema 3a: bienvenida (mensaje al unirse). El rol y el panel de verificación están en verification.ts */
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type Guild,
  type GuildMember,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { channelProblem } from "../health.js";
import { log } from "../log.js";
import { getValue, setValue } from "../store.js";
import type { Command, Feature, HealthCheck } from "../types.js";
import { brandEmbed, ephemeral, serverName } from "../ui.js";
import { VERIFY_EMOJI, getVerifyChannelId } from "./verification.js";

const CONFIG_KEY = "welcome";
const WAVE_EMOJI = "<a:wave:1565153135184449637>";
// Blanco: Discord toma 0xffffff como "sin color", por eso va uno apenas distinto.
const WELCOME_COLOR = 0xfffffe;
export const WELCOME_FOOTER = "Sistema de Bienvenidas";

interface WelcomeConfig {
  channelId?: string;
}

const getConfig = (guildId: string): Promise<WelcomeConfig> => getValue<WelcomeConfig>(guildId, CONFIG_KEY, {});

// ---------- comandos ----------
const welcomeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("bienvenida")
    .setDescription("Sistema de bienvenida")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define el canal donde se saluda a quien se une")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Canal de bienvenidas")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName("simular").setDescription("[Prueba] Manda el mensaje de bienvenida como si te acabaras de unir"),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "config") {
      const canal = interaction.options.getChannel("canal", true);
      await setValue(guild.id, CONFIG_KEY, { channelId: canal.id } satisfies WelcomeConfig);
      const problem = await channelProblem(guild, canal.id);
      await interaction.reply(
        ephemeral(
          `✅ **Bienvenida configurada.**\n📢 Canal: <#${canal.id}>` +
            (problem ? `\n\n⚠️ Ojo: ${problem}. Hasta que lo arregles no voy a poder saludar.` : "\n\nProbalo con `/bienvenida simular`."),
        ),
      );
      return;
    }

    // sub === "simular"
    const cfg = await getConfig(guild.id);
    if (!cfg.channelId) {
      await interaction.reply(ephemeral("⚠️ Primero elegí el canal con `/bienvenida config`."));
      return;
    }
    await onMemberAdd(interaction.member as GuildMember);
    await interaction.reply(ephemeral(`✅ Mensaje de bienvenida mandado a <#${cfg.channelId}> (modo prueba).`));
  },
};

// ---------- evento: alguien se une ----------
async function onMemberAdd(member: GuildMember): Promise<void> {
  const cfg = await getConfig(member.guild.id);
  if (!cfg.channelId) return;
  const channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    log.warn("bienvenida", `El canal de bienvenidas de ${member.guild.name} ya no existe (revisá /bienvenida config).`);
    return;
  }

  const verifyChannelId = await getVerifyChannelId(member.guild.id);
  const verifyLine = verifyChannelId
    ? `\n\n${VERIFY_EMOJI} Pasá por <#${verifyChannelId}> y verificate para acceder al resto de los canales y poder jugar.`
    : "";
  const embed = (await brandEmbed(member.guild))
    .setColor(WELCOME_COLOR)
    .setTitle(`${WAVE_EMOJI} ¡Bienvenido/a!`)
    .setDescription(
      `¡Hola <@${member.id}>! Bienvenido/a a **${await serverName(member.guild)}**. ` +
        `Sos el miembro **#${member.guild.memberCount}**.${verifyLine}`,
    )
    .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
    .setThumbnail(member.user.displayAvatarURL())
    .setFooter({ text: WELCOME_FOOTER, iconURL: member.client.user.displayAvatarURL() });
  await channel
    .send({ embeds: [embed] })
    .catch((err) => log.error("bienvenida", `No pude saludar a ${member.user.tag} en ${member.guild.name}`, err));
}

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  if (!cfg.channelId) return { label: "Bienvenida", ok: false, detail: "no configurada (falta `/bienvenida config`)" };
  const problem = await channelProblem(guild, cfg.channelId);
  if (problem) return { label: "Bienvenida", ok: false, detail: problem };
  return { label: "Bienvenida", ok: true, detail: `canal <#${cfg.channelId}>` };
}

export const welcome: Feature = {
  name: "welcome",
  commands: [welcomeCommand],
  checkHealth,
  register(client: Client): void {
    client.on(Events.GuildMemberAdd, (member) => {
      onMemberAdd(member).catch((err) => log.error("bienvenida", "Error al dar la bienvenida", err));
    });
  },
};
