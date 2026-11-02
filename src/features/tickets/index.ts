/** Sistema 2: tickets (panel con botones, canal privado por ticket, derivar, reclamar y cerrar). */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  type ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
  Events,
  type Guild,
  type GuildMember,
  type Interaction,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
  TextInputBuilder,
  TextInputStyle,
  type User,
} from "discord.js";
import { TEXT_PERMS, channelProblem, guildPermissionProblem } from "../../health.js";
import { log } from "../../log.js";
import { findRank } from "../../nickLogic.js";
import { type Rank, nextTierUp } from "../../ranks.js";
import { getValue, guildIds, setValue } from "../../store.js";
import type { Command, Feature, HealthCheck } from "../../types.js";
import { brandEmbed, ephemeral } from "../../ui.js";
import { getRanks, roleIds } from "../staff.js";
import { formatDuration, parseDuration } from "../moderation/logic.js";
import {
  MAX_CATEGORIES,
  MAX_QUESTIONS,
  MAX_QUESTION_LENGTH,
  type ResolvedCategory,
  categoryKey,
  isValidEmoji,
  staffRolesFor,
} from "./categories.js";
import {
  type CategoryType,
  findCategory,
  getAllCategories,
  getCategories,
  resetCategories,
  saveCategories,
} from "./categoryStore.js";
import {
  type Rating,
  getRecordById,
  getRecords,
  getStaffStats,
  isRating,
  rateTicket,
  readTranscript,
  recordTicketClosed,
  saveTranscript,
} from "./stats.js";
import { type TranscriptEntry, buildTranscript } from "./transcript.js";

const CONFIG_KEY = "tickets";
const META_KEY = "ticketMeta";
const MAX_TRANSCRIPT_MESSAGES = 1000;
const TICKET_COLOR = 0x6c3ce9;
const FORM_PREFIX = "ticket:form:";
const MIN_INACTIVITY_MS = 10 * 60_000;

const TICKET_EMOJI = "<:ticket:1565178754542604339>";
const TICKET_FOOTER = "Sistema de Tickets";

// Botones dentro de un ticket (reclamar / derivar / cerrar) y los mensajes sueltos que avisan lo mismo.
const CLAIM_EMOJI = "<:75219regles:1565185230732791899>";
const DERIVE_EMOJI = "<:share:1565177594515820697>";
const CLOSE_EMOJI = "<:80091fermer:1565185305902977064>";
const INACTIVITY_EMOJI = "<a:orange_loading:1565378469993513111>";

// Estado de una categoría de postulación (se está aceptando / cerrada por ahora).
const STATUS_ONLINE_EMOJI = "<a:statusonline:1565376989639090370>";
const STATUS_OFFLINE_EMOJI = "<a:statusoffline:1565377039987376319>";

// Encuesta de satisfacción por DM (solo bien/mal) y su resultado en el mensaje de feedback.
const RATE_LIKE_EMOJI = "<:84613like:1565185331685359727>";
const RATE_DISLIKE_EMOJI = "<:63157dislike:1565185083206537287>";
const RATE_NEUTRAL_EMOJI = "<:yellow_dot:1565178090987200543>"; // solo para calificaciones viejas en "indiferente"

// Stats agregadas de un staff (bien / no respondieron / mal).
const STATS_GOOD_EMOJI = "<:goodconektion:1565381918650925126>";
const STATS_NEUTRAL_EMOJI = "<:conektionokay:1565381970945646877>";
const STATS_BAD_EMOJI = "<:conektionbad:1565382021788864626>";

interface TicketConfig {
  categoryId?: string;
  logChannelId?: string;
  /** Qué categorías de postulación están aceptando gente ahora mismo (por defecto, ninguna). */
  openApplications?: Record<string, boolean>;
  /** Dónde quedó publicado el panel de postulaciones, para poder editarlo al abrir/cerrar. */
  applicationsPanel?: { channelId: string; messageId: string };
  /** Después de cuánto tiempo sin mensajes se avisa y se cierra un ticket solo (sin definir = nunca). */
  inactivityMs?: number;
}

const getConfig = (guildId: string): Promise<TicketConfig> => getValue<TicketConfig>(guildId, CONFIG_KEY, {});
const setConfig = (guildId: string, cfg: TicketConfig): Promise<void> => setValue(guildId, CONFIG_KEY, cfg);

// ---------- estado de cada ticket abierto ----------
// Se guarda en el store (no en el tema del canal): Discord solo deja cambiar el tema 2 veces
// cada 10 minutos, y reclamar + derivar + reclamar ya lo superaba y dejaba el botón colgado.
// El tema se sigue escribiendo una vez al crear el canal, y se lee como respaldo para los
// tickets que se abrieron antes de este cambio.
interface TicketMeta {
  openerId: string;
  key: string;
  claimerId: string | null;
  /** Aviso de "se va a cerrar por inactividad" que está esperando respuesta. */
  inactivityWarningId?: string;
  warnedAt?: number;
}

const formatTopic = (m: TicketMeta): string => `ticket|${m.openerId}|${m.key}|${m.claimerId ?? "-"}`;

function parseTopic(topic: string | null | undefined): TicketMeta | null {
  if (!topic) return null;
  const [tag, openerId, key, claimer] = topic.split("|");
  if (tag !== "ticket" || !openerId || !key) return null;
  return { openerId, key, claimerId: claimer && claimer !== "-" ? claimer : null };
}

const getAllMeta = (guildId: string): Promise<Record<string, TicketMeta>> =>
  getValue<Record<string, TicketMeta>>(guildId, META_KEY, {});

async function getMeta(channel: TextChannel): Promise<TicketMeta | null> {
  return (await getAllMeta(channel.guild.id))[channel.id] ?? parseTopic(channel.topic);
}

async function saveMeta(guildId: string, channelId: string, meta: TicketMeta | null): Promise<void> {
  const all = await getAllMeta(guildId);
  if (meta) all[channelId] = meta;
  else delete all[channelId];
  await setValue(guildId, META_KEY, all);
}

// Tickets que se están cerrando ahora mismo: evita transcripciones y stats dobles si tocan "Cerrar" dos veces.
const closing = new Set<string>();

// ---------- utilidades ----------
/** Categoría de un ticket abierto, o una genérica si la borraron mientras el ticket seguía abierto. */
async function categoryOf(guild: Guild, key: string): Promise<ResolvedCategory> {
  return (
    (await findCategory(guild, key)) ?? {
      key,
      label: key,
      emoji: "🎫",
      description: "",
      application: key.startsWith("postulacion-"),
      minRoleId: null,
    }
  );
}

function isStaff(member: GuildMember, cat: ResolvedCategory, ranks: readonly Rank[]): boolean {
  // Un admin del servidor siempre cuenta como staff, aunque no tenga un rango.
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const ids = staffRolesFor(cat, ranks);
  return member.roles.cache.some((r) => ids.includes(r.id));
}

/** Fila de botones (solo emoji) de un panel de categorías. */
function categoryButtons(categories: readonly ResolvedCategory[], isOpen: (c: ResolvedCategory) => boolean = () => true) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    categories.map((c) =>
      new ButtonBuilder().setCustomId(`ticket:open:${c.key}`).setEmoji(c.emoji).setStyle(ButtonStyle.Secondary).setDisabled(!isOpen(c)),
    ),
  );
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "usuario";

// Sin texto, solo emoji: lo que hace cada uno se explica en el mensaje del ticket.
function controlRow(claimed: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket:claim").setEmoji(CLAIM_EMOJI).setStyle(ButtonStyle.Success).setDisabled(claimed),
    new ButtonBuilder().setCustomId("ticket:derive").setEmoji(DERIVE_EMOJI).setStyle(ButtonStyle.Primary).setDisabled(!claimed),
    new ButtonBuilder().setCustomId("ticket:close").setEmoji(CLOSE_EMOJI).setStyle(ButtonStyle.Danger),
  );
}

// El servidor va en el ID del botón porque la encuesta llega por DM (sin servidor) y el bot puede estar en varios.
function rateRow(guildId: string, ticketId: string): ActionRowBuilder<ButtonBuilder> {
  const id = (rating: Rating) => `ticket:rate:${guildId}:${ticketId}:${rating}`;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id("bien")).setLabel("Me gustó").setEmoji(RATE_LIKE_EMOJI).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(id("mal")).setLabel("No me gustó").setEmoji(RATE_DISLIKE_EMOJI).setStyle(ButtonStyle.Danger),
  );
}

function ratingLabel(rating: Rating | null): string {
  if (rating === "bien") return `${RATE_LIKE_EMOJI} Bien`;
  if (rating === "mal") return `${RATE_DISLIKE_EMOJI} Mal`;
  if (rating === "indiferente") return `${RATE_NEUTRAL_EMOJI} Indiferente`; // calificación vieja: el botón ya no existe
  return "⏳ Sin calificar";
}

const ticketEmbed = async (guild: Guild): Promise<EmbedBuilder> =>
  (await brandEmbed(guild, TICKET_COLOR)).setFooter({ text: TICKET_FOOTER, iconURL: guild.client.user.displayAvatarURL() });

function statsText(stats: { attended: number; bien: number; mal: number }): string {
  const noRespondieron = stats.attended - stats.bien - stats.mal;
  return (
    `Atendidos: **${stats.attended}**\n` +
    `${STATS_GOOD_EMOJI} Bien: **${stats.bien}** — ${STATS_NEUTRAL_EMOJI} No respondieron: **${noRespondieron}** — ${STATS_BAD_EMOJI} Mal: **${stats.mal}**`
  );
}

/** Canal de texto donde publicar un panel (el elegido o el actual), o null si no sirve. */
async function panelTarget(interaction: ChatInputCommandInteraction): Promise<TextChannel | null> {
  const targetId = interaction.options.getChannel("canal")?.id ?? interaction.channelId;
  const target = await interaction.guild?.channels.fetch(targetId).catch(() => null);
  return target && target.type === ChannelType.GuildText ? target : null;
}

// ---------- comandos ----------
const ticketCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Sistema de tickets")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define dónde se crean los tickets y dónde se guardan las transcripciones")
        .addChannelOption((o) =>
          o
            .setName("categoria")
            .setDescription("Categoría de Discord donde se crean los tickets")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        )
        .addChannelOption((o) =>
          o
            .setName("registros")
            .setDescription("Canal de staff donde se guardan las transcripciones")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("panel")
        .setDescription("Publica el panel para abrir tickets")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Canal donde publicarlo (por defecto, este)")
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("stats")
        .setDescription("Estadísticas de tickets de un staff")
        .addUserOption((o) => o.setName("miembro").setDescription("A quién consultar (por defecto, vos)")),
    )
    .addSubcommand((s) =>
      s
        .setName("transcripciones")
        .setDescription("Lista los tickets que atendió un staff")
        .addUserOption((o) => o.setName("miembro").setDescription("Staff a consultar").setRequired(true))
        .addStringOption((o) =>
          o
            .setName("calificacion")
            .setDescription("Filtrar por calificación")
            .addChoices(
              { name: "Bien", value: "bien" },
              { name: "Mal", value: "mal" },
              { name: "Indiferente", value: "indiferente" },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("transcripcion")
        .setDescription("Manda el archivo de un ticket puntual")
        .addStringOption((o) => o.setName("id").setDescription("ID del ticket (lo lista `/ticket transcripciones`)").setRequired(true)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("postulaciones")
        .setDescription("Panel de postulaciones (staff, builder, social)")
        .addSubcommand((s) =>
          s
            .setName("panel")
            .setDescription("Publica el panel de postulaciones")
            .addChannelOption((o) =>
              o
                .setName("canal")
                .setDescription("Canal donde publicarlo (por defecto, este)")
                .addChannelTypes(ChannelType.GuildText),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("abrir")
            .setDescription("Empieza a aceptar postulaciones de una categoría")
            .addStringOption((o) =>
              o
                .setName("categoria")
                .setDescription("Qué categoría abrir")
                .setRequired(true)
                .setAutocomplete(true),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("cerrar")
            .setDescription("Deja de aceptar postulaciones de una categoría")
            .addStringOption((o) =>
              o
                .setName("categoria")
                .setDescription("Qué categoría cerrar")
                .setRequired(true)
                .setAutocomplete(true),
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("inactividad")
        .setDescription("Cierra solos los tickets sin mensajes (avisa antes)")
        .addStringOption((o) =>
          o.setName("tiempo").setDescription("Ej: 24h, 2d, 12h. Poné 0 para apagarlo").setRequired(true).setMaxLength(20),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("categoria")
        .setDescription("Las categorías (botones) de los paneles de tickets")
        .addSubcommand((s) => s.setName("lista").setDescription("Muestra las categorías y quién atiende cada una"))
        .addSubcommand((s) => {
          s.setName("preguntas")
            .setDescription("Formulario que se completa antes de abrir (sin preguntas = sin formulario)")
            .addStringOption((o) => o.setName("categoria").setDescription("Cuál").setRequired(true).setAutocomplete(true));
          for (let n = 1; n <= MAX_QUESTIONS; n++) {
            s.addStringOption((o) =>
              o.setName(`pregunta${n}`).setDescription(`Pregunta ${n} (máx. ${MAX_QUESTION_LENGTH} caracteres)`).setMaxLength(MAX_QUESTION_LENGTH),
            );
          }
          return s;
        })
        .addSubcommand((s) =>
          s
            .setName("agregar")
            .setDescription("Suma una categoría a un panel (o la edita si ya existe con ese nombre)")
            .addStringOption((o) =>
              o
                .setName("panel")
                .setDescription("A qué panel va")
                .setRequired(true)
                .addChoices({ name: "Soporte", value: "support" }, { name: "Postulaciones", value: "applications" }),
            )
            .addStringOption((o) => o.setName("nombre").setDescription("Nombre, ej. Reportar jugador").setRequired(true).setMaxLength(40))
            .addStringOption((o) =>
              o.setName("emoji").setDescription("Emoji del botón (uno común o uno del servidor)").setRequired(true),
            )
            .addStringOption((o) =>
              o.setName("descripcion").setDescription("Texto corto que se ve en el panel").setRequired(true).setMaxLength(100),
            )
            .addRoleOption((o) =>
              o.setName("rango_minimo").setDescription("Rango mínimo que lo atiende (ese y los de arriba). Sin elegir: todo el staff"),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("quitar")
            .setDescription("Saca una categoría de su panel")
            .addStringOption((o) => o.setName("categoria").setDescription("Cuál").setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName("restablecer")
            .setDescription("Vuelve un panel a las categorías de por defecto")
            .addStringOption((o) =>
              o
                .setName("panel")
                .setDescription("Qué panel")
                .setRequired(true)
                .addChoices({ name: "Soporte", value: "support" }, { name: "Postulaciones", value: "applications" }),
            ),
        ),
    )
    .toJSON(),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const typed = interaction.options.getFocused().toLowerCase();
    const onlyApplications = interaction.options.getSubcommandGroup() === "postulaciones";
    const categories = onlyApplications ? await getCategories(guild, "applications") : await getAllCategories(guild);
    await interaction.respond(
      categories
        .filter((c) => c.label.toLowerCase().includes(typed) || c.key.includes(typed))
        .slice(0, 25)
        .map((c) => ({ name: `${c.application ? "Postulación" : "Soporte"}: ${c.label}`, value: c.key })),
    );
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();

    if (group === "postulaciones") {
      await handleApplications(interaction, guild, sub);
      return;
    }
    if (group === "categoria") {
      await handleCategories(interaction, guild, sub);
      return;
    }

    if (sub === "config") {
      const categoria = interaction.options.getChannel("categoria", true);
      const registros = interaction.options.getChannel("registros", true);
      const cfg = await getConfig(guild.id);
      // Se conserva el resto (postulaciones abiertas, panel publicado): antes se borraba al reconfigurar.
      await setConfig(guild.id, { ...cfg, categoryId: categoria.id, logChannelId: registros.id });
      const problems = [
        await channelProblem(guild, categoria.id, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]),
        await channelProblem(guild, registros.id, [...TEXT_PERMS, PermissionFlagsBits.AttachFiles]),
      ].filter(Boolean);
      await interaction.reply(
        ephemeral(
          `✅ **Tickets configurados.**\n📁 Categoría: <#${categoria.id}>\n📋 Registros: <#${registros.id}>` +
            (problems.length > 0
              ? `\n\n⚠️ Ojo:\n${problems.map((p) => `• ${p}`).join("\n")}`
              : "\n\nAhora publicá el panel con `/ticket panel`."),
        ),
      );
      return;
    }

    if (sub === "inactividad") {
      const text = interaction.options.getString("tiempo", true).trim();
      const cfg = await getConfig(guild.id);
      if (text === "0") {
        await setConfig(guild.id, { ...cfg, inactivityMs: undefined });
        await interaction.reply(ephemeral("✅ Cierre por inactividad apagado: los tickets quedan abiertos hasta que alguien los cierre."));
        return;
      }
      const ms = parseDuration(text);
      if (!ms || ms < MIN_INACTIVITY_MS) {
        await interaction.reply(ephemeral("⚠️ Decime un tiempo como `24h`, `2d` o `12h` (mínimo 10 minutos), o `0` para apagarlo."));
        return;
      }
      await setConfig(guild.id, { ...cfg, inactivityMs: ms });
      await interaction.reply(
        ephemeral(
          `✅ Si un ticket pasa **${formatDuration(ms)}** sin mensajes, aviso en el canal y lo cierro **${formatDuration(graceFor(ms))}** después si nadie responde.\n` +
            "El cierre automático guarda la transcripción y manda la encuesta igual que el botón.",
        ),
      );
      return;
    }

    if (sub === "stats") {
      const target = interaction.options.getUser("miembro") ?? interaction.user;
      const stats = await getStaffStats(guild.id, target.id);
      await interaction.reply(ephemeral(`📊 **Stats de tickets de <@${target.id}>**\n${statsText(stats)}`));
      return;
    }

    if (sub === "transcripciones") {
      const target = interaction.options.getUser("miembro", true);
      const rating = (interaction.options.getString("calificacion") as Rating | null) ?? undefined;
      const records = await getRecords(guild.id, target.id, rating);
      if (records.length === 0) {
        await interaction.reply(ephemeral("No encontré tickets con esos filtros."));
        return;
      }
      const lines = records
        .slice(-25)
        .map((r) => `\`${r.id}\` — ${r.category} — ${ratingLabel(r.rating)} — <t:${Math.floor(r.closedAt / 1000)}:d>`);
      await interaction.reply(
        ephemeral(
          `📋 **Tickets de <@${target.id}>** (${records.length} en total, mostrando los últimos ${lines.length})\n${lines.join("\n")}\n\n` +
            "Usá `/ticket transcripcion id:<...>` para pedir el archivo de alguno.",
        ),
      );
      return;
    }

    if (sub === "transcripcion") {
      const id = interaction.options.getString("id", true).trim();
      const record = await getRecordById(guild.id, id);
      if (!record) {
        await interaction.reply(ephemeral("No encontré ningún ticket con ese ID."));
        return;
      }
      const file = await readTranscript(record);
      if (!file) {
        await interaction.reply(ephemeral("No encontré el archivo de esa transcripción en el disco (¿se borró la carpeta data/transcripts?)."));
        return;
      }
      await interaction.reply({
        content: `📄 Transcripción del ticket \`${record.id}\` (${ratingLabel(record.rating)}):`,
        files: [new AttachmentBuilder(file, { name: `transcripcion-${record.id}.txt` })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // sub === "panel"
    const cfg = await getConfig(guild.id);
    if (!cfg.categoryId || !cfg.logChannelId) {
      await interaction.reply(ephemeral("⚠️ Primero configurá los tickets con `/ticket config`."));
      return;
    }
    const target = await panelTarget(interaction);
    if (!target) {
      await interaction.reply(ephemeral("⚠️ Elegí un canal de texto para publicar el panel."));
      return;
    }

    const categories = await getCategories(guild, "support");
    if (categories.length === 0) {
      await interaction.reply(ephemeral("⚠️ El panel de soporte no tiene categorías. Sumá una con `/ticket categoria agregar`."));
      return;
    }
    const embed = (await ticketEmbed(guild))
      .setTitle(`${TICKET_EMOJI} Centro de ayuda`)
      .setDescription(
        "Elegí el tipo de ticket que necesitás. Se va a crear un canal privado entre vos y el staff.\n\n" +
          categories.map((c) => `${c.emoji} **${c.label}**: ${c.description}`).join("\n"),
      )
      .setThumbnail(interaction.client.user.displayAvatarURL());
    const sent = await target.send({ embeds: [embed], components: [categoryButtons(categories)] }).catch(() => null);
    if (!sent) {
      const problem = await channelProblem(guild, target.id);
      await interaction.reply(ephemeral(`⚠️ No pude publicar el panel en <#${target.id}>${problem ? `: ${problem}` : "."}`));
      return;
    }
    await interaction.reply(ephemeral(`✅ Panel publicado en <#${target.id}>.`));
  },
};

// ---------- postulaciones: panel y abrir/cerrar categorías ----------
async function buildApplicationsPanel(
  guild: Guild,
  openApplications: Record<string, boolean>,
): Promise<{ embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const categories = await getCategories(guild, "applications");
  const statusDot = (key: string) => (openApplications[key] ? STATUS_ONLINE_EMOJI : STATUS_OFFLINE_EMOJI);
  const embed = (await ticketEmbed(guild))
    .setTitle(`${TICKET_EMOJI} Postulaciones`)
    .setDescription(
      categories.length === 0
        ? "Por ahora no hay postulaciones."
        : "Elegí a qué te querés postular.\n\n" +
            categories.map((c) => `${statusDot(c.key)} ${c.emoji} **${c.label}**: ${c.description}`).join("\n") +
            `\n\n${STATUS_ONLINE_EMOJI} Se está aceptando\n${STATUS_OFFLINE_EMOJI} Cerrada por ahora`,
    )
    .setThumbnail(guild.client.user.displayAvatarURL());
  const components = categories.length > 0 ? [categoryButtons(categories, (c) => Boolean(openApplications[c.key]))] : [];
  return { embed, components };
}

/** Edita el panel de postulaciones ya publicado. Devuelve false si no lo encontró (lo borraron). */
async function refreshApplicationsPanel(guild: Guild, cfg: TicketConfig): Promise<boolean> {
  if (!cfg.applicationsPanel) return false;
  const channel = await guild.channels.fetch(cfg.applicationsPanel.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const message = await channel.messages.fetch(cfg.applicationsPanel.messageId).catch(() => null);
  if (!message) return false;
  const { embed, components } = await buildApplicationsPanel(guild, cfg.openApplications ?? {});
  return message
    .edit({ embeds: [embed], components })
    .then(() => true)
    .catch(() => false);
}

async function handleApplications(interaction: ChatInputCommandInteraction, guild: Guild, sub: string | null): Promise<void> {
  if (sub === "abrir" || sub === "cerrar") {
    const key = interaction.options.getString("categoria", true);
    const cat = (await getCategories(guild, "applications")).find((c) => c.key === key);
    if (!cat) {
      await interaction.reply(ephemeral("⚠️ No encontré esa postulación. Elegila de la lista que aparece al escribir."));
      return;
    }
    const cfg = await getConfig(guild.id);
    const updated: TicketConfig = { ...cfg, openApplications: { ...cfg.openApplications, [key]: sub === "abrir" } };
    await setConfig(guild.id, updated);
    const refreshed = await refreshApplicationsPanel(guild, updated);

    const verb = sub === "abrir" ? "Se están aceptando" : "Se dejaron de aceptar";
    await interaction.reply(
      ephemeral(
        `✅ ${verb} postulaciones de **${cat.label}**.` +
          (refreshed ? " El panel ya se actualizó." : "\nℹ️ No encontré el panel publicado: publicalo con `/ticket postulaciones panel`."),
      ),
    );
    return;
  }

  // sub === "panel"
  const cfg = await getConfig(guild.id);
  if (!cfg.categoryId || !cfg.logChannelId) {
    await interaction.reply(ephemeral("⚠️ Primero configurá los tickets con `/ticket config`."));
    return;
  }
  const target = await panelTarget(interaction);
  if (!target) {
    await interaction.reply(ephemeral("⚠️ Elegí un canal de texto para publicar el panel."));
    return;
  }

  const { embed, components } = await buildApplicationsPanel(guild, cfg.openApplications ?? {});
  const message = await target.send({ embeds: [embed], components }).catch(() => null);
  if (!message) {
    const problem = await channelProblem(guild, target.id);
    await interaction.reply(ephemeral(`⚠️ No pude publicar el panel en <#${target.id}>${problem ? `: ${problem}` : "."}`));
    return;
  }
  await setConfig(guild.id, { ...cfg, applicationsPanel: { channelId: target.id, messageId: message.id } });
  await interaction.reply(
    ephemeral(`✅ Panel de postulaciones publicado en <#${target.id}>.\nAbrí categorías con \`/ticket postulaciones abrir\`.`),
  );
}

// ---------- categorías: agregar, quitar, listar ----------
const PANEL_NAMES: Record<CategoryType, string> = { support: "Soporte", applications: "Postulaciones" };

async function handleCategories(interaction: ChatInputCommandInteraction, guild: Guild, sub: string | null): Promise<void> {
  if (sub === "lista") {
    const ranks = await getRanks(guild);
    const describe = (c: ResolvedCategory) => {
      const who = c.minRoleId && ranks.some((r) => r.role === c.minRoleId) ? `<@&${c.minRoleId}> o más` : "todo el staff";
      return `${c.emoji} **${c.label}** — ${c.description} *(atiende: ${who})*`;
    };
    const sections: string[] = [];
    for (const type of ["support", "applications"] as const) {
      const list = await getCategories(guild, type);
      sections.push(`**${PANEL_NAMES[type]}**\n${list.length > 0 ? list.map(describe).join("\n") : "*(ninguna)*"}`);
    }
    const embed = (await ticketEmbed(guild)).setTitle(`${TICKET_EMOJI} Categorías de tickets`).setDescription(sections.join("\n\n"));
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }

  if (sub === "restablecer") {
    const type = interaction.options.getString("panel", true) as CategoryType;
    await resetCategories(guild, type);
    await interaction.reply(ephemeral(`✅ El panel de **${PANEL_NAMES[type]}** volvió a las categorías de por defecto. Volvé a publicarlo para verlo.`));
    return;
  }

  if (sub === "preguntas") {
    const key = interaction.options.getString("categoria", true);
    const cat = await findCategory(guild, key);
    if (!cat) {
      await interaction.reply(ephemeral("⚠️ No encontré esa categoría. Elegila de la lista que aparece al escribir."));
      return;
    }
    const questions = Array.from({ length: MAX_QUESTIONS }, (_, n) => interaction.options.getString(`pregunta${n + 1}`)?.trim())
      .filter((q): q is string => Boolean(q));
    const type: CategoryType = cat.application ? "applications" : "support";
    const updated: ResolvedCategory = { ...cat, questions: questions.length > 0 ? questions : undefined };
    await saveCategories(guild, type, (await getCategories(guild, type)).map((c) => (c.key === key ? updated : c)));
    await interaction.reply(
      ephemeral(
        questions.length > 0
          ? `✅ **${cat.label}** ahora pide un formulario antes de abrir:\n${questions.map((q, n) => `${n + 1}. ${q}`).join("\n")}\n\nLas respuestas aparecen al principio del ticket.`
          : `✅ **${cat.label}** ya no tiene formulario: el ticket se abre directo.`,
      ),
    );
    return;
  }

  if (sub === "quitar") {
    const key = interaction.options.getString("categoria", true);
    const cat = await findCategory(guild, key);
    if (!cat) {
      await interaction.reply(ephemeral("⚠️ No encontré esa categoría. Elegila de la lista que aparece al escribir."));
      return;
    }
    const type: CategoryType = cat.application ? "applications" : "support";
    await saveCategories(guild, type, (await getCategories(guild, type)).filter((c) => c.key !== key));
    await interaction.reply(
      ephemeral(`✅ Saqué **${cat.label}** del panel de ${PANEL_NAMES[type]}. Volvé a publicar el panel para que desaparezca el botón.`),
    );
    return;
  }

  // sub === "agregar"
  const type = interaction.options.getString("panel", true) as CategoryType;
  const label = interaction.options.getString("nombre", true).trim();
  const emoji = interaction.options.getString("emoji", true).trim();
  const description = interaction.options.getString("descripcion", true).trim();
  const minRole = interaction.options.getRole("rango_minimo");
  if (!isValidEmoji(emoji)) {
    await interaction.reply(
      ephemeral("⚠️ Ese emoji no me sirve. Poné uno solo: uno común (🎫) o uno de un servidor donde esté el bot (`<:nombre:id>`)."),
    );
    return;
  }
  const ranks = await getRanks(guild);
  if (minRole && !ranks.some((r) => r.role === minRole.id)) {
    await interaction.reply(ephemeral(`⚠️ <@&${minRole.id}> no es un rango de staff. Mirá los rangos con \`/staff rangos\`.`));
    return;
  }

  const application = type === "applications";
  const key = categoryKey(label, application);
  const all = await getAllCategories(guild);
  const clash = all.find((c) => c.key === key && c.application !== application);
  if (clash) {
    await interaction.reply(ephemeral(`⚠️ Ya hay una categoría parecida en el otro panel (**${clash.label}**). Usá otro nombre.`));
    return;
  }
  const list = await getCategories(guild, type);
  const existed = list.some((c) => c.key === key);
  if (!existed && list.length >= MAX_CATEGORIES) {
    await interaction.reply(ephemeral(`⚠️ El panel de ${PANEL_NAMES[type]} ya tiene ${MAX_CATEGORIES} categorías (el máximo). Sacá una con \`/ticket categoria quitar\`.`));
    return;
  }
  const cat: ResolvedCategory = { key, label, emoji, description, application, minRoleId: minRole?.id ?? null };
  await saveCategories(guild, type, existed ? list.map((c) => (c.key === key ? cat : c)) : [...list, cat]);
  await interaction.reply(
    ephemeral(
      `✅ ${existed ? "Actualicé" : "Agregué"} ${emoji} **${label}** al panel de ${PANEL_NAMES[type]}` +
        ` (atiende: ${minRole ? `<@&${minRole.id}> o más` : "todo el staff"}).\n` +
        (application ? "Arranca cerrada: abrila con `/ticket postulaciones abrir`. " : "") +
        `Volvé a publicar el panel (\`/ticket ${application ? "postulaciones " : ""}panel\`) para ver el botón nuevo.`,
    ),
  );
}

/// ---------- botones ----------
/** Ticket abierto que ya tiene esta persona en el servidor, si hay. */
async function existingTicket(guild: Guild, cfg: TicketConfig, userId: string) {
  const allMeta = await getAllMeta(guild.id);
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.parentId === cfg.categoryId && (allMeta[c.id] ?? parseTopic(c.topic))?.openerId === userId,
  );
}

/**
 * Lo que se revisa antes de abrir un ticket (sin llamadas lentas: puede ir antes de mostrar el
 * formulario). Devuelve la configuración y la categoría, o el motivo por el que no se puede.
 */
async function openChecks(guild: Guild, key: string, userId: string): Promise<{ cfg: TicketConfig; cat: ResolvedCategory } | string> {
  const cat = await findCategory(guild, key);
  if (!cat) return "⚠️ Esa categoría ya no existe. Avisale a un admin para que vuelva a publicar el panel.";
  const cfg = await getConfig(guild.id);
  if (!cfg.categoryId || !cfg.logChannelId) return "Los tickets todavía no están configurados. Avisale a un admin.";
  if (cat.application && !cfg.openApplications?.[cat.key]) return `${cat.emoji} No se están aceptando postulaciones de **${cat.label}** por ahora.`;
  const existing = await existingTicket(guild, cfg, userId);
  if (existing) return `Ya tenés un ticket abierto: ${existing}`;
  return { cfg, cat };
}

async function openTicket(i: ButtonInteraction, key: string): Promise<void> {
  const guild = i.guild;
  if (!guild) return;
  const checks = await openChecks(guild, key, i.user.id);
  if (typeof checks === "string") {
    await i.reply(ephemeral(checks));
    return;
  }
  const { cfg, cat } = checks;
  // Con formulario, el modal tiene que ser la PRIMERA respuesta (sin defer antes).
  if (cat.questions && cat.questions.length > 0) {
    await i.showModal(buildFormModal(cat));
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply(await createTicket(guild, i.user, cat, cfg));
}

function buildFormModal(cat: ResolvedCategory): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${FORM_PREFIX}${cat.key}`)
    .setTitle(cat.label.slice(0, 45))
    .addComponents(
      (cat.questions ?? []).slice(0, MAX_QUESTIONS).map((q, idx) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(`q${idx}`)
            .setLabel(q.slice(0, 45))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000),
        ),
      ),
    );
}

async function handleForm(i: ModalSubmitInteraction): Promise<void> {
  const guild = i.guild;
  if (!guild) return;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const checks = await openChecks(guild, i.customId.slice(FORM_PREFIX.length), i.user.id);
  if (typeof checks === "string") {
    await i.editReply(checks);
    return;
  }
  const { cfg, cat } = checks;
  const answers = (cat.questions ?? []).slice(0, MAX_QUESTIONS).map((question, idx) => ({
    question,
    answer: i.fields.getTextInputValue(`q${idx}`),
  }));
  await i.editReply(await createTicket(guild, i.user, cat, cfg, answers));
}

/** Crea el canal del ticket y devuelve el mensaje para la persona. */
async function createTicket(
  guild: Guild,
  user: User,
  cat: ResolvedCategory,
  cfg: TicketConfig,
  answers?: { question: string; answer: string }[],
): Promise<string> {
  const staffRoleIds = staffRolesFor(cat, await getRanks(guild));
  const access = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
  ];

  const meta: TicketMeta = { openerId: user.id, key: cat.key, claimerId: null };
  const channel = await guild.channels
    .create({
      name: `${cat.key}-${slug(user.username)}`,
      type: ChannelType.GuildText,
      parent: cfg.categoryId,
      topic: formatTopic(meta),
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: access },
        // El bot también se da acceso explícito, por si la categoría lo tiene bloqueado.
        { id: guild.client.user.id, allow: [...access, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.EmbedLinks] },
        ...staffRoleIds.map((id) => ({ id, allow: access })),
      ],
      reason: `Ticket de ${user.tag} (${cat.label})`,
    })
    .catch((err) => {
      log.error("tickets", `No pude crear el canal del ticket en ${guild.name}`, err);
      return null;
    });
  if (!channel) return "⚠️ No pude crear tu ticket (me faltan permisos en la categoría de tickets). Avisale a un admin.";
  await saveMeta(guild.id, channel.id, meta);

  const intro = answers
    ? `Hola <@${user.id}>, recibimos tu formulario. El staff lo va a revisar y te responde por acá.`
    : `Hola <@${user.id}>, contanos en qué podemos ayudarte. El staff te va a responder en breve.`;
  const buttonsLegend =
    `${CLAIM_EMOJI} **Reclamar** — un staff pasa a atender el ticket\n` +
    `${DERIVE_EMOJI} **Derivar** — pedir que lo atienda un rango superior\n` +
    `${CLOSE_EMOJI} **Cerrar** — lo puede usar vos o el staff`;
  const embed = (await ticketEmbed(guild))
    .setTitle(`${cat.emoji} ${cat.label}`)
    .setDescription(`${intro}\n\n${buttonsLegend}`)
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() });
  if (answers) embed.addFields(answers.map((a) => ({ name: a.question.slice(0, 256), value: a.answer.slice(0, 1024) || "—" })));
  await channel.send({ content: `<@${user.id}>`, embeds: [embed], components: [controlRow(false)] });
  log.info("tickets", `${user.tag} abrió un ticket de ${cat.label} en ${guild.name} (#${channel.name}).`);
  return `✅ Ticket creado: ${channel}`;
}

// ---------- cierre automático por inactividad ----------
const INACTIVITY_TICK_MS = 2 * 60_000;
const MAX_GRACE_MS = 60 * 60_000;

/** Cuánto se espera después del aviso antes de cerrar: 1 hora, o menos si el tiempo de inactividad es corto. */
const graceFor = (inactivityMs: number): number => Math.min(MAX_GRACE_MS, inactivityMs);

async function checkInactivity(client: Client<true>): Promise<void> {
  const now = Date.now();
  for (const guildId of await guildIds()) {
    const cfg = await getConfig(guildId);
    const guild = client.guilds.cache.get(guildId);
    if (!cfg.inactivityMs || !guild) continue;

    for (const [channelId, meta] of Object.entries(await getAllMeta(guildId))) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildText || closing.has(channelId)) continue;
      const last = (await channel.messages.fetch({ limit: 1 }).catch(() => null))?.first();
      const lastAt = last?.createdTimestamp ?? channel.createdTimestamp;

      if (meta.inactivityWarningId) {
        if (last && last.id !== meta.inactivityWarningId) {
          // Alguien escribió después del aviso: el ticket sigue.
          await saveMeta(guildId, channelId, { ...meta, inactivityWarningId: undefined, warnedAt: undefined });
        } else if (now - (meta.warnedAt ?? now) >= graceFor(cfg.inactivityMs)) {
          await finishTicket(channel, meta, await categoryOf(guild, meta.key), client.user, "Cerrado automáticamente por inactividad");
        }
        continue;
      }

      if (now - lastAt >= cfg.inactivityMs) {
        const warning = await channel
          .send(
            `${INACTIVITY_EMOJI} <@${meta.openerId}> este ticket no tiene mensajes hace **${formatDuration(now - lastAt)}**. ` +
              `Si nadie escribe, se cierra solo en **${formatDuration(graceFor(cfg.inactivityMs))}**.`,
          )
          .catch(() => null);
        if (warning) await saveMeta(guildId, channelId, { ...meta, inactivityWarningId: warning.id, warnedAt: now });
      }
    }
  }
}

/** Datos comunes de los botones dentro de un ticket. Responde y devuelve null si no es un ticket. */
async function ticketContext(
  i: ButtonInteraction,
): Promise<{ channel: TextChannel; meta: TicketMeta; cat: ResolvedCategory; ranks: Rank[] } | null> {
  const channel = i.channel;
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  const meta = await getMeta(channel);
  if (!meta) {
    await i.reply(ephemeral("Este canal no es un ticket."));
    return null;
  }
  return { channel, meta, cat: await categoryOf(channel.guild, meta.key), ranks: await getRanks(channel.guild) };
}

async function claimTicket(i: ButtonInteraction): Promise<void> {
  const ctx = await ticketContext(i);
  if (!ctx) return;
  const { channel, meta, cat, ranks } = ctx;
  if (!isStaff(i.member as GuildMember, cat, ranks)) {
    await i.reply(ephemeral("Solo el staff puede reclamar tickets."));
    return;
  }
  if (meta.claimerId) {
    await i.reply(ephemeral(`Este ticket ya lo reclamó <@${meta.claimerId}>.`));
    return;
  }
  await saveMeta(channel.guild.id, channel.id, { ...meta, claimerId: i.user.id });
  await i.update({ components: [controlRow(true)] });
  await channel.send(`${CLAIM_EMOJI} <@${i.user.id}> reclamó este ticket y lo va a atender.`);
}

async function deriveTicket(i: ButtonInteraction): Promise<void> {
  const ctx = await ticketContext(i);
  if (!ctx) return;
  const { channel, meta, ranks } = ctx;
  if (!meta.claimerId) {
    await i.reply(ephemeral("Todavía nadie reclamó este ticket."));
    return;
  }
  if (meta.claimerId !== i.user.id) {
    await i.reply(ephemeral("Solo quien tiene el ticket reclamado puede derivarlo."));
    return;
  }

  const member = i.member as GuildMember;
  const rank = findRank(roleIds(member), ranks);
  const tierUp = rank ? nextTierUp(rank.role, ranks) : null;
  if (!tierUp) {
    await i.reply(ephemeral("No hay un rango superior al tuyo para derivar este ticket."));
    return;
  }


  await saveMeta(channel.guild.id, channel.id, { ...meta, claimerId: null });
  await i.update({ components: [controlRow(false)] });
  await channel.send(
    `${DERIVE_EMOJI} <@${i.user.id}> derivó este ticket. Se pide atención de: ${tierUp.map((id) => `<@&${id}>`).join(" ")}`,
  );
}

async function handleRate(i: ButtonInteraction): Promise<void> {
  const parts = i.customId.slice("ticket:rate:".length).split(":");
  // Formato viejo (antes de ser multi-servidor): ticketId:rating, del servidor original.
  const [guildId, ticketId, rating] = parts.length === 3 ? parts : [process.env.GUILD_ID, ...parts];
  if (!guildId || !ticketId || !isRating(rating)) {
    await i.reply(ephemeral("Esta encuesta ya no es válida."));
    return;
  }
  const record = await rateTicket(guildId, ticketId, i.user.id, rating);
  if (!record) {
    await i.reply(ephemeral("Esta encuesta ya no es válida (puede que ya la hayas respondido)."));
    return;
  }
  await i.update({ components: [] });
  await i.followUp(ephemeral("¡Gracias por tu respuesta! Nos ayuda a mejorar el servicio del staff."));
  const guild = await i.client.guilds.fetch(guildId).catch(() => null);
  if (guild) await announceFeedback(guild, record.claimerId, rating);
}

async function announceFeedback(guild: Guild, staffId: string, rating: Rating): Promise<void> {
  const cfg = await getConfig(guild.id);
  if (!cfg.logChannelId) return;
  const channel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const stats = await getStaffStats(guild.id, staffId);
  const embed = (await ticketEmbed(guild))
    .setTitle(`${TICKET_EMOJI} Nuevo feedback de ticket`)
    .setDescription(`<@${staffId}> recibió una calificación: ${ratingLabel(rating)}.\n\n**Stats actuales**\n${statsText(stats)}`);
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function collectMessages(channel: TextChannel): Promise<TranscriptEntry[]> {
  const out: TranscriptEntry[] = [];
  let before: string | undefined;
  while (out.length < MAX_TRANSCRIPT_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    for (const m of batch.values()) {
      const embedText = m.embeds.map((e) => e.title ?? e.description ?? "").filter(Boolean).join(" / ");
      out.push({
        time: m.createdAt,
        author: m.author.tag,
        content: m.content || (embedText ? `[embed] ${embedText}` : ""),
        attachments: [...m.attachments.values()].map((a) => a.url),
      });
    }
    before = batch.last()?.id;
    if (batch.size < 100 || !before) break;
  }
  return out;
}

async function closeTicket(i: ButtonInteraction): Promise<void> {
  const ctx = await ticketContext(i);
  if (!ctx) return;
  const { channel, meta, cat, ranks } = ctx;
  const allowed = meta.openerId === i.user.id || isStaff(i.member as GuildMember, cat, ranks);
  if (!allowed) {
    await i.reply(ephemeral("Solo quien abrió el ticket o el staff puede cerrarlo."));
    return;
  }
  if (closing.has(channel.id)) {
    await i.reply(ephemeral("Este ticket ya se está cerrando."));
    return;
  }
  await i.reply(`${CLOSE_EMOJI} Cerrando el ticket y guardando la transcripción…`);
  await finishTicket(channel, meta, cat, i.user, `Cerrado por ${i.user.tag}`);
}

/**
 * Cierra un ticket: guarda la transcripción, la manda al canal de registros y por DM (con la
 * encuesta), y borra el canal. Lo usan el botón "Cerrar" y el cierre automático por inactividad.
 * `closedBy` es quien lo cerró (el bot, si fue automático).
 */
async function finishTicket(channel: TextChannel, meta: TicketMeta, cat: ResolvedCategory, closedBy: User, reason: string): Promise<void> {
  const guild = channel.guild;
  if (closing.has(channel.id)) return;
  closing.add(channel.id);

  try {
    const entries = await collectMessages(channel);
    const opener = await guild.client.users.fetch(meta.openerId).catch(() => null);
    const claimer = meta.claimerId ? await guild.client.users.fetch(meta.claimerId).catch(() => null) : null;
    const text = buildTranscript(
      {
        channel: channel.name,
        category: cat.label,
        opener: opener ? `${opener.tag} (${opener.id})` : meta.openerId,
        claimedBy: claimer ? claimer.tag : (meta.claimerId ?? undefined),
        closedBy: closedBy.tag,
        closedAt: new Date(),
      },
      entries,
    );
    const makeFile = () => new AttachmentBuilder(Buffer.from(text, "utf8"), { name: `transcripcion-${channel.name}.txt` });

    if (meta.claimerId) {
      const transcriptPath = await saveTranscript(guild.id, channel.id, text);
      await recordTicketClosed(guild.id, {
        id: channel.id,
        claimerId: meta.claimerId,
        openerId: meta.openerId,
        category: cat.label,
        closedAt: Date.now(),
        transcriptPath,
      });
    }

    const cfg = await getConfig(guild.id);
    const logChannel = cfg.logChannelId ? await guild.channels.fetch(cfg.logChannelId).catch(() => null) : null;
    if (logChannel && logChannel.type === ChannelType.GuildText) {
      const embed = (await ticketEmbed(guild))
        .setTitle(`${TICKET_EMOJI} Ticket cerrado: ${channel.name}`)
        .addFields(
          { name: "Categoría", value: cat.label, inline: true },
          { name: "Abierto por", value: `<@${meta.openerId}>`, inline: true },
          { name: "Atendido por", value: meta.claimerId ? `<@${meta.claimerId}>` : "—", inline: true },
          { name: "Cerrado por", value: closedBy.id === guild.client.user.id ? "🤖 automático (inactividad)" : `<@${closedBy.id}>`, inline: true },
        );
      await logChannel
        .send({ embeds: [embed], files: [makeFile()] })
        .catch((err) => log.error("tickets", `No pude mandar la transcripción al canal de registros de ${guild.name}`, err));
    }

    // Copia al usuario por mensaje directo (puede tenerlos cerrados: no es un error), con la
    // encuesta de satisfacción si alguien llegó a reclamar el ticket.
    try {
      const content = meta.claimerId
        ? "Tu ticket fue cerrado. Te dejamos la transcripción.\n\n¿Cómo te atendieron? Nos ayuda a seguir mejorando:"
        : "Tu ticket fue cerrado. Te dejamos la transcripción.";
      await opener?.send({
        content,
        files: [makeFile()],
        components: meta.claimerId ? [rateRow(guild.id, channel.id)] : [],
      });
    } catch {
      /* mensajes directos desactivados */
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
    await saveMeta(guild.id, channel.id, null);
    await channel.delete(reason);
    log.info("tickets", `Ticket #${channel.name} en ${guild.name}: ${reason}.`);
  } finally {
    closing.delete(channel.id);
  }
}

/** Canal de registros configurado (si lo hay), para que otros sistemas avisen ahí al prender el bot. */
export const getLogChannelId = async (guildId: string): Promise<string | undefined> => (await getConfig(guildId)).logChannelId;

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  if (!cfg.categoryId || !cfg.logChannelId) {
    return { label: "Tickets", ok: false, detail: "no configurados (falta `/ticket config`)" };
  }
  const categoryProblem = await channelProblem(guild, cfg.categoryId, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]);
  if (categoryProblem) return { label: "Tickets", ok: false, detail: `categoría: ${categoryProblem}` };
  const logProblem = await channelProblem(guild, cfg.logChannelId, [...TEXT_PERMS, PermissionFlagsBits.AttachFiles]);
  if (logProblem) return { label: "Tickets", ok: false, detail: `registros: ${logProblem}` };
  const rolesProblem = guildPermissionProblem(guild, [PermissionFlagsBits.ManageRoles]);
  if (rolesProblem) return { label: "Tickets", ok: false, detail: `${rolesProblem} (lo necesito para dar acceso a cada ticket)` };

  // Sin rangos de staff, los tickets quedan visibles solo para quien los abre y los admins: mejor avisarlo.
  const base = `categoría <#${cfg.categoryId}>, registros <#${cfg.logChannelId}>`;
  if ((await getRanks(guild)).length === 0) {
    return { label: "Tickets", ok: true, detail: `${base} (⚠️ no hay rangos de staff: solo los admins van a ver los tickets, ver \`/staff\`)` };
  }
  return { label: "Tickets", ok: true, detail: base };
}

export const tickets: Feature = {
  name: "tickets",
  commands: [ticketCommand],
  register(client: Client): void {
    client.once(Events.ClientReady, (c) => {
      let running = false;
      setInterval(() => {
        if (running) return;
        running = true;
        checkInactivity(c)
          .catch((err) => log.error("tickets", "Error revisando tickets inactivos", err))
          .finally(() => {
            running = false;
          });
      }, INACTIVITY_TICK_MS).unref();
    });
    // Si alguien borra un ticket a mano, que no quede su estado guardado para siempre.
    client.on(Events.ChannelDelete, (channel) => {
      if (channel.isDMBased() || closing.has(channel.id)) return;
      getAllMeta(channel.guild.id)
        .then((all) => (all[channel.id] ? saveMeta(channel.guild.id, channel.id, null) : undefined))
        .catch(() => {});
    });
  },
  checkHealth,
  async handleInteraction(interaction: Interaction): Promise<boolean> {
    if (interaction.isModalSubmit() && interaction.customId.startsWith(FORM_PREFIX)) {
      await handleForm(interaction);
      return true;
    }
    if (!interaction.isButton()) return false;
    const id = interaction.customId;
    if (id.startsWith("ticket:open:")) {
      await openTicket(interaction, id.slice("ticket:open:".length));
      return true;
    }
    if (id === "ticket:claim") {
      await claimTicket(interaction);
      return true;
    }
    if (id === "ticket:close") {
      await closeTicket(interaction);
      return true;
    }
    if (id === "ticket:derive") {
      await deriveTicket(interaction);
      return true;
    }
    if (id.startsWith("ticket:rate:")) {
      await handleRate(interaction);
      return true;
    }
    return false;
  },
};
