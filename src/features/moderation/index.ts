/**
 * Moderación con historial: /warn, /mute, /unmute, /kick, /ban, /unban, /historial y
 * /sancion quitar. Cada sanción queda como un "caso" numerado por servidor.
 *
 * - Quién puede usar cada comando lo deciden los permisos de Discord (Moderar miembros,
 *   Expulsar, Banear), que cada servidor ajusta en Ajustes → Integraciones.
 * - Escala automática: al llegar a cierta cantidad de warns, el bot aplica una sanción sola
 *   (por defecto 3 warns → 1 h de mute, 5 → 1 día). Se configura con `/moderacion escala`.
 * - El automod (automod.ts) usa `warnMember` para que sus avisos también cuenten.
 */
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type User,
} from "discord.js";
import { channelProblem } from "../../health.js";
import { log } from "../../log.js";
import { getValue, setValue } from "../../store.js";
import type { Command, Feature, HealthCheck } from "../../types.js";
import { brandEmbed, ephemeral, serverName } from "../../ui.js";
import { getServerLogChannelId } from "../serverLogs.js";
import {
  type CaseType,
  DEFAULT_ESCALATION,
  type EscalationAction,
  type EscalationStep,
  MAX_TIMEOUT_MS,
  type ModCase,
  activeWarns,
  escalationFor,
  formatDuration,
  parseDuration,
} from "./logic.js";

const CASES_KEY = "modCases";
const CONFIG_KEY = "moderation";

interface CasesStore {
  nextId: number;
  cases: ModCase[];
}

interface ModerationConfig {
  logChannelId?: string;
  /** Si no está, se usa DEFAULT_ESCALATION. */
  escalation?: EscalationStep[];
}

const getCases = (guildId: string): Promise<CasesStore> => getValue<CasesStore>(guildId, CASES_KEY, { nextId: 1, cases: [] });
const getConfig = (guildId: string): Promise<ModerationConfig> => getValue<ModerationConfig>(guildId, CONFIG_KEY, {});
const getEscalation = async (guildId: string): Promise<readonly EscalationStep[]> =>
  (await getConfig(guildId)).escalation ?? DEFAULT_ESCALATION;

const CASE_LABEL: Record<CaseType, string> = {
  warn: "⚠️ Advertencia",
  mute: "🔇 Mute",
  unmute: "🔊 Desmute",
  kick: "👢 Expulsión",
  ban: "🔨 Baneo",
  unban: "🕊️ Desbaneo",
};
const CASE_COLOR: Record<CaseType, number> = {
  warn: 0xf1c40f,
  mute: 0xe67e22,
  unmute: 0x2ecc71,
  kick: 0xe74c3c,
  ban: 0x992d22,
  unban: 0x2ecc71,
};
// Qué se le dice a la persona por DM.
const DM_VERB: Partial<Record<CaseType, string>> = {
  warn: "Recibiste una advertencia",
  mute: "Te silenciaron",
  kick: "Te expulsaron",
  ban: "Te banearon",
};

async function addCase(guild: Guild, data: Omit<ModCase, "id" | "at">): Promise<ModCase> {
  const store = await getCases(guild.id);
  const entry: ModCase = { ...data, id: store.nextId, at: Date.now() };
  store.nextId += 1;
  store.cases.push(entry);
  await setValue(guild.id, CASES_KEY, store);
  return entry;
}

async function logCase(guild: Guild, c: ModCase, extra?: string): Promise<void> {
  const channelId = (await getConfig(guild.id)).logChannelId ?? (await getServerLogChannelId(guild.id));
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const embed = (await brandEmbed(guild))
    .setColor(CASE_COLOR[c.type])
    .setTitle(`${CASE_LABEL[c.type]} · caso #${c.id}`)
    .setDescription(
      `**Usuario:** <@${c.userId}> (${c.userId})\n` +
        `**Moderador:** ${c.auto ? "🤖 automático" : `<@${c.moderatorId}>`}\n` +
        (c.durationMs ? `**Duración:** ${formatDuration(c.durationMs)}\n` : "") +
        `**Motivo:** ${c.reason}` +
        (extra ? `\n\n${extra}` : ""),
    );
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

/** Le avisa a la persona por DM. Hay que llamarlo ANTES de expulsar/banear (después ya no se puede). */
async function notifyUser(guild: Guild, user: User, c: Pick<ModCase, "type" | "reason" | "durationMs">): Promise<boolean> {
  const verb = DM_VERB[c.type];
  if (!verb) return false;
  const embed = (await brandEmbed(guild))
    .setColor(CASE_COLOR[c.type])
    .setTitle(`${CASE_LABEL[c.type]} en ${await serverName(guild)}`)
    .setDescription(`${verb}.\n**Motivo:** ${c.reason}${c.durationMs ? `\n**Duración:** ${formatDuration(c.durationMs)}` : ""}`);
  return user
    .send({ embeds: [embed] })
    .then(() => true)
    .catch(() => false);
}

/** Por qué `actor` no puede sancionar a `target`, o null si puede. */
function hierarchyProblem(actor: GuildMember, target: GuildMember): string | null {
  if (target.id === actor.id) return "No podés sancionarte a vos mismo.";
  if (target.id === target.guild.ownerId) return "No se puede sancionar al dueño del servidor.";
  if (target.id === target.client.user.id) return "No me puedo sancionar a mí mismo.";
  if (actor.id !== actor.guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) {
    return "Esa persona tiene un rol igual o más alto que el tuyo.";
  }
  return null;
}

const BOT_TOO_LOW = "No puedo: su rol está por encima del mío (o me falta el permiso). Subí mi rol en Ajustes → Roles.";

/** Aplica una sanción de Discord. Devuelve el error para mostrar, o null si salió bien. */
async function applyAction(
  member: GuildMember,
  action: EscalationAction | "unmute",
  reason: string,
  durationMs?: number,
): Promise<string | null> {
  try {
    if (action === "mute") {
      if (!member.moderatable) return BOT_TOO_LOW;
      await member.timeout(Math.min(durationMs ?? 60 * 60 * 1000, MAX_TIMEOUT_MS), reason);
    } else if (action === "unmute") {
      if (!member.moderatable) return BOT_TOO_LOW;
      await member.timeout(null, reason);
    } else if (action === "kick") {
      if (!member.kickable) return BOT_TOO_LOW;
      await member.kick(reason);
    } else {
      if (!member.bannable) return BOT_TOO_LOW;
      await member.ban({ reason });
    }
    return null;
  } catch (err) {
    log.error("moderacion", `No pude aplicar ${action} a ${member.user.tag} en ${member.guild.name}`, err);
    return `Discord no me dejó hacerlo (${(err as Error).message}).`;
  }
}

/**
 * Advierte a un miembro y, si con eso llega a un paso de la escala, aplica la sanción automática.
 * Lo usan /warn y el automod. Devuelve el caso y, si hubo, una línea sobre la sanción automática.
 */
export async function warnMember(
  member: GuildMember,
  moderatorId: string,
  reason: string,
  auto = false,
): Promise<{ case: ModCase; warns: number; escalation: string | null }> {
  const guild = member.guild;
  await notifyUser(guild, member.user, { type: "warn", reason });
  const warnCase = await addCase(guild, { type: "warn", userId: member.id, moderatorId, reason, auto });
  const warns = activeWarns((await getCases(guild.id)).cases, member.id);

  const step = escalationFor(await getEscalation(guild.id), warns);
  let escalation: string | null = null;
  if (step) {
    const autoReason = `Sanción automática por llegar a ${warns} advertencias`;
    await notifyUser(guild, member.user, { type: step.action, reason: autoReason, durationMs: step.durationMs });
    const problem = await applyAction(member, step.action, autoReason, step.durationMs);
    if (problem) {
      escalation = `⚠️ Le correspondía ${CASE_LABEL[step.action]} automático, pero: ${problem}`;
    } else {
      const autoCase = await addCase(guild, {
        type: step.action,
        userId: member.id,
        moderatorId: guild.client.user.id,
        reason: autoReason,
        durationMs: step.durationMs,
        auto: true,
      });
      await logCase(guild, autoCase);
      escalation = `${CASE_LABEL[step.action]} automático${step.durationMs ? ` de ${formatDuration(step.durationMs)}` : ""} (caso #${autoCase.id}).`;
    }
  }
  await logCase(guild, warnCase, `Advertencias vigentes: **${warns}**${escalation ? `\n${escalation}` : ""}`);
  return { case: warnCase, warns, escalation };
}

// ---------- comandos ----------
const userOption = (desc: string) => (o: import("discord.js").SlashCommandUserOption) =>
  o.setName("usuario").setDescription(desc).setRequired(true);
const reasonOption = (required: boolean) => (o: import("discord.js").SlashCommandStringOption) =>
  o.setName("motivo").setDescription("Por qué").setRequired(required).setMaxLength(500);

/** Busca al miembro objetivo y valida jerarquías. Responde y devuelve null si no se puede. */
async function targetMember(interaction: ChatInputCommandInteraction): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  const user = interaction.options.getUser("usuario", true);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.reply(ephemeral("⚠️ Esa persona no está en el servidor."));
    return null;
  }
  const problem = hierarchyProblem(interaction.member as GuildMember, member);
  if (problem) {
    await interaction.reply(ephemeral(`⚠️ ${problem}`));
    return null;
  }
  return member;
}

function modCommand(
  name: string,
  description: string,
  permission: bigint,
  build: (b: SlashCommandBuilder) => unknown,
  execute: (interaction: ChatInputCommandInteraction, guild: Guild) => Promise<void>,
): Command {
  const builder = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(permission);
  build(builder);
  return {
    data: builder.toJSON(),
    async execute(interaction) {
      if (!interaction.guild) return;
      await execute(interaction, interaction.guild);
    },
  };
}

const warnCommand = modCommand(
  "warn",
  "Le da una advertencia a alguien (queda en su historial)",
  PermissionFlagsBits.ModerateMembers,
  (b) => b.addUserOption(userOption("A quién")).addStringOption(reasonOption(true)),
  async (interaction) => {
    const member = await targetMember(interaction);
    if (!member) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString("motivo", true);
    const result = await warnMember(member, interaction.user.id, reason);
    await interaction.editReply(
      `✅ Advertí a <@${member.id}> (caso #${result.case.id}). Lleva **${result.warns}** advertencia(s) vigente(s).` +
        (result.escalation ? `\n${result.escalation}` : ""),
    );
  },
);

const muteCommand = modCommand(
  "mute",
  "Silencia a alguien por un tiempo (timeout de Discord)",
  PermissionFlagsBits.ModerateMembers,
  (b) =>
    b
      .addUserOption(userOption("A quién"))
      .addStringOption((o) => o.setName("duracion").setDescription("Cuánto: 10m, 1h, 2d, 1h30m (máx. 28d)").setRequired(true))
      .addStringOption(reasonOption(true)),
  async (interaction, guild) => {
    const durationMs = parseDuration(interaction.options.getString("duracion", true));
    if (!durationMs) {
      await interaction.reply(ephemeral("⚠️ No entendí la duración. Usá algo como `10m`, `1h`, `2d` o `1h30m`."));
      return;
    }
    if (durationMs > MAX_TIMEOUT_MS) {
      await interaction.reply(ephemeral("⚠️ Discord deja silenciar como mucho 28 días."));
      return;
    }
    const member = await targetMember(interaction);
    if (!member) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString("motivo", true);
    await notifyUser(guild, member.user, { type: "mute", reason, durationMs });
    const problem = await applyAction(member, "mute", reason, durationMs);
    if (problem) {
      await interaction.editReply(`⚠️ ${problem}`);
      return;
    }
    const c = await addCase(guild, { type: "mute", userId: member.id, moderatorId: interaction.user.id, reason, durationMs });
    await logCase(guild, c);
    await interaction.editReply(`✅ Silencié a <@${member.id}> por ${formatDuration(durationMs)} (caso #${c.id}).`);
  },
);

const unmuteCommand = modCommand(
  "unmute",
  "Le saca el silencio a alguien",
  PermissionFlagsBits.ModerateMembers,
  (b) => b.addUserOption(userOption("A quién")).addStringOption(reasonOption(false)),
  async (interaction, guild) => {
    const member = await targetMember(interaction);
    if (!member) return;
    if (!member.isCommunicationDisabled()) {
      await interaction.reply(ephemeral("Esa persona no está silenciada."));
      return;
    }
    const reason = interaction.options.getString("motivo") ?? "Sin motivo";
    const problem = await applyAction(member, "unmute", reason);
    if (problem) {
      await interaction.reply(ephemeral(`⚠️ ${problem}`));
      return;
    }
    const c = await addCase(guild, { type: "unmute", userId: member.id, moderatorId: interaction.user.id, reason });
    await logCase(guild, c);
    await interaction.reply(ephemeral(`✅ <@${member.id}> ya puede hablar (caso #${c.id}).`));
  },
);

const kickCommand = modCommand(
  "kick",
  "Expulsa a alguien del servidor (puede volver con una invitación)",
  PermissionFlagsBits.KickMembers,
  (b) => b.addUserOption(userOption("A quién")).addStringOption(reasonOption(true)),
  async (interaction, guild) => {
    const member = await targetMember(interaction);
    if (!member) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString("motivo", true);
    if (!member.kickable) {
      await interaction.editReply(`⚠️ ${BOT_TOO_LOW}`);
      return;
    }
    const dm = await notifyUser(guild, member.user, { type: "kick", reason });
    const problem = await applyAction(member, "kick", reason);
    if (problem) {
      await interaction.editReply(`⚠️ ${problem}`);
      return;
    }
    const c = await addCase(guild, { type: "kick", userId: member.id, moderatorId: interaction.user.id, reason });
    await logCase(guild, c);
    await interaction.editReply(`✅ Expulsé a **${member.user.tag}** (caso #${c.id}).${dm ? "" : " No le pude avisar por DM."}`);
  },
);

const banCommand = modCommand(
  "ban",
  "Banea a alguien del servidor",
  PermissionFlagsBits.BanMembers,
  (b) =>
    b
      .addUserOption((o) => o.setName("usuario").setDescription("A quién (puede no estar en el servidor)").setRequired(true))
      .addStringOption(reasonOption(true))
      .addIntegerOption((o) =>
        o.setName("borrar_mensajes").setDescription("Borrar sus mensajes de las últimas X horas (0 a 168)").setMinValue(0).setMaxValue(168),
      ),
  async (interaction, guild) => {
    const user = interaction.options.getUser("usuario", true);
    const reason = interaction.options.getString("motivo", true);
    const hours = interaction.options.getInteger("borrar_mensajes") ?? 0;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) {
      const problem = hierarchyProblem(interaction.member as GuildMember, member);
      if (problem) {
        await interaction.reply(ephemeral(`⚠️ ${problem}`));
        return;
      }
      if (!member.bannable) {
        await interaction.reply(ephemeral(`⚠️ ${BOT_TOO_LOW}`));
        return;
      }
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dm = member ? await notifyUser(guild, user, { type: "ban", reason }) : false;
    try {
      await guild.bans.create(user.id, { reason, deleteMessageSeconds: hours * 3600 });
    } catch (err) {
      await interaction.editReply(`⚠️ Discord no me dejó banearlo (${(err as Error).message}).`);
      return;
    }
    const c = await addCase(guild, { type: "ban", userId: user.id, moderatorId: interaction.user.id, reason });
    await logCase(guild, c);
    await interaction.editReply(`✅ Baneé a **${user.tag}** (caso #${c.id}).${member && !dm ? " No le pude avisar por DM." : ""}`);
  },
);

const unbanCommand = modCommand(
  "unban",
  "Le saca el baneo a alguien",
  PermissionFlagsBits.BanMembers,
  (b) =>
    b
      .addStringOption((o) => o.setName("usuario_id").setDescription("ID de la persona baneada").setRequired(true))
      .addStringOption(reasonOption(false)),
  async (interaction, guild) => {
    const id = interaction.options.getString("usuario_id", true).trim();
    const reason = interaction.options.getString("motivo") ?? "Sin motivo";
    const ban = await guild.bans.fetch(id).catch(() => null);
    if (!ban) {
      await interaction.reply(ephemeral("⚠️ No encontré a nadie baneado con ese ID."));
      return;
    }
    await guild.bans.remove(id, reason);
    const c = await addCase(guild, { type: "unban", userId: id, moderatorId: interaction.user.id, reason });
    await logCase(guild, c);
    await interaction.reply(ephemeral(`✅ Desbaneé a **${ban.user.tag}** (caso #${c.id}).`));
  },
);

const historyCommand = modCommand(
  "historial",
  "Muestra las sanciones de alguien",
  PermissionFlagsBits.ModerateMembers,
  (b) => b.addUserOption(userOption("De quién")),
  async (interaction, guild) => {
    const user = interaction.options.getUser("usuario", true);
    const cases = (await getCases(guild.id)).cases.filter((c) => c.userId === user.id);
    const warns = activeWarns(cases, user.id);
    const lines = cases
      .slice(-15)
      .reverse()
      .map(
        (c) =>
          `${c.removed ? "~~" : ""}\`#${c.id}\` ${CASE_LABEL[c.type]}${c.durationMs ? ` (${formatDuration(c.durationMs)})` : ""} — ${c.reason} — ` +
          `${c.auto ? "🤖" : `<@${c.moderatorId}>`} <t:${Math.floor(c.at / 1000)}:d>${c.removed ? "~~ *(anulada)*" : ""}`,
      );
    const embed = (await brandEmbed(guild))
      .setTitle(`📒 Historial de ${user.tag}`)
      .setThumbnail(user.displayAvatarURL())
      .setDescription(
        cases.length === 0
          ? "No tiene sanciones. ✨"
          : `**Advertencias vigentes:** ${warns}\n**Total de casos:** ${cases.length}${cases.length > 15 ? " (mostrando los últimos 15)" : ""}\n\n${lines.join("\n")}`,
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
);

const caseCommand = modCommand(
  "sancion",
  "Gestionar casos de moderación",
  PermissionFlagsBits.ModerateMembers,
  (b) =>
    b.addSubcommand((s) =>
      s
        .setName("quitar")
        .setDescription("Anula una sanción (queda tachada en el historial y deja de contar)")
        .addIntegerOption((o) => o.setName("caso").setDescription("Número de caso").setRequired(true).setMinValue(1))
        .addStringOption(reasonOption(false)),
    ),
  async (interaction, guild) => {
    const id = interaction.options.getInteger("caso", true);
    const store = await getCases(guild.id);
    const c = store.cases.find((x) => x.id === id);
    if (!c) {
      await interaction.reply(ephemeral(`⚠️ No existe el caso #${id}.`));
      return;
    }
    if (c.removed) {
      await interaction.reply(ephemeral(`El caso #${id} ya estaba anulado.`));
      return;
    }
    c.removed = true;
    await setValue(guild.id, CASES_KEY, store);
    const reason = interaction.options.getString("motivo") ?? "Sin motivo";
    await logCase(guild, c, `🗑️ **Anulado por** <@${interaction.user.id}>: ${reason}`);
    const extra =
      c.type === "mute" || c.type === "ban"
        ? `\nℹ️ Esto solo lo saca del historial: para levantar la sanción usá \`/${c.type === "mute" ? "unmute" : "unban"}\`.`
        : "";
    await interaction.reply(ephemeral(`✅ Anulé el caso #${id} (${CASE_LABEL[c.type]} a <@${c.userId}>).${extra}`));
  },
);

const ACTION_CHOICES = [
  { name: "Mute", value: "mute" },
  { name: "Expulsión", value: "kick" },
  { name: "Baneo", value: "ban" },
] as const;

const configCommand = modCommand(
  "moderacion",
  "Configuración de la moderación",
  PermissionFlagsBits.ManageGuild,
  (b) =>
    b
      .addSubcommand((s) =>
        s
          .setName("config")
          .setDescription("Canal donde se registran las sanciones (por defecto, el de /logs)")
          .addChannelOption((o) => o.setName("canal").setDescription("Canal de staff").addChannelTypes(ChannelType.GuildText).setRequired(true)),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("escala")
          .setDescription("Sanciones automáticas por cantidad de advertencias")
          .addSubcommand((s) => s.setName("ver").setDescription("Muestra la escala actual"))
          .addSubcommand((s) =>
            s
              .setName("agregar")
              .setDescription("Al llegar a X advertencias, aplica una sanción sola")
              .addIntegerOption((o) => o.setName("advertencias").setDescription("Cantidad").setRequired(true).setMinValue(1).setMaxValue(50))
              .addStringOption((o) =>
                o.setName("accion").setDescription("Qué hacer").setRequired(true).addChoices(...ACTION_CHOICES),
              )
              .addStringOption((o) => o.setName("duracion").setDescription("Solo para mute: 1h, 1d… (por defecto 1h)")),
          )
          .addSubcommand((s) =>
            s
              .setName("quitar")
              .setDescription("Saca un paso de la escala")
              .addIntegerOption((o) => o.setName("advertencias").setDescription("Cantidad del paso").setRequired(true).setMinValue(1)),
          ),
      ),
  async (interaction, guild) => {
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    const cfg = await getConfig(guild.id);

    if (sub === "config") {
      const canal = interaction.options.getChannel("canal", true);
      await setValue(guild.id, CONFIG_KEY, { ...cfg, logChannelId: canal.id } satisfies ModerationConfig);
      const problem = await channelProblem(guild, canal.id);
      await interaction.reply(ephemeral(`✅ Las sanciones se van a registrar en <#${canal.id}>.${problem ? `\n\n⚠️ Ojo: ${problem}.` : ""}`));
      return;
    }

    if (group !== "escala") return;
    const steps = [...(cfg.escalation ?? DEFAULT_ESCALATION)];
    const describe = (s: EscalationStep) =>
      `**${s.warns}** advertencias → ${CASE_LABEL[s.action]}${s.action === "mute" && s.durationMs ? ` de ${formatDuration(s.durationMs)}` : ""}`;

    if (sub === "ver") {
      await interaction.reply(
        ephemeral(
          steps.length === 0
            ? "No hay sanciones automáticas: las advertencias solo quedan en el historial."
            : `⚖️ **Escala de sanciones automáticas**\n${steps.map(describe).join("\n")}`,
        ),
      );
      return;
    }

    const warns = interaction.options.getInteger("advertencias", true);
    const others = steps.filter((s) => s.warns !== warns);
    if (sub === "quitar") {
      if (others.length === steps.length) {
        await interaction.reply(ephemeral(`No hay ningún paso en ${warns} advertencias.`));
        return;
      }
      await setValue(guild.id, CONFIG_KEY, { ...cfg, escalation: others } satisfies ModerationConfig);
      await interaction.reply(ephemeral(`✅ Saqué el paso de ${warns} advertencias.`));
      return;
    }

    // sub === "agregar"
    const action = interaction.options.getString("accion", true) as EscalationAction;
    const durationText = interaction.options.getString("duracion");
    let durationMs: number | undefined;
    if (action === "mute") {
      durationMs = durationText ? (parseDuration(durationText) ?? undefined) : 60 * 60 * 1000;
      if (!durationMs || durationMs > MAX_TIMEOUT_MS) {
        await interaction.reply(ephemeral("⚠️ Duración inválida. Usá algo como `1h` o `2d` (máximo 28d)."));
        return;
      }
    }
    const step: EscalationStep = { warns, action, durationMs };
    const updated = [...others, step].sort((a, b) => a.warns - b.warns);
    await setValue(guild.id, CONFIG_KEY, { ...cfg, escalation: updated } satisfies ModerationConfig);
    await interaction.reply(ephemeral(`✅ Listo: ${describe(step)}.\n\n⚖️ **Escala actual**\n${updated.map(describe).join("\n")}`));
  },
);

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  const channelId = cfg.logChannelId ?? (await getServerLogChannelId(guild.id));
  const me = guild.members.me;
  const missing = me?.permissions.missing([PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers]) ?? [];
  if (missing.length > 0) {
    return { label: "Moderación", ok: false, detail: `me faltan permisos: ${missing.join(", ")} (Moderar miembros, Expulsar, Banear)` };
  }
  if (!channelId) return { label: "Moderación", ok: false, detail: "no hay dónde registrar las sanciones (falta `/moderacion config` o `/logs config`)" };
  const problem = await channelProblem(guild, channelId);
  if (problem) return { label: "Moderación", ok: false, detail: problem };
  const steps = cfg.escalation ?? DEFAULT_ESCALATION;
  return { label: "Moderación", ok: true, detail: `registro en <#${channelId}>, ${steps.length} paso(s) de sanción automática` };
}

export const moderation: Feature = {
  name: "moderation",
  commands: [warnCommand, muteCommand, unmuteCommand, kickCommand, banCommand, unbanCommand, historyCommand, caseCommand, configCommand],
  checkHealth,
  register(): void {
    /* solo comandos */
  },
};
