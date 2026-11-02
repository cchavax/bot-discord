/**
 * Automod: filtros automáticos de spam, links, invitaciones a otros servidores, menciones
 * masivas, y alerta de raid (muchas entradas juntas). Cada filtro se prende por separado con
 * `/automod`. Al saltar uno, el bot borra el mensaje y le da una advertencia a la persona
 * (que cuenta para la escala de sanciones automáticas de /moderacion).
 *
 * No se aplica a bots, admins, gente con "Gestionar mensajes", rangos de staff, ni a los roles y
 * canales excluidos con `/automod excluir`.
 */
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type Guild,
  type GuildMember,
  InteractionContextType,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { log } from "../../log.js";
import { getValue, setValue } from "../../store.js";
import type { Command, Feature, HealthCheck } from "../../types.js";
import { brandEmbed, ephemeral } from "../../ui.js";
import { warnMember } from "../moderation/index.js";
import { getServerLogChannelId } from "../serverLogs.js";
import { getRanks } from "../staff.js";
import { SlidingWindow, blockedLinks, hasInvite, parseDomainList } from "./logic.js";

const CONFIG_KEY = "automod";
// Después de advertir a alguien por spam, no se le vuelve a advertir por el mismo motivo durante este tiempo.
const WARN_COOLDOWN_MS = 30_000;
const RAID_ALERT_COOLDOWN_MS = 5 * 60_000;

interface AutomodConfig {
  spam?: { enabled: boolean; messages: number; seconds: number };
  links?: { enabled: boolean; allowed: string[] };
  invites?: { enabled: boolean };
  mentions?: { enabled: boolean; max: number };
  raid?: { enabled: boolean; joins: number; seconds: number };
  exemptChannels?: string[];
  exemptRoles?: string[];
}

const DEFAULTS = {
  spam: { messages: 5, seconds: 5 },
  mentions: { max: 5 },
  raid: { joins: 8, seconds: 30 },
};

const getConfig = (guildId: string): Promise<AutomodConfig> => getValue<AutomodConfig>(guildId, CONFIG_KEY, {});
const setConfig = (guildId: string, cfg: AutomodConfig): Promise<void> => setValue(guildId, CONFIG_KEY, cfg);

const messageWindow = new SlidingWindow();
const joinWindow = new SlidingWindow();
const lastWarned = new Map<string, number>();
const lastRaidAlert = new Map<string, number>();

async function isExempt(member: GuildMember, channelId: string, cfg: AutomodConfig): Promise<boolean> {
  if (member.user.bot) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (cfg.exemptChannels?.includes(channelId)) return true;
  if (cfg.exemptRoles?.some((id) => member.roles.cache.has(id))) return true;
  const ranks = await getRanks(member.guild);
  return ranks.some((r) => member.roles.cache.has(r.role));
}

/** Qué filtro salta con este mensaje (o null si ninguno). */
function violation(message: Message<true>, cfg: AutomodConfig): string | null {
  const text = message.content;
  if (cfg.invites?.enabled && hasInvite(text)) return "invitación a otro servidor";
  if (cfg.links?.enabled) {
    const blocked = blockedLinks(text, cfg.links.allowed);
    if (blocked.length > 0) return `link no permitido (${blocked[0]})`;
  }
  if (cfg.mentions?.enabled) {
    const count = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
    if (count > cfg.mentions.max) return `demasiadas menciones (${count})`;
  }
  if (cfg.spam?.enabled) {
    const hits = messageWindow.hit(`${message.guildId}:${message.author.id}`, cfg.spam.seconds * 1000);
    if (hits > cfg.spam.messages) return "spam (muchos mensajes seguidos)";
  }
  return null;
}

async function onMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const cfg = await getConfig(message.guildId);
  if (!cfg.spam?.enabled && !cfg.links?.enabled && !cfg.invites?.enabled && !cfg.mentions?.enabled) return;
  if (await isExempt(message.member, message.channelId, cfg)) return;

  const reason = violation(message, cfg);
  if (!reason) return;

  await message.delete().catch(() => {});
  const key = `${message.guildId}:${message.author.id}:${reason.split(" ")[0]}`;
  const now = Date.now();
  if (now - (lastWarned.get(key) ?? 0) < WARN_COOLDOWN_MS) return; // ya se le avisó por esto recién
  lastWarned.set(key, now);

  const notice = await message.channel
    .send({ content: `🛡️ <@${message.author.id}>, tu mensaje se borró: ${reason}.`, allowedMentions: { users: [message.author.id] } })
    .catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 8000);

  await warnMember(message.member, message.client.user.id, `Automod: ${reason}`, true).catch((err) =>
    log.error("automod", "No pude registrar la advertencia", err),
  );
  log.info("automod", `${message.author.tag} en ${message.guild.name}: ${reason}.`);
}

async function onJoin(member: GuildMember): Promise<void> {
  const cfg = await getConfig(member.guild.id);
  if (!cfg.raid?.enabled) return;
  const count = joinWindow.hit(member.guild.id, cfg.raid.seconds * 1000);
  if (count < cfg.raid.joins) return;
  const now = Date.now();
  if (now - (lastRaidAlert.get(member.guild.id) ?? 0) < RAID_ALERT_COOLDOWN_MS) return;
  lastRaidAlert.set(member.guild.id, now);

  log.warn("automod", `Posible raid en ${member.guild.name}: ${count} entradas en ${cfg.raid.seconds} s.`);
  const channelId = await getServerLogChannelId(member.guild.id);
  const channel = channelId ? await member.guild.channels.fetch(channelId).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const embed = (await brandEmbed(member.guild))
    .setColor(0xe74c3c)
    .setTitle("🚨 Posible raid")
    .setDescription(
      `Entraron **${count}** cuentas en menos de **${cfg.raid.seconds} segundos**.\n\n` +
        "Si es un ataque: subí el nivel de verificación del servidor (Ajustes → Seguridad), pausá las invitaciones y revisá las cuentas nuevas en este canal.",
    );
  await channel.send({ embeds: [embed] }).catch(() => {});
}

// ---------- comando ----------
const toggle = (desc: string) => (o: import("discord.js").SlashCommandBooleanOption) =>
  o.setName("activar").setDescription(desc).setRequired(true);

const automodCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Filtros automáticos de moderación")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("ver").setDescription("Muestra qué filtros están prendidos"))
    .addSubcommand((s) =>
      s
        .setName("spam")
        .setDescription("Muchos mensajes seguidos de la misma persona")
        .addBooleanOption(toggle("Prender o apagar"))
        .addIntegerOption((o) => o.setName("mensajes").setDescription(`Máximo de mensajes (por defecto ${DEFAULTS.spam.messages})`).setMinValue(2).setMaxValue(30))
        .addIntegerOption((o) => o.setName("segundos").setDescription(`En cuántos segundos (por defecto ${DEFAULTS.spam.seconds})`).setMinValue(1).setMaxValue(60)),
    )
    .addSubcommand((s) =>
      s
        .setName("links")
        .setDescription("Borra links, salvo los de dominios permitidos")
        .addBooleanOption(toggle("Prender o apagar"))
        .addStringOption((o) => o.setName("permitidos").setDescription("Dominios permitidos, ej: youtube.com, twitch.tv (reemplaza la lista)")),
    )
    .addSubcommand((s) =>
      s.setName("invitaciones").setDescription("Borra invitaciones a otros servidores de Discord").addBooleanOption(toggle("Prender o apagar")),
    )
    .addSubcommand((s) =>
      s
        .setName("menciones")
        .setDescription("Borra mensajes con muchas menciones")
        .addBooleanOption(toggle("Prender o apagar"))
        .addIntegerOption((o) => o.setName("maximo").setDescription(`Menciones permitidas por mensaje (por defecto ${DEFAULTS.mentions.max})`).setMinValue(1).setMaxValue(50)),
    )
    .addSubcommand((s) =>
      s
        .setName("raid")
        .setDescription("Avisa en /logs si entran muchas cuentas de golpe")
        .addBooleanOption(toggle("Prender o apagar"))
        .addIntegerOption((o) => o.setName("entradas").setDescription(`Cuántas entradas (por defecto ${DEFAULTS.raid.joins})`).setMinValue(3).setMaxValue(100))
        .addIntegerOption((o) => o.setName("segundos").setDescription(`En cuántos segundos (por defecto ${DEFAULTS.raid.seconds})`).setMinValue(5).setMaxValue(600)),
    )
    .addSubcommand((s) =>
      s
        .setName("excluir")
        .setDescription("Un canal o rol donde el automod no actúa (volvé a usarlo para sacarlo)")
        .addChannelOption((o) => o.setName("canal").setDescription("Canal a excluir").addChannelTypes(ChannelType.GuildText))
        .addRoleOption((o) => o.setName("rol").setDescription("Rol a excluir")),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();
    const cfg = await getConfig(guild.id);
    const on = interaction.options.getBoolean("activar") ?? false;
    const state = on ? "🟢 prendido" : "🔴 apagado";

    if (sub === "spam") {
      const messages = interaction.options.getInteger("mensajes") ?? cfg.spam?.messages ?? DEFAULTS.spam.messages;
      const seconds = interaction.options.getInteger("segundos") ?? cfg.spam?.seconds ?? DEFAULTS.spam.seconds;
      await setConfig(guild.id, { ...cfg, spam: { enabled: on, messages, seconds } });
      await interaction.reply(ephemeral(`✅ Filtro de spam ${state}: más de **${messages}** mensajes en **${seconds} s**.`));
      return;
    }
    if (sub === "links") {
      const text = interaction.options.getString("permitidos");
      const allowed = text !== null ? parseDomainList(text) : (cfg.links?.allowed ?? []);
      await setConfig(guild.id, { ...cfg, links: { enabled: on, allowed } });
      await interaction.reply(
        ephemeral(`✅ Filtro de links ${state}.\nPermitidos: ${allowed.length > 0 ? allowed.map((d) => `\`${d}\``).join(", ") : "ninguno (solo links de Discord)"}`),
      );
      return;
    }
    if (sub === "invitaciones") {
      await setConfig(guild.id, { ...cfg, invites: { enabled: on } });
      await interaction.reply(ephemeral(`✅ Filtro de invitaciones a otros servidores ${state}.`));
      return;
    }
    if (sub === "menciones") {
      const max = interaction.options.getInteger("maximo") ?? cfg.mentions?.max ?? DEFAULTS.mentions.max;
      await setConfig(guild.id, { ...cfg, mentions: { enabled: on, max } });
      await interaction.reply(ephemeral(`✅ Filtro de menciones ${state}: máximo **${max}** por mensaje.`));
      return;
    }
    if (sub === "raid") {
      const joins = interaction.options.getInteger("entradas") ?? cfg.raid?.joins ?? DEFAULTS.raid.joins;
      const seconds = interaction.options.getInteger("segundos") ?? cfg.raid?.seconds ?? DEFAULTS.raid.seconds;
      await setConfig(guild.id, { ...cfg, raid: { enabled: on, joins, seconds } });
      const noLogs = (await getServerLogChannelId(guild.id)) ? "" : "\n⚠️ Ojo: el aviso va al canal de `/logs`, y todavía no está configurado.";
      await interaction.reply(ephemeral(`✅ Alerta de raid ${state}: **${joins}** entradas en **${seconds} s**.${noLogs}`));
      return;
    }
    if (sub === "excluir") {
      const channel = interaction.options.getChannel("canal");
      const role = interaction.options.getRole("rol");
      if (!channel && !role) {
        await interaction.reply(ephemeral("⚠️ Elegí un canal o un rol."));
        return;
      }
      const flip = (list: string[] | undefined, id: string): [string[], boolean] => {
        const current = list ?? [];
        return current.includes(id) ? [current.filter((x) => x !== id), false] : [[...current, id], true];
      };
      const lines: string[] = [];
      let next = { ...cfg };
      if (channel) {
        const [list, added] = flip(cfg.exemptChannels, channel.id);
        next = { ...next, exemptChannels: list };
        lines.push(`${added ? "➕ Excluí" : "➖ Ya no excluyo"} el canal <#${channel.id}>`);
      }
      if (role) {
        const [list, added] = flip(cfg.exemptRoles, role.id);
        next = { ...next, exemptRoles: list };
        lines.push(`${added ? "➕ Excluí" : "➖ Ya no excluyo"} el rol <@&${role.id}>`);
      }
      await setConfig(guild.id, next);
      await interaction.reply(ephemeral(`✅ ${lines.join("\n")}`));
      return;
    }

    // sub === "ver"
    const dot = (enabled: boolean | undefined) => (enabled ? "🟢" : "🔴");
    const embed = (await brandEmbed(guild)).setTitle("🛡️ Automod").setDescription(
      `${dot(cfg.spam?.enabled)} **Spam** — más de ${cfg.spam?.messages ?? DEFAULTS.spam.messages} mensajes en ${cfg.spam?.seconds ?? DEFAULTS.spam.seconds} s\n` +
        `${dot(cfg.links?.enabled)} **Links** — permitidos: ${cfg.links?.allowed.length ? cfg.links.allowed.join(", ") : "ninguno"}\n` +
        `${dot(cfg.invites?.enabled)} **Invitaciones** a otros servidores\n` +
        `${dot(cfg.mentions?.enabled)} **Menciones** — máximo ${cfg.mentions?.max ?? DEFAULTS.mentions.max} por mensaje\n` +
        `${dot(cfg.raid?.enabled)} **Raid** — ${cfg.raid?.joins ?? DEFAULTS.raid.joins} entradas en ${cfg.raid?.seconds ?? DEFAULTS.raid.seconds} s\n\n` +
        `**Excluidos:** ${[...(cfg.exemptChannels ?? []).map((id) => `<#${id}>`), ...(cfg.exemptRoles ?? []).map((id) => `<@&${id}>`)].join(" ") || "ninguno"}\n` +
        "*Nunca actúa sobre bots, admins, quien puede gestionar mensajes ni los rangos de staff.*",
    );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  const active = [
    cfg.spam?.enabled && "spam",
    cfg.links?.enabled && "links",
    cfg.invites?.enabled && "invitaciones",
    cfg.mentions?.enabled && "menciones",
    cfg.raid?.enabled && "raid",
  ].filter(Boolean);
  if (active.length === 0) return { label: "Automod", ok: true, detail: "todos los filtros apagados (`/automod ver`)" };
  const missing = guild.members.me?.permissions.missing([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers]) ?? [];
  if (missing.length > 0) return { label: "Automod", ok: false, detail: `me faltan permisos: ${missing.join(", ")}` };
  return { label: "Automod", ok: true, detail: `prendido: ${active.join(", ")}` };
}

export const automod: Feature = {
  name: "automod",
  commands: [automodCommand],
  checkHealth,
  register(client: Client): void {
    client.on(Events.MessageCreate, (message) => {
      onMessage(message).catch((err) => log.error("automod", "Error revisando un mensaje", err));
    });
    client.on(Events.GuildMemberAdd, (member) => {
      onJoin(member).catch((err) => log.error("automod", "Error revisando una entrada", err));
    });
    setInterval(() => {
      messageWindow.prune(60_000);
      joinWindow.prune(10 * 60_000);
    }, 60_000).unref();
  },
};
