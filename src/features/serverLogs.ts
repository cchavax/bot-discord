/**
 * Registro del servidor: todo lo que pasa, en un canal de staff (`/logs config`).
 * Entradas y salidas, mensajes editados y borrados, baneos, cambios de apodo y de roles,
 * canales creados/borrados y movimientos en canales de voz.
 *
 * Ese mismo canal recibe el aviso de "bot iniciado" con el estado de la configuración.
 */
import {
  AuditLogEvent,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
  Events,
  type Guild,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type PartialUser,
  type User,
} from "discord.js";
import { channelProblem } from "../health.js";
import { log } from "../log.js";
import { getValue, setValue } from "../store.js";
import type { Command, Feature, HealthCheck } from "../types.js";
import { brandEmbed, ephemeral } from "../ui.js";

const CONFIG_KEY = "serverLogs";
const MAX_FIELD = 1024;

const COLOR = {
  join: 0x2ecc71,
  leave: 0xe67e22,
  edit: 0x3498db,
  delete: 0xe74c3c,
  mod: 0x992d22,
  info: 0x95a5a6,
} as const;

interface ServerLogsConfig {
  channelId?: string;
}

const getConfig = (guildId: string): Promise<ServerLogsConfig> => getValue<ServerLogsConfig>(guildId, CONFIG_KEY, {});

/** Canal de registros del servidor (si lo hay). Lo usa index.ts para el aviso de inicio. */
export const getServerLogChannelId = async (guildId: string): Promise<string | undefined> => (await getConfig(guildId)).channelId;

const clip = (text: string, max = MAX_FIELD): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const quote = (text: string | null | undefined): string => (text ? clip(text) : "*(sin texto o no lo tenía guardado)*");
const who = (user: User | PartialUser): string => `<@${user.id}>${user.tag ? ` (${user.tag})` : ""}`;

async function send(guild: Guild, build: (embed: EmbedBuilder) => EmbedBuilder, color: number): Promise<void> {
  const cfg = await getConfig(guild.id);
  if (!cfg.channelId) return;
  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const embed = build((await brandEmbed(guild)).setColor(color));
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

/** Quién hizo una acción según el registro de auditoría (si el bot tiene permiso para verlo). */
async function auditExecutor(guild: Guild, type: AuditLogEvent, targetId: string): Promise<User | PartialUser | null> {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => (e.target as { id?: string } | null)?.id === targetId && Date.now() - e.createdTimestamp < 10_000);
  return entry?.executor ?? null;
}

// ---------- comando ----------
const logsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("logs")
    .setDescription("Registro de todo lo que pasa en el servidor")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define el canal (de staff) donde se registra todo")
        .addChannelOption((o) =>
          o.setName("canal").setDescription("Canal de registros").addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName("desactivar").setDescription("Deja de registrar"))
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    if (interaction.options.getSubcommand() === "desactivar") {
      await setValue(guild.id, CONFIG_KEY, {} satisfies ServerLogsConfig);
      await interaction.reply(ephemeral("✅ Registro del servidor desactivado."));
      return;
    }
    const canal = interaction.options.getChannel("canal", true);
    await setValue(guild.id, CONFIG_KEY, { channelId: canal.id } satisfies ServerLogsConfig);
    const problem = await channelProblem(guild, canal.id);
    const audit = guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)
      ? ""
      : "\nℹ️ Si me das el permiso **Ver registro de auditoría** también puedo decir *quién* baneó o borró algo.";
    await interaction.reply(
      ephemeral(
        `✅ **Registro del servidor activado** en <#${canal.id}>.\n` +
          "Voy a anotar: entradas y salidas, mensajes editados/borrados, baneos, apodos, roles, canales y voz." +
          (problem ? `\n\n⚠️ Ojo: ${problem}.` : audit),
      ),
    );
  },
};

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  if (!cfg.channelId) return { label: "Registro del servidor", ok: false, detail: "no configurado (falta `/logs config`)" };
  const problem = await channelProblem(guild, cfg.channelId);
  if (problem) return { label: "Registro del servidor", ok: false, detail: problem };
  return { label: "Registro del servidor", ok: true, detail: `canal <#${cfg.channelId}>` };
}

// ---------- eventos ----------
function registerEvents(client: Client): void {
  const safe = (scope: string, fn: () => Promise<void>) => {
    fn().catch((err) => log.error("logs", `Error registrando ${scope}`, err));
  };

  client.on(Events.GuildMemberAdd, (member) =>
    safe("entrada", () =>
      send(
        member.guild,
        (e) =>
          e
            .setTitle("📥 Entró alguien")
            .setDescription(`${who(member.user)}\nCuenta creada <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`)
            .setThumbnail(member.user.displayAvatarURL())
            .setFooter({ text: `Miembros: ${member.guild.memberCount} · ID ${member.id}` }),
        COLOR.join,
      ),
    ),
  );

  client.on(Events.GuildMemberRemove, (member) =>
    safe("salida", async () => {
      const kickedBy = await auditExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
      const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => `<@&${r.id}>`) ?? [];
      await send(
        member.guild,
        (e) =>
          e
            .setTitle(kickedBy ? "👢 Expulsaron a alguien" : "📤 Se fue alguien")
            .setDescription(
              `${member.user ? who(member.user) : `<@${member.id}>`}` +
                (kickedBy ? `\nExpulsado por ${who(kickedBy)}` : "") +
                (member.joinedTimestamp ? `\nHabía entrado <t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : ""),
            )
            .addFields(roles.length > 0 ? [{ name: "Roles", value: clip(roles.join(" ")) }] : [])
            .setFooter({ text: `Miembros: ${member.guild.memberCount} · ID ${member.id}` }),
        kickedBy ? COLOR.mod : COLOR.leave,
      );
    }),
  );

  client.on(Events.GuildBanAdd, (ban) =>
    safe("baneo", async () => {
      const by = await auditExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
      await send(
        ban.guild,
        (e) =>
          e
            .setTitle("🔨 Baneo")
            .setDescription(`${who(ban.user)}${by ? `\nPor ${who(by)}` : ""}${ban.reason ? `\nMotivo: ${clip(ban.reason, 500)}` : ""}`),
        COLOR.mod,
      );
    }),
  );

  client.on(Events.GuildBanRemove, (ban) =>
    safe("desbaneo", () => send(ban.guild, (e) => e.setTitle("🕊️ Desbaneo").setDescription(who(ban.user)), COLOR.info)),
  );

  client.on(Events.MessageUpdate, (before, after) =>
    safe("edición", async () => {
      if (!after.guild || after.author?.bot) return;
      if (before.content === after.content) return; // cambió solo un embed o un adjunto, no el texto
      const logChannel = await getServerLogChannelId(after.guild.id);
      if (after.channelId === logChannel) return;
      await send(
        after.guild,
        (e) =>
          e
            .setTitle("✏️ Mensaje editado")
            .setDescription(`${after.author ? who(after.author) : "Alguien"} en <#${after.channelId}> · [ir al mensaje](${after.url})`)
            .addFields({ name: "Antes", value: quote(before.content) }, { name: "Después", value: quote(after.content) }),
        COLOR.edit,
      );
    }),
  );

  client.on(Events.MessageDelete, (message) =>
    safe("borrado", async () => {
      if (!message.guild || message.author?.bot) return;
      const logChannel = await getServerLogChannelId(message.guild.id);
      if (message.channelId === logChannel) return;
      const files = message.attachments?.map((a) => a.name) ?? [];
      await send(
        message.guild,
        (e) =>
          e
            .setTitle("🗑️ Mensaje borrado")
            .setDescription(`${message.author ? who(message.author) : "Alguien"} en <#${message.channelId}>`)
            .addFields(
              { name: "Contenido", value: quote(message.content) },
              ...(files.length > 0 ? [{ name: "Adjuntos", value: clip(files.join(", ")) }] : []),
            ),
        COLOR.delete,
      );
    }),
  );

  client.on(Events.GuildMemberUpdate, (before, after) =>
    safe("cambio de miembro", async () => {
      if (before.partial) return;
      const lines: string[] = [];
      if (before.nickname !== after.nickname) {
        lines.push(`**Apodo:** \`${before.nickname ?? "(ninguno)"}\` → \`${after.nickname ?? "(ninguno)"}\``);
      }
      const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
      const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
      if (added.size > 0) lines.push(`**Roles agregados:** ${added.map((r) => `<@&${r.id}>`).join(" ")}`);
      if (removed.size > 0) lines.push(`**Roles quitados:** ${removed.map((r) => `<@&${r.id}>`).join(" ")}`);
      if (!before.premiumSince && after.premiumSince) lines.push("💎 **Empezó a boostear el servidor**");
      if (before.premiumSince && !after.premiumSince) lines.push("💔 Dejó de boostear el servidor");
      if (lines.length === 0) return;
      await send(after.guild, (e) => e.setTitle("👤 Cambio de miembro").setDescription(`${who(after.user)}\n${clip(lines.join("\n"), 4000)}`), COLOR.info);
    }),
  );

  client.on(Events.ChannelCreate, (channel) =>
    safe("canal creado", async () => {
      // Los tickets ya tienen su propio registro (apertura y cierre con transcripción).
      if ("topic" in channel && channel.topic?.startsWith("ticket|")) return;
      await send(channel.guild, (e) => e.setTitle("➕ Canal creado").setDescription(`<#${channel.id}> (${channel.name})`), COLOR.info);
    }),
  );

  client.on(Events.ChannelDelete, (channel) =>
    safe("canal borrado", async () => {
      if (channel.isDMBased()) return;
      // Los tickets cerrados ya quedan registrados con su transcripción: no hace falta repetirlo.
      if ("topic" in channel && channel.topic?.startsWith("ticket|")) return;
      await send(channel.guild, (e) => e.setTitle("➖ Canal borrado").setDescription(`#${channel.name}`), COLOR.delete);
    }),
  );

  client.on(Events.VoiceStateUpdate, (before, after) =>
    safe("voz", async () => {
      const member = after.member ?? before.member;
      if (!member || member.user.bot || before.channelId === after.channelId) return;
      const text = !before.channelId
        ? `🔊 ${who(member.user)} entró a <#${after.channelId}>`
        : !after.channelId
          ? `🔇 ${who(member.user)} salió de <#${before.channelId}>`
          : `🔀 ${who(member.user)} se movió de <#${before.channelId}> a <#${after.channelId}>`;
      await send(after.guild, (e) => e.setDescription(text), COLOR.info);
    }),
  );
}

export const serverLogs: Feature = {
  name: "serverLogs",
  commands: [logsCommand],
  checkHealth,
  register: registerEvents,
};
