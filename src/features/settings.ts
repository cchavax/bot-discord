/**
 * Ajustes generales del bot en cada servidor:
 *  - /ajustes estado → revisa todos los sistemas y dice qué falta configurar y cómo.
 *  - /ajustes marca  → nombre del footer, nombre del servidor en los textos y color.
 * Además, cuando el bot entra a un servidor nuevo, manda una guía de primeros pasos.
 */
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
  Events,
  type Guild,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { log } from "../log.js";
import { setValue } from "../store.js";
import type { Command, Feature, HealthCheck } from "../types.js";
import { BRANDING_KEY, type Branding, brandEmbed, ephemeral, formatHexColor, getBranding, parseHexColor } from "../ui.js";

/** Corre el chequeo de todos los sistemas que tengan uno. Un chequeo que falla no frena a los demás. */
export async function runHealthChecks(guild: Guild, features: readonly Feature[]): Promise<HealthCheck[]> {
  const results: HealthCheck[] = [];
  for (const feature of features) {
    if (!feature.checkHealth) continue;
    try {
      results.push(await feature.checkHealth(guild));
    } catch (err) {
      results.push({ label: feature.name, ok: false, detail: `no pude revisarlo (${(err as Error).message})` });
    }
  }
  return results;
}

export async function healthEmbed(guild: Guild, results: HealthCheck[], title: string): Promise<EmbedBuilder> {
  const okCount = results.filter((r) => r.ok).length;
  return (await brandEmbed(guild))
    .setColor(okCount === results.length ? 0x2ecc71 : 0xf1c40f)
    .setTitle(title)
    .setDescription(
      results.map((r) => `${r.ok ? "✅" : "⚠️"} **${r.label}**: ${r.detail}`).join("\n") +
        `\n\n**${okCount}/${results.length}** sistemas listos.`,
    );
}

export function createSettings(getFeatures: () => readonly Feature[]): Feature {
  const settingsCommand: Command = {
    data: new SlashCommandBuilder()
      .setName("ajustes")
      .setDescription("Ajustes generales del bot en este servidor")
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName("estado").setDescription("Revisa todos los sistemas y te dice qué falta configurar"))
      .addSubcommand((s) =>
        s
          .setName("marca")
          .setDescription("Personaliza cómo se ve el bot en este servidor (sin opciones, muestra lo actual)")
          .addStringOption((o) => o.setName("nombre").setDescription("Texto del pie de los mensajes (ej. Aura System)").setMaxLength(60))
          .addStringOption((o) =>
            o.setName("servidor").setDescription("Cómo nombrar al servidor en los textos (ej. Aura Craft)").setMaxLength(60),
          )
          .addStringOption((o) => o.setName("color").setDescription("Color del costado de los mensajes, en hex (ej. #6c3ce9)"))
          .addBooleanOption((o) => o.setName("restablecer").setDescription("Vuelve todo a los valores por defecto")),
      )
      .toJSON(),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
      const guild = interaction.guild;
      if (!guild) return;
      const sub = interaction.options.getSubcommand();

      if (sub === "estado") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const results = await runHealthChecks(guild, getFeatures());
        await interaction.editReply({ embeds: [await healthEmbed(guild, results, "🩺 Estado del bot en este servidor")] });
        return;
      }

      // sub === "marca"
      let branding = await getBranding(guild.id);
      if (interaction.options.getBoolean("restablecer")) {
        branding = {};
      } else {
        const nombre = interaction.options.getString("nombre")?.trim();
        const servidor = interaction.options.getString("servidor")?.trim();
        const colorText = interaction.options.getString("color");
        if (colorText !== null) {
          const color = parseHexColor(colorText);
          if (color === null) {
            await interaction.reply(ephemeral("⚠️ Ese color no es válido. Usá el formato hexadecimal, por ejemplo `#6c3ce9`."));
            return;
          }
          branding = { ...branding, color };
        }
        if (nombre) branding = { ...branding, systemName: nombre };
        if (servidor) branding = { ...branding, serverName: servidor };
      }
      await setValue(guild.id, BRANDING_KEY, branding satisfies Branding);

      const preview = (await brandEmbed(guild))
        .setTitle("🎨 Marca del bot")
        .setDescription(
          `**Pie de los mensajes:** ${branding.systemName ?? `${guild.client.user.username} *(por defecto)*`}\n` +
            `**Nombre del servidor:** ${branding.serverName ?? `${guild.name} *(por defecto)*`}\n` +
            `**Color:** ${branding.color !== undefined ? formatHexColor(branding.color) : "el de cada sistema *(por defecto)*"}\n\n` +
            "Así se ven los mensajes del bot ahora. Los paneles ya publicados se actualizan cuando los vuelvas a publicar.",
        );
      await interaction.reply({ embeds: [preview], flags: MessageFlags.Ephemeral });
    },
  };

  /** Guía de primeros pasos al entrar a un servidor nuevo (en el canal de sistema, si puede escribir ahí). */
  async function onGuildJoin(guild: Guild): Promise<void> {
    log.ok("servidores", `Me agregaron a ${guild.name} (${guild.memberCount} miembros).`);
    const channel =
      guild.systemChannel ??
      guild.channels.cache.find((c) => c.type === ChannelType.GuildText && Boolean(guild.members.me && c.permissionsFor(guild.members.me).has("SendMessages")));
    if (!channel || !channel.isTextBased()) return;

    const embed = (await brandEmbed(guild))
      .setTitle(`👋 ¡Gracias por sumarme a ${guild.name}!`)
      .setDescription(
        "Para dejarme andando, un admin puede seguir estos pasos (todos los comandos piden permisos de staff):\n\n" +
          "**1.** `/ajustes marca` — nombre y color de los mensajes\n" +
          "**2.** `/logs config` — canal de registros del servidor\n" +
          "**3.** `/bienvenida config` y `/verificacion config` → `/verificacion panel`\n" +
          "**4.** `/ticket config` → `/ticket panel`\n" +
          "**5.** `/sugerencias config`, `/sorteo config`, `/invitaciones config`, `/contador config`\n\n" +
          "En cualquier momento, `/ajustes estado` te dice qué falta y si me falta algún permiso.",
      );
    await channel.send({ embeds: [embed] }).catch(() => {});
  }

  return {
    name: "settings",
    commands: [settingsCommand],
    register(client: Client): void {
      client.on(Events.GuildCreate, (guild) => {
        onGuildJoin(guild).catch((err) => log.error("servidores", "Error mandando la guía de inicio", err));
      });
      client.on(Events.GuildDelete, (guild) => {
        log.info("servidores", `Me sacaron de ${guild.name ?? guild.id}. Su configuración queda guardada por si vuelvo.`);
      });
    },
  };
}
