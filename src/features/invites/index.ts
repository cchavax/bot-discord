/**
 * Sistema 4: invitaciones. Cuenta invitados VERIFICADOS por persona (ver `creditVerifiedInvite`,
 * que llama `verification.ts` cuando alguien se verifica). Al llegar a un hito
 * (src/features/invites/milestones.ts) se le manda un DM con un botón de "Reclamar"; al tocarlo,
 * se avisa en el canal configurado con `/invitaciones config` para que el staff entregue la
 * recompensa a mano (todavía no hay vínculo con el juego).
 */
import {
  ActionRowBuilder,
  type ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
  Events,
  type Guild,
  type GuildMember,
  type Interaction,
  InteractionContextType,
  type Message,
  type PartialGuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { channelProblem, guildPermissionProblem } from "../../health.js";
import { log } from "../../log.js";
import { getValue, setValue } from "../../store.js";
import type { Command, Feature, HealthCheck } from "../../types.js";
import { brandEmbed, ephemeral, serverName } from "../../ui.js";
import { type InviteMilestone, type InviteSnapshot, detectUsedInvite, milestonesReached } from "./logic.js";
import { INVITE_MILESTONES } from "./milestones.js";

const CONFIG_KEY = "invites";
const CLAIM_BUTTON_PREFIX = "invites:claim:";
// Discord tarda un toque en actualizar el contador de usos de la invitación: esperamos antes de comparar.
const DETECTION_DELAY_MS = 2000;

interface InviterStats {
  count: number;
  claimed: number[];
}

interface InvitesData {
  inviters: Record<string, InviterStats>;
  /** inviteeId -> inviterId, hasta que la persona se verifique (ahí suma) o se vaya (ahí se descarta). */
  pendingByInvitee: Record<string, string>;
  /** inviteeId -> aviso de ingreso en el canal de invitaciones, para actualizarlo cuando se verifica o se va. */
  joinMessages?: Record<string, { channelId: string; messageId: string }>;
  /** Canal donde se avisan los ingresos, verificaciones y reclamos. Se define con `/invitaciones config`. */
  logChannelId?: string;
  /** Dónde quedó fijado el top de invitadores, para poder editarlo solo cuando cambian los números. */
  topPanel?: { channelId: string; messageId: string };
}

const MILESTONES_KEY = "inviteMilestones";
const INVITES_FOOTER = "Sistema de Invitaciones";
const GIVEAWAY_EMOJI = "<a:giveaway:1565385637706862644>";
const GIFT_EMOJI = "<:gift:1565168105997471815>";
const MILESTONE_COLOR = 0xe74c3c;

// Emojis de los avisos (del servidor de Aura). Cuando se defina el set fijo, se cambian acá.
const EMOJI = {
  pending: "<:yellow_dot:1565178090987200543>",
  confirmed: "<:green_dot:1565177981855465566>",
  discarded: "<:red_dot:1565178036309983234>",
  member: "<:19492membres:1565184515293581492>",
  link: "<:50494lien:1565184903060914337>",
  verified: "<a:black_verification:1565149595007189052>",
  stats: "<:41378statistiques:1565184690808168478>",
  left: "<:80091fermer:1565185305902977064>",
  unknown: "<:34996chercher:1565184593450246154>",
};

const plural = (n: number) => `**${n}** invitado${n === 1 ? "" : "s"} verificado${n === 1 ? "" : "s"}`;

/** Un aviso del canal de invitaciones: va en un embed con el color de su estado. */
export interface Notice {
  title: string;
  description: string;
  color: number;
  /** Quien entró: su foto va de miniatura. */
  memberId: string;
}

const COLOR = { pending: 0xf1c40f, confirmed: 0x2ecc71, discarded: 0xe74c3c, unknown: 0x95a5a6 };
export const NOTICE_FOOTER = "Sistema de Invitaciones";

// Espacio ancho entre el emoji y el texto: Discord junta los espacios comunes.
const heading = (emoji: string, text: string) => `${emoji} ${text}`;

/** Textos de los avisos del canal de invitaciones (exportados para poder previsualizarlos). */
export const notice = {
  unknown: (memberId: string, reason: string): Notice => ({
    title: heading(EMOJI.unknown, "Nuevo ingreso · invitación desconocida"),
    description: `<@${memberId}> entró, pero no pude saber con qué invitación (${reason}). No suma para nadie.`,
    color: COLOR.unknown,
    memberId,
  }),
  pending: (memberId: string, inviterId: string, count: number): Notice => ({
    title: heading(EMOJI.pending, "Invitación pendiente"),
    description:
      `${EMOJI.member} <@${memberId}> entró con la invitación de <@${inviterId}>.\n\n` +
      `${EMOJI.link} Todavía **no suma**: cuenta recién cuando se verifique. Por ahora <@${inviterId}> tiene ${plural(count)}.`,
    color: COLOR.pending,
    memberId,
  }),
  confirmed: (memberId: string, inviterId: string, count: number): Notice => ({
    title: heading(EMOJI.confirmed, "Invitación confirmada"),
    description:
      `${EMOJI.verified} <@${memberId}> se verificó, así que ya cuenta para <@${inviterId}>.\n\n` +
      `${EMOJI.stats} <@${inviterId}> ahora tiene ${plural(count)}.`,
    color: COLOR.confirmed,
    memberId,
  }),
  discarded: (memberId: string, inviterId: string): Notice => ({
    title: heading(EMOJI.discarded, "Invitación descartada"),
    description: `${EMOJI.left} <@${memberId}> se fue sin verificarse, así que no cuenta para <@${inviterId}>.`,
    color: COLOR.discarded,
    memberId,
  }),
};

/** El embed de un aviso: color de su estado, foto de quien entró y pie del sistema con la foto del bot. */
export async function noticeEmbed(guild: Guild, n: Notice): Promise<EmbedBuilder> {
  const embed = (await brandEmbed(guild))
    .setColor(n.color)
    .setTitle(n.title)
    .setDescription(n.description)
    .setFooter({ text: NOTICE_FOOTER, iconURL: guild.client.user.displayAvatarURL() });
  // Funciona aunque ya se haya ido del servidor (se busca el usuario, no el miembro).
  const user = await guild.client.users.fetch(n.memberId).catch(() => null);
  if (user) embed.setThumbnail(user.displayAvatarURL({ size: 256 }));
  return embed;
}

/** Hitos del servidor (de menor a mayor). Si no configuró los suyos, los de milestones.ts. */
export async function getMilestones(guildId: string): Promise<readonly InviteMilestone[]> {
  const custom = await getValue<InviteMilestone[] | null>(guildId, MILESTONES_KEY, null);
  return custom ?? INVITE_MILESTONES;
}

const getData = (guildId: string): Promise<InvitesData> =>
  getValue<InvitesData>(guildId, CONFIG_KEY, { inviters: {}, pendingByInvitee: {} });
const setData = (guildId: string, data: InvitesData): Promise<void> => setValue(guildId, CONFIG_KEY, data);

// En memoria: último estado de invitaciones conocido por servidor, para detectar cuál se usó al entrar alguien.
const inviteCache = new Map<string, InviteSnapshot[]>();
// Si entran dos personas casi juntas, se procesan de a una (si no, las dos comparan contra la misma foto).
const joinQueues = new Map<string, Promise<void>>();

async function snapshotInvites(guild: Guild): Promise<InviteSnapshot[]> {
  const invites = await guild.invites.fetch().catch((err) => {
    log.warn("invitaciones", `No pude leer las invitaciones de ${guild.name} (¿me falta "Gestionar servidor"?): ${(err as Error).message}`);
    return null;
  });
  if (!invites) return [];
  return [...invites.values()].map((i) => ({ code: i.code, uses: i.uses ?? 0, inviterId: i.inviter?.id, maxUses: i.maxUses ?? 0 }));
}

async function refreshCache(guild: Guild): Promise<void> {
  inviteCache.set(guild.id, await snapshotInvites(guild));
}

async function sendToLog(guild: Guild, message: string | Notice): Promise<Message | null> {
  const data = await getData(guild.id);
  if (!data.logChannelId) return null;
  const logChannel = await guild.channels.fetch(data.logChannelId).catch(() => null);
  if (!logChannel || logChannel.type !== ChannelType.GuildText) return null;
  const body = typeof message === "string" ? { content: message } : { embeds: [await noticeEmbed(guild, message)] };
  // Las menciones se ven pero no notifican: es un canal de registro.
  return logChannel.send({ ...body, allowedMentions: { parse: [] } }).catch(() => null);
}

/**
 * Reescribe el aviso de ingreso de alguien (al verificarse o irse). Si ya no se puede editar
 * (se borró, o el ingreso es de antes de guardar los avisos), lo manda como mensaje nuevo.
 */
async function updateJoinMessage(guild: Guild, data: InvitesData, inviteeId: string, n: Notice): Promise<void> {
  const ref = data.joinMessages?.[inviteeId];
  if (ref) {
    delete data.joinMessages?.[inviteeId];
    const channel = await guild.channels.fetch(ref.channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      // content: null borra el texto de los avisos viejos (de antes de los embeds).
      const edited = await channel.messages
        .edit(ref.messageId, { content: null, embeds: [await noticeEmbed(guild, n)] })
        .catch(() => null);
      if (edited) return;
    }
  }
  await sendToLog(guild, n);
}

/** IDs de quienes entraron con invitación y todavía no se verificaron. */
export async function pendingInvitees(guildId: string): Promise<string[]> {
  return Object.keys((await getData(guildId)).pendingByInvitee);
}

// ---------- eventos: alguien entra o se va ----------
async function onMemberAdd(member: GuildMember): Promise<void> {
  const guild = member.guild;
  const before = inviteCache.get(guild.id) ?? [];
  await new Promise((resolve) => setTimeout(resolve, DETECTION_DELAY_MS));
  const after = await snapshotInvites(guild);
  inviteCache.set(guild.id, after);

  const used = detectUsedInvite(before, after);
  if (!used?.inviterId || used.inviterId === member.id) {
    const reason = guild.vanityURLCode
      ? `probablemente entró por el link personalizado (discord.gg/${guild.vanityURLCode})`
      : "puede ser el link principal del servidor, un bot o una invitación que se borró";
    log.info("invitaciones", `${member.user.tag} entró a ${guild.name} sin invitación detectable (${reason}).`);
    await sendToLog(guild, notice.unknown(member.id, reason));
    return;
  }

  const data = await getData(guild.id);
  data.pendingByInvitee[member.id] = used.inviterId;
  await setData(guild.id, data);

  const verifiedCount = data.inviters[used.inviterId]?.count ?? 0;
  log.info("invitaciones", `${member.user.tag} entró a ${guild.name} con la invitación ${used.code}.`);
  const sent = await sendToLog(guild, notice.pending(member.id, used.inviterId, verifiedCount));
  // Si se verificó mientras se mandaba el aviso, ya no hay nada que actualizar después.
  if (sent && data.pendingByInvitee[member.id]) {
    data.joinMessages = { ...data.joinMessages, [member.id]: { channelId: sent.channelId, messageId: sent.id } };
    await setData(guild.id, data);
  }
}

function queueMemberAdd(member: GuildMember): void {
  const previous = joinQueues.get(member.guild.id) ?? Promise.resolve();
  const next = previous
    .then(() => onMemberAdd(member))
    .catch((err) => log.error("invitaciones", "Error registrando invitación", err));
  joinQueues.set(member.guild.id, next);
}

async function onMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
  const data = await getData(member.guild.id);
  const inviterId = data.pendingByInvitee[member.id];
  if (!inviterId) return;
  delete data.pendingByInvitee[member.id];
  await updateJoinMessage(member.guild, data, member.id, notice.discarded(member.id, inviterId));
  await setData(member.guild.id, data);
}

// ---------- llamado desde verification.ts cuando alguien recibe el rol de verificado ----------
// Se puede llamar más de una vez por la misma persona (botón + evento de rol): el chequeo y el
// borrado del pendiente pasan sin esperas en el medio, así que solo la primera llamada suma.
export async function creditVerifiedInvite(member: GuildMember): Promise<void> {
  const guild = member.guild;
  const data = await getData(guild.id);
  const inviterId = data.pendingByInvitee[member.id];
  if (!inviterId) return;
  delete data.pendingByInvitee[member.id];

  const stats = data.inviters[inviterId] ?? { count: 0, claimed: [] };
  const previousCount = stats.count;
  stats.count += 1;
  data.inviters[inviterId] = stats;
  await setData(guild.id, data);
  log.info("invitaciones", `${member.user.tag} se verificó en ${guild.name}: suma para el invitador (${stats.count}).`);

  await updateJoinMessage(guild, data, member.id, notice.confirmed(member.id, inviterId, stats.count));
  await setData(guild.id, data);
  await refreshTopPanel(guild);

  const reached = milestonesReached(await getMilestones(guild.id), previousCount, stats.count);
  for (const milestone of reached) await notifyMilestone(guild, inviterId, milestone.count, milestone.reward);
}

async function notifyMilestone(guild: Guild, inviterId: string, count: number, reward: string): Promise<void> {
  const inviter = await guild.members.fetch(inviterId).catch(() => null);
  if (!inviter) return;

  // El servidor va en el ID del botón: el DM no tiene servidor, y el bot puede estar en varios.
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CLAIM_BUTTON_PREFIX}${guild.id}:${count}`)
      .setEmoji(GIVEAWAY_EMOJI)
      .setStyle(ButtonStyle.Secondary),
  );
  const embed = (await brandEmbed(guild))
    .setColor(MILESTONE_COLOR)
    .setTitle(`${GIVEAWAY_EMOJI} ¡Nuevo hito de invitaciones!`)
    .setDescription(
      `Llegaste a **${count} invitados verificados** en ${await serverName(guild)}.\nRecompensa: ${GIFT_EMOJI} **${reward}**\n\n` +
        "Tocá el botón para avisarle al staff y que te la entreguen.",
    )
    .setFooter({ text: INVITES_FOOTER, iconURL: guild.client.user.displayAvatarURL() });

  await inviter.send({ embeds: [embed], components: [row] }).catch(() => {
    log.info("invitaciones", `No pude mandarle el DM del hito a ${inviter.user.tag} (tiene los DMs cerrados).`);
  });
}

async function claim(i: ButtonInteraction): Promise<void> {
  const parts = i.customId.slice(CLAIM_BUTTON_PREFIX.length).split(":");
  // Formato viejo (antes de ser multi-servidor): solo el número, en el servidor original.
  const [guildId, countStr] = parts.length === 2 ? parts : [process.env.GUILD_ID, parts[0]];
  const guild = guildId ? await i.client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) {
    await i.reply(ephemeral("No encontré el servidor de este hito (puede que ya no esté ahí)."));
    return;
  }
  const count = Number(countStr);
  const data = await getData(guild.id);
  const stats = data.inviters[i.user.id];
  if (!stats || stats.count < count) {
    await i.reply(ephemeral("Ya no te alcanza este hito."));
    return;
  }
  if (stats.claimed.includes(count)) {
    await i.reply(ephemeral("Ya habías reclamado este hito."));
    return;
  }
  stats.claimed.push(count);
  await setData(guild.id, data);
  await i.update({ components: [] });

  const milestone = (await getMilestones(guild.id)).find((m) => m.count === count);
  await sendToLog(
    guild,
    `🎁 <@${i.user.id}> llegó a **${count} invitados verificados** y reclamó la recompensa: ${milestone?.reward ?? "—"}. Hay que entregársela a mano.`,
  );
  await i.followUp(ephemeral("✅ Reclamo enviado, el staff te va a contactar para entregarte la recompensa."));
}

// ---------- top de invitadores: se puede fijar en un canal y se actualiza solo ----------
function topRanking(data: InvitesData): [string, InviterStats][] {
  return Object.entries(data.inviters)
    .filter(([, stats]) => stats.count > 0)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 10);
}

async function buildTopEmbed(guild: Guild, data: InvitesData): Promise<EmbedBuilder> {
  const ranking = topRanking(data);
  const medals = ["🥇", "🥈", "🥉"];
  const description =
    ranking.length === 0
      ? "Todavía nadie invitó a alguien que se haya verificado."
      : ranking.map(([userId, stats], idx) => `${medals[idx] ?? `**${idx + 1}.**`} <@${userId}> — **${stats.count}**`).join("\n");
  return (await brandEmbed(guild))
    .setColor(0xfffffe) // blanco (0xffffff es "sin color" para Discord)
    .setTitle("🏆 Top invitadores")
    .setDescription(`${description}\n\n💡 Invitá gente al servidor: cada invitado que se verifique te suma, y hay recompensas por hito.`)
    .setFooter({ text: INVITES_FOOTER, iconURL: guild.client.user.displayAvatarURL() });
}

/** Si hay un panel de top fijado, lo edita con los números actuales. No hace nada si no hay uno. */
async function refreshTopPanel(guild: Guild): Promise<void> {
  const data = await getData(guild.id);
  if (!data.topPanel) return;
  const channel = await guild.channels.fetch(data.topPanel.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await channel.messages.fetch(data.topPanel.messageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [await buildTopEmbed(guild, data)] }).catch(() => {});
}

// ---------- comandos ----------
const invitesCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("invitaciones")
    .setDescription("Sistema de invitaciones")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("ver")
        .setDescription("Cuántos invitados verificados tiene alguien")
        .addUserOption((o) => o.setName("miembro").setDescription("A quién consultar (por defecto, vos)")),
    )
    .addSubcommand((s) =>
      s
        .setName("top")
        .setDescription("Top de invitadores (con canal, lo fija ahí y se actualiza solo)")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Fijar el top en este canal, se actualiza solo (requiere Gestionar servidor)")
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) => s.setName("hitos").setDescription("Lista los hitos y sus recompensas"))
    .addSubcommandGroup((g) =>
      g
        .setName("hito")
        .setDescription("Configurar los hitos (requiere Gestionar servidor)")
        .addSubcommand((s) =>
          s
            .setName("agregar")
            .setDescription("Suma un hito (o cambia su recompensa si ya existe)")
            .addIntegerOption((o) =>
              o.setName("cantidad").setDescription("Invitados verificados para llegar").setRequired(true).setMinValue(1).setMaxValue(10_000),
            )
            .addStringOption((o) => o.setName("recompensa").setDescription("Qué se gana, ej. Rango VIP").setRequired(true).setMaxLength(100)),
        )
        .addSubcommand((s) =>
          s
            .setName("quitar")
            .setDescription("Saca un hito")
            .addIntegerOption((o) => o.setName("cantidad").setDescription("Cantidad del hito a sacar").setRequired(true).setMinValue(1)),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define el canal donde se avisan ingresos, verificaciones y reclamos (requiere Gestionar servidor)")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Canal de avisos de invitaciones")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup();

    if ((sub === "config" || group === "hito") && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply(ephemeral("⚠️ Necesitás el permiso de Gestionar servidor para esto."));
      return;
    }

    if (group === "hito") {
      const cantidad = interaction.options.getInteger("cantidad", true);
      // La primera vez que se toca, se parte de los hitos que ya se estaban usando.
      const current = [...(await getMilestones(guild.id))];
      const others = current.filter((m) => m.count !== cantidad);
      if (sub === "quitar") {
        if (others.length === current.length) {
          await interaction.reply(ephemeral(`No hay ningún hito de **${cantidad}** invitados.`));
          return;
        }
        await setValue(guild.id, MILESTONES_KEY, others);
        await interaction.reply(ephemeral(`✅ Saqué el hito de **${cantidad}** invitados.`));
        return;
      }
      const recompensa = interaction.options.getString("recompensa", true).trim();
      const updated = [...others, { count: cantidad, reward: recompensa }].sort((a, b) => a.count - b.count);
      await setValue(guild.id, MILESTONES_KEY, updated);
      await interaction.reply(
        ephemeral(
          `✅ Hito de **${cantidad}** invitados verificados → ${recompensa}.
` +
            "Quien ya lo había pasado no recibe el aviso de nuevo: solo cuenta para los que lleguen de ahora en más.",
        ),
      );
      return;
    }

    if (sub === "config") {
      const canal = interaction.options.getChannel("canal", true);
      const data = await getData(guild.id);
      data.logChannelId = canal.id;
      await setData(guild.id, data);
      const problem =
        (await channelProblem(guild, canal.id)) ?? guildPermissionProblem(guild, [PermissionFlagsBits.ManageGuild]);
      await interaction.reply(
        ephemeral(
          `✅ Canal de avisos de invitaciones configurado en <#${canal.id}>.` +
            (problem ? `\n\n⚠️ Ojo: ${problem}. Sin eso no puedo detectar quién invitó a quién.` : ""),
        ),
      );
      return;
    }

    if (sub === "hitos") {
      const milestones = await getMilestones(guild.id);
      if (milestones.length === 0) {
        await interaction.reply(ephemeral("Este servidor no tiene hitos de invitaciones."));
        return;
      }
      const lines = milestones.map((m) => `**${m.count}** invitados verificados → ${m.reward}`);
      await interaction.reply(ephemeral(`🎯 **Hitos de invitaciones**\n${lines.join("\n")}`));
      return;
    }

    const data = await getData(guild.id);

    if (sub === "ver") {
      const target = interaction.options.getUser("miembro") ?? interaction.user;
      const count = data.inviters[target.id]?.count ?? 0;
      await interaction.reply(ephemeral(`<@${target.id}> tiene **${count}** invitados verificados.`));
      return;
    }

    // sub === "top"
    const canal = interaction.options.getChannel("canal");
    if (canal) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply(ephemeral("⚠️ Necesitás el permiso de Gestionar servidor para fijar el panel."));
        return;
      }
      const target = await guild.channels.fetch(canal.id).catch(() => null);
      if (!target || target.type !== ChannelType.GuildText) {
        await interaction.reply(ephemeral("⚠️ Elegí un canal de texto."));
        return;
      }
      const message = await target.send({ embeds: [await buildTopEmbed(guild, data)] }).catch(() => null);
      if (!message) {
        const problem = await channelProblem(guild, target.id);
        await interaction.reply(ephemeral(`⚠️ No pude publicar el panel en <#${target.id}>${problem ? `: ${problem}` : "."}`));
        return;
      }
      data.topPanel = { channelId: target.id, messageId: message.id };
      await setData(guild.id, data);
      await interaction.reply(ephemeral(`✅ Panel de top fijado en <#${target.id}>. Se va a actualizar solo cuando cambien los números.`));
      return;
    }

    if (topRanking(data).length === 0) {
      await interaction.reply(ephemeral("Todavía nadie invitó a alguien que se haya verificado."));
      return;
    }
    await interaction.reply({ embeds: [await buildTopEmbed(guild, data)] });
  },
};

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const data = await getData(guild.id);
  const perm = guildPermissionProblem(guild, [PermissionFlagsBits.ManageGuild]);
  if (perm) return { label: "Invitaciones", ok: false, detail: `${perm} (sin eso no veo las invitaciones)` };
  if (!data.logChannelId) return { label: "Invitaciones", ok: false, detail: "no hay canal de avisos (falta `/invitaciones config`)" };
  const problem = await channelProblem(guild, data.logChannelId);
  if (problem) return { label: "Invitaciones", ok: false, detail: problem };
  return { label: "Invitaciones", ok: true, detail: `avisos en <#${data.logChannelId}>` };
}

export const invites: Feature = {
  name: "invites",
  commands: [invitesCommand],
  checkHealth,
  register(client: Client): void {
    client.once(Events.ClientReady, async (c) => {
      for (const guild of c.guilds.cache.values()) await refreshCache(guild);
    });
    client.on(Events.GuildCreate, (guild) => {
      refreshCache(guild).catch(() => {});
    });
    // Mantener la foto al día cuando se crea una invitación (necesita el intent GuildInvites).
    // Al BORRARSE una no refrescamos: si se borró por agotarse, la detección necesita verla en la
    // foto "de antes". Se actualiza sola en el próximo ingreso.
    client.on(Events.InviteCreate, (invite) => {
      if (invite.guild && "invites" in invite.guild) refreshCache(invite.guild).catch(() => {});
    });
    client.on(Events.GuildMemberAdd, (member) => queueMemberAdd(member));
    client.on(Events.GuildMemberRemove, (member) => {
      onMemberRemove(member).catch((err) => log.error("invitaciones", "Error descartando invitación pendiente", err));
    });
  },
  async handleInteraction(interaction: Interaction): Promise<boolean> {
    if (!interaction.isButton() || !interaction.customId.startsWith(CLAIM_BUTTON_PREFIX)) return false;
    await claim(interaction);
    return true;
  },
};
