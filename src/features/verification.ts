/**
 * Sistema 3b: verificación (panel con botón que da el rol de miembro). La bienvenida está en welcome.ts.
 * También avisa a invitaciones cuando alguien queda verificado, para que le sume a quien lo invitó.
 */
import {
  ActionRowBuilder,
  type ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type Guild,
  type GuildMember,
  type Interaction,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { channelProblem, roleProblem } from "../health.js";
import { log } from "../log.js";
import { getValue, setValue } from "../store.js";
import type { Command, Feature, HealthCheck } from "../types.js";
import { brandEmbed, ephemeral } from "../ui.js";
import { creditVerifiedInvite, pendingInvitees } from "./invites/index.js";

const CONFIG_KEY = "verification";
const VERIFY_BUTTON_ID = "verification:verify";
export const VERIFY_EMOJI = "<a:black_verification:1565149595007189052>";
// Emoji y color del panel/botón (distintos del que usa la bienvenida y el de éxito, que quedan con VERIFY_EMOJI).
const PANEL_EMOJI = "<a:verified_blue:1565363775211569192>";
const EMOJI = {
  notConfigured: "<:2816mute:1565184168151879720>",
  alreadyVerified: "<:16121certifier:1565184454949863434>",
  roleFailed: "<:45228cybersecurite:1565184722051539094>",
};
export const VERIFY_FOOTER = "Sistema de Verificación";
const VERIFY_COLOR = 0x3498db;

interface VerificationConfig {
  roleId?: string;
  /** Canal donde está publicado el panel (se guarda solo para linkearlo desde la bienvenida). */
  channelId?: string;
}

const getConfig = (guildId: string): Promise<VerificationConfig> => getValue<VerificationConfig>(guildId, CONFIG_KEY, {});

/** Para que welcome.ts pueda linkear el canal del panel en el mensaje de bienvenida. */
export const getVerifyChannelId = async (guildId: string): Promise<string | undefined> => (await getConfig(guildId)).channelId;

function verifyRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setEmoji(PANEL_EMOJI).setStyle(ButtonStyle.Secondary),
  );
}

// ---------- comandos ----------
const verificationCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("verificacion")
    .setDescription("Sistema de verificación")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define el rol que se da al verificarse")
        .addRoleOption((o) => o.setName("rol").setDescription("Rol de miembro verificado").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("panel")
        .setDescription("Publica el panel de verificación")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Canal donde publicarlo (por defecto, este)")
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();
    const cfg = await getConfig(guild.id);

    if (sub === "config") {
      const rol = interaction.options.getRole("rol", true);
      await setValue(guild.id, CONFIG_KEY, { ...cfg, roleId: rol.id } satisfies VerificationConfig);
      const problem = await roleProblem(guild, rol.id);
      await interaction.reply(
        ephemeral(
          `✅ **Verificación configurada.**\n🎖️ Rango al verificarse: <@&${rol.id}>` +
            (problem ? `\n\n⚠️ Ojo: ${problem}. Así no voy a poder darlo.` : "\n\nAhora publicá el panel con `/verificacion panel`."),
        ),
      );
      return;
    }

    // sub === "panel"
    if (!cfg.roleId) {
      await interaction.reply(ephemeral("⚠️ Primero configurá la verificación con `/verificacion config`."));
      return;
    }
    const targetId = interaction.options.getChannel("canal")?.id ?? interaction.channelId;
    const target = await guild.channels.fetch(targetId).catch(() => null);
    if (!target || target.type !== ChannelType.GuildText) {
      await interaction.reply(ephemeral("⚠️ Elegí un canal de texto para publicar el panel."));
      return;
    }

    const embed = (await brandEmbed(guild))
      .setColor(VERIFY_COLOR)
      .setTitle(`${PANEL_EMOJI} Verificación`)
      .setDescription(`Tocá el botón de abajo para recibir el rango de <@&${cfg.roleId}> y desbloquear el resto del servidor.`)
      .setThumbnail(interaction.client.user.displayAvatarURL())
      .setFooter({ text: VERIFY_FOOTER, iconURL: interaction.client.user.displayAvatarURL() });
    const sent = await target.send({ embeds: [embed], components: [verifyRow()] }).catch(() => null);
    if (!sent) {
      const problem = await channelProblem(guild, target.id);
      await interaction.reply(ephemeral(`⚠️ No pude publicar el panel en <#${target.id}>${problem ? `: ${problem}` : "."}`));
      return;
    }
    await setValue(guild.id, CONFIG_KEY, { ...cfg, channelId: target.id } satisfies VerificationConfig);
    await interaction.reply(ephemeral(`✅ Panel de verificación publicado en <#${target.id}>.`));
  },
};

// ---------- botón: verificarse ----------
async function verify(i: ButtonInteraction): Promise<void> {
  const guild = i.guild;
  if (!guild) return;
  const cfg = await getConfig(guild.id);
  if (!cfg.roleId) {
    await i.reply(ephemeral(`${EMOJI.notConfigured} La verificación todavía no está configurada. Avisale a un admin.`));
    return;
  }
  const member = i.member as GuildMember;
  if (member.roles.cache.has(cfg.roleId)) {
    await i.reply(ephemeral(`${EMOJI.alreadyVerified} Ya estás verificado, no hace falta que lo hagas de nuevo.`));
    return;
  }
  try {
    await member.roles.add(cfg.roleId, "Verificación");
  } catch (err) {
    const problem = await roleProblem(guild, cfg.roleId);
    log.error("verificacion", `No pude darle el rol a ${member.user.tag} en ${guild.name}${problem ? ` (${problem})` : ""}`, err);
    await i.reply(ephemeral(`${EMOJI.roleFailed} No pude darte el rol. Avisale a un admin para que revise mis permisos.`));
    return;
  }
  await creditVerifiedInvite(member).catch((err) => log.error("invitaciones", "Error acreditando invitación", err));
  await i.reply({
    content: `${VERIFY_EMOJI} ¡Listo! Ahora tenés el rango de <@&${cfg.roleId}>. ¡Bienvenido al servidor!`,
    flags: MessageFlags.Ephemeral,
  });
}

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  if (!cfg.roleId) return { label: "Verificación", ok: false, detail: "no configurada (falta `/verificacion config`)" };
  const problem = await roleProblem(guild, cfg.roleId);
  if (problem) return { label: "Verificación", ok: false, detail: problem };
  if (!cfg.channelId) {
    return { label: "Verificación", ok: true, detail: `rol <@&${cfg.roleId}> (falta publicar el panel con \`/verificacion panel\`)` };
  }
  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) {
    return { label: "Verificación", ok: false, detail: "el canal del panel ya no existe, volvé a publicarlo con `/verificacion panel`" };
  }
  return { label: "Verificación", ok: true, detail: `rol <@&${cfg.roleId}>, panel en <#${channel.id}>` };
}

export const verification: Feature = {
  name: "verification",
  commands: [verificationCommand],
  checkHealth,
  register(client: Client): void {
    // La invitación suma cuando la persona tiene el rol de verificado, venga de donde venga:
    // el botón, un staff que se lo puso a mano u otro bot. Si no tenía nada pendiente, no hace nada.
    client.on(Events.GuildMemberUpdate, async (_before, member) => {
      const { roleId } = await getConfig(member.guild.id);
      if (!roleId || !member.roles.cache.has(roleId)) return;
      await creditVerifiedInvite(member).catch((err) => log.error("invitaciones", "Error acreditando invitación", err));
    });

    // Al prender: quien se verificó mientras el bot estaba apagado (o se perdió el evento) suma igual.
    client.once(Events.ClientReady, async (c) => {
      for (const guild of c.guilds.cache.values()) {
        try {
          const { roleId } = await getConfig(guild.id);
          const pending = await pendingInvitees(guild.id);
          if (!roleId || pending.length === 0) continue;
          // De a uno: así no se pide la lista de miembros por el gateway, que Discord limita mucho.
          for (const userId of pending) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member?.roles.cache.has(roleId)) await creditVerifiedInvite(member);
          }
        } catch (err) {
          log.error("invitaciones", `No pude revisar las invitaciones pendientes de ${guild.name}`, err);
        }
      }
    });
  },
  async handleInteraction(interaction: Interaction): Promise<boolean> {
    if (!interaction.isButton() || interaction.customId !== VERIFY_BUTTON_ID) return false;
    await verify(interaction);
    return true;
  },
};
