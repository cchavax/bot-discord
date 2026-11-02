/**
 * Sistema 5c: sorteos. Los premios se cargan con un modal (uno por línea, "Premio" o "Premio x3"
 * para varias unidades), y cada ganador recibe un premio distinto por DM, con el aviso de que lo
 * reclame abriendo un ticket. Guarda cada sorteo activo en el store (data/config.json) para poder
 * retomarlo si el bot se reinicia: al prender, revisa los pendientes y si ya venció el tiempo los
 * cierra, o si no, programa el cierre para cuando corresponda.
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
  type Interaction,
  InteractionContextType,
  MessageFlags,
  type ModalSubmitInteraction,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { channelProblem } from "../../health.js";
import { log } from "../../log.js";
import { getValue, guildIds, setValue } from "../../store.js";
import type { Command, Feature } from "../../types.js";
import { brandEmbed, ephemeral, serverName } from "../../ui.js";
import { type PrizeEntry, expandPrizeSlots, parsePrizes, pickWinners } from "./logic.js";

const CONFIG_KEY = "giveaways";
const JOIN_BUTTON_ID = "giveaway:join";
const CREATE_MODAL_PREFIX = "giveaway:create:";
const PRIZES_FIELD_ID = "prizes";
const TITLE_FIELD_ID = "title";
const MAX_TIMEOUT_MS = 2_147_483_647; // límite de setTimeout en Node (~24,8 días)

const GIFT_EMOJI = "<:gift:1565168105997471815>";
const ACTIVE_EMOJI = "<a:green_loading:1565385841730388059>";
const ENDED_EMOJI = "<:invisible_offline_gray:1565168881675411586>";
const GIVEAWAY_EMOJI = "<a:giveaway:1565385637706862644>";
const WINNER_EMOJI = "<:23786proprietaire:1565184562802458644>";
const PARTICIPANT_EMOJI = "<:19492membres:1565184515293581492>";
const CLOCK_EMOJI = "<:icon_clock:1565386192193716364>";
const CANCEL_EMOJI = "<:67516moins:1565185182691229767>";
const GIVEAWAY_FOOTER = "Sistema de Sorteos";
const WINNER_COLOR = 0xe74c3c;

interface GiveawayData {
  channelId: string;
  title?: string;
  prizes: PrizeEntry[];
  endsAt: number;
  participants: string[];
}

interface GiveawaysStore {
  active: Record<string, GiveawayData>; // messageId -> datos
  /** Canal donde se avisa "sorteo activo" (por defecto, general), y rol al que se taggea. */
  announceChannelId?: string;
  announceRoleId?: string;
}

const getData = (guildId: string): Promise<GiveawaysStore> => getValue<GiveawaysStore>(guildId, CONFIG_KEY, { active: {} });
const setData = (guildId: string, data: GiveawaysStore): Promise<void> => setValue(guildId, CONFIG_KEY, data);

// En memoria: timers de los sorteos activos, para poder cancelarlos si se finalizan a mano.
const timeouts = new Map<string, NodeJS.Timeout>();

function joinRow(disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(JOIN_BUTTON_ID).setLabel("Participar").setEmoji(GIVEAWAY_EMOJI).setStyle(ButtonStyle.Success).setDisabled(disabled),
  );
}

/** Cómo se muestra el sorteo: activo, terminado con ganadores, o cancelado sin premios. */
type GiveawayState = "active" | "ended" | "cancelled";

async function buildEmbed(guild: Guild, giveaway: GiveawayData, state: GiveawayState): Promise<EmbedBuilder> {
  const ended = state !== "active";
  const prizesText = giveaway.prizes.map((p) => `${GIFT_EMOJI} **${p.name}**${p.quantity > 1 ? ` × ${p.quantity}` : ""}`).join("\n");
  const totalWinners = expandPrizeSlots(giveaway.prizes).length;
  const fields = [
    { name: `${WINNER_EMOJI} Ganadores`, value: `${totalWinners}`, inline: true },
    { name: `${PARTICIPANT_EMOJI} Participantes`, value: `${giveaway.participants.length}`, inline: true },
  ];
  if (!ended) fields.push({ name: `${CLOCK_EMOJI} Termina`, value: `<t:${Math.floor(giveaway.endsAt / 1000)}:R>`, inline: true });

  const name = giveaway.title?.trim() || "¡SORTEO!";
  // El color indica el estado (dorado = activo, gris = terminado), así que no usa el de la marca.
  return (await brandEmbed(guild))
    .setColor(ended ? 0x2b2d31 : 0xffd700)
    .setTitle(
      state === "active"
        ? `${ACTIVE_EMOJI}  ${name}  ${ACTIVE_EMOJI}`
        : `${ENDED_EMOJI}  ${name} — ${state === "cancelled" ? "Cancelado" : "Finalizado"}  ${ENDED_EMOJI}`,
    )
    .setDescription(
      state === "cancelled"
        ? `~~${prizesText.replace(/\n/g, "~~\n~~")}~~\n\n${CANCEL_EMOJI} Este sorteo se canceló: no hay ganadores.\n​`
        : prizesText,
    )
    .addFields(fields)
    .setFooter({ text: GIVEAWAY_FOOTER, iconURL: guild.client.user.displayAvatarURL() });
}

function scheduleEnd(client: Client, guildId: string, messageId: string, endsAt: number): void {
  // setTimeout no aguanta más de ~24,8 días: si el sorteo es más largo, se espera ese máximo y
  // se vuelve a programar (antes se cerraba antes de tiempo).
  const delay = Math.min(Math.max(endsAt - Date.now(), 0), MAX_TIMEOUT_MS);
  const timeout = setTimeout(() => {
    if (endsAt - Date.now() > 1000) {
      scheduleEnd(client, guildId, messageId, endsAt);
      return;
    }
    endGiveaway(client, guildId, messageId).catch((err) => log.error("sorteos", "Error finalizando sorteo", err));
  }, delay);
  timeouts.set(messageId, timeout);
}

async function notifyWinner(guild: Guild, userId: string, prize: string): Promise<void> {
  const user = await guild.client.users.fetch(userId).catch(() => null);
  if (!user) return;
  const embed = (await brandEmbed(guild))
    .setColor(WINNER_COLOR)
    .setTitle(`${GIVEAWAY_EMOJI} ¡Ganaste el sorteo!`)
    .setDescription(
      `Te ganaste: **${prize}**.\n\nPara reclamarlo, abrí un ticket en **${await serverName(guild)}** y contanos qué ganaste.`,
    )
    .setFooter({ text: GIVEAWAY_FOOTER, iconURL: guild.client.user.displayAvatarURL() });
  await user.send({ embeds: [embed] }).catch(() => {
    log.info("sorteos", `No pude mandarle el DM del sorteo a ${user.tag} (tiene los DMs cerrados).`);
  });
}

/** Termina un sorteo. Con `cancelled`, se cierra sin elegir ganadores ni repartir premios. */
async function endGiveaway(client: Client, guildId: string, messageId: string, cancelled = false): Promise<void> {
  const timeout = timeouts.get(messageId);
  if (timeout) clearTimeout(timeout);
  timeouts.delete(messageId);

  const data = await getData(guildId);
  const giveaway = data.active[messageId];
  if (!giveaway) return;
  delete data.active[messageId];
  await setData(guildId, data);

  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    log.warn("sorteos", `El canal del sorteo ${messageId} ya no existe: lo di por terminado sin anunciar ganadores.`);
    return;
  }
  const guild = channel.guild;

  const message = await channel.messages.fetch(messageId).catch(() => null);
  await message?.edit({ embeds: [await buildEmbed(guild, giveaway, cancelled ? "cancelled" : "ended")], components: [joinRow(true)] }).catch(() => {});

  if (cancelled) {
    await channel.send(`${CANCEL_EMOJI} El sorteo se canceló antes de tiempo, así que no hay ganadores.`).catch(() => {});
    log.info("sorteos", `Sorteo ${messageId} cancelado en ${guild.name} (tenía ${giveaway.participants.length} participante(s)).`);
    return;
  }

  const slots = expandPrizeSlots(giveaway.prizes);
  const winners = pickWinners(giveaway.participants, slots.length);
  const assignments = winners.map((userId, i) => ({ userId, prize: slots[i] ?? "un premio" }));

  const text =
    assignments.length > 0
      ? `${GIVEAWAY_EMOJI} ¡Felicitaciones! Para reclamar su premio, abran un ticket. Les mandamos los detalles por DM.\n\n` +
        assignments.map((a) => `${WINNER_EMOJI} <@${a.userId}> ganó **${a.prize}**`).join("\n")
      : "😕 Nadie participó en el sorteo.";
  await channel.send(text).catch(() => {});
  log.ok("sorteos", `Sorteo terminado en ${guild.name}: ${assignments.length} ganador(es) de ${giveaway.participants.length} participante(s).`);

  for (const { userId, prize } of assignments) await notifyWinner(guild, userId, prize);
}

function buildPrizesModal(customId: string): ModalBuilder {
  const title = new TextInputBuilder()
    .setCustomId(TITLE_FIELD_ID)
    .setLabel("Título (opcional)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("¡SORTEO DE HALLOWEEN!")
    .setRequired(false)
    .setMaxLength(100);
  const prizes = new TextInputBuilder()
    .setCustomId(PRIZES_FIELD_ID)
    .setLabel("Premios (uno por línea, ej: Diamante x3)")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Rango VIP x1\nDiamante x64 x3")
    .setRequired(true)
    .setMaxLength(1000);
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle("Crear sorteo")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(title),
      new ActionRowBuilder<TextInputBuilder>().addComponents(prizes),
    );
}

// ---------- comandos ----------
const giveawayCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("sorteo")
    .setDescription("Sistema de sorteos")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("crear")
        .setDescription("Crea un sorteo (los premios se cargan en una ventana aparte)")
        .addIntegerOption((o) => o.setName("dias").setDescription("Cuánto dura: días").setMinValue(0))
        .addIntegerOption((o) => o.setName("horas").setDescription("Cuánto dura: horas").setMinValue(0))
        .addIntegerOption((o) => o.setName("minutos").setDescription("Cuánto dura: minutos").setMinValue(0))
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Canal donde publicarlo (por defecto, este)")
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("finalizar")
        .setDescription("Termina un sorteo ya, sin esperar a que se cumpla el tiempo")
        .addStringOption((o) => o.setName("id_mensaje").setDescription("ID del mensaje del sorteo (te lo da el bot al crearlo)").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("cancelar")
        .setDescription("Cancela un sorteo: se termina ya, sin ganadores ni premios")
        .addStringOption((o) => o.setName("id_mensaje").setDescription("ID del mensaje del sorteo (te lo da el bot al crearlo)").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define dónde se avisa que hay un sorteo activo")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Canal donde se publicita (ej. el general)")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addRoleOption((o) => o.setName("rol").setDescription("Rol a taggear en el aviso (opcional)")),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "config") {
      const canal = interaction.options.getChannel("canal", true);
      const rol = interaction.options.getRole("rol");
      const data = await getData(guild.id);
      data.announceChannelId = canal.id;
      data.announceRoleId = rol?.id;
      await setData(guild.id, data);
      const problem = await channelProblem(guild, canal.id);
      await interaction.reply(
        ephemeral(
          `✅ Avisos de sorteos configurados.\n📢 Canal: <#${canal.id}>${rol ? `\n🎖️ Rol a taggear: <@&${rol.id}>` : ""}` +
            (problem ? `\n\n⚠️ Ojo: ${problem}.` : ""),
        ),
      );
      return;
    }

    if (sub === "finalizar" || sub === "cancelar") {
      const messageId = interaction.options.getString("id_mensaje", true).trim();
      const data = await getData(guild.id);
      if (!data.active[messageId]) {
        await interaction.reply(ephemeral("No encontré ningún sorteo activo con ese ID de mensaje."));
        return;
      }
      // Editar el mensaje, anunciar y mandar los DMs puede tardar más de 3 segundos.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const cancelled = sub === "cancelar";
      await endGiveaway(interaction.client, guild.id, messageId, cancelled);
      await interaction.editReply(cancelled ? "🚫 Sorteo cancelado: no se eligieron ganadores." : "✅ Sorteo finalizado.");
      return;
    }

    // sub === "crear"
    const dias = interaction.options.getInteger("dias") ?? 0;
    const horas = interaction.options.getInteger("horas") ?? 0;
    const minutos = dias * 1440 + horas * 60 + (interaction.options.getInteger("minutos") ?? 0);
    if (minutos <= 0) {
      await interaction.reply(ephemeral("⚠️ Decime cuánto dura el sorteo: al menos un día, hora o minuto."));
      return;
    }
    // Nada de llamadas a la API acá: hay que mostrar el modal dentro de los 3 segundos que da
    // Discord para responder, y un channels.fetch a veces ya tarda más que eso.
    const canalOption = interaction.options.getChannel("canal");
    const targetId = canalOption?.id ?? interaction.channelId;
    const targetType = canalOption?.type ?? interaction.channel?.type;
    if (targetType !== ChannelType.GuildText) {
      await interaction.reply(ephemeral("⚠️ Elegí un canal de texto para publicar el sorteo."));
      return;
    }

    await interaction.showModal(buildPrizesModal(`${CREATE_MODAL_PREFIX}${minutos}:${targetId}`));
  },
};

async function announceGiveaway(guild: Guild, messageUrl: string): Promise<void> {
  const data = await getData(guild.id);
  if (!data.announceChannelId) return;
  const channel = await guild.channels.fetch(data.announceChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const mention = data.announceRoleId ? `<@&${data.announceRoleId}> ` : "";
  await channel
    .send(`${ACTIVE_EMOJI} ${mention}¡Hay un sorteo activo! Vengan a participar ${GIVEAWAY_EMOJI} → ${messageUrl}`)
    .catch(() => {});
}

// ---------- modal: cargar los premios ----------
async function handleCreateModal(interaction: ModalSubmitInteraction): Promise<void> {
  // Lo que sigue hace varias llamadas a Discord y puede tardar más de 3 segundos:
  // difiero la respuesta ya mismo para no perder el token de la interacción.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [minutosStr, channelId] = interaction.customId.slice(CREATE_MODAL_PREFIX.length).split(":");
  const minutos = Number(minutosStr);
  const prizes = parsePrizes(interaction.fields.getTextInputValue(PRIZES_FIELD_ID));
  if (prizes.length === 0) {
    await interaction.editReply("⚠️ No pude leer ningún premio. Usá el formato `Premio x3` (uno por línea).");
    return;
  }
  if (!channelId) {
    await interaction.editReply("⚠️ Algo salió mal con el canal. Probá crear el sorteo de nuevo.");
    return;
  }

  const guild = interaction.guild;
  const channel = await guild?.channels.fetch(channelId).catch(() => null);
  if (!guild || !channel || channel.type !== ChannelType.GuildText) {
    await interaction.editReply("⚠️ El canal elegido ya no existe.");
    return;
  }

  const title = interaction.fields.getTextInputValue(TITLE_FIELD_ID).trim() || undefined;
  const giveaway: GiveawayData = {
    channelId: channel.id,
    title,
    prizes,
    endsAt: Date.now() + minutos * 60_000,
    participants: [],
  };
  const message = await channel.send({ embeds: [await buildEmbed(guild, giveaway, "active")], components: [joinRow()] }).catch(() => null);
  if (!message) {
    const problem = await channelProblem(guild, channel.id);
    await interaction.editReply(`⚠️ No pude publicar el sorteo en <#${channel.id}>${problem ? `: ${problem}` : "."}`);
    return;
  }

  const data = await getData(guild.id);
  data.active[message.id] = giveaway;
  await setData(guild.id, data);
  scheduleEnd(interaction.client, guild.id, message.id, giveaway.endsAt);
  await announceGiveaway(guild, message.url);
  log.ok("sorteos", `Sorteo creado en ${guild.name} (#${channel.name}), termina el ${new Date(giveaway.endsAt).toLocaleString("es-AR")}.`);

  await interaction.editReply(
    `✅ Sorteo publicado en <#${channel.id}>.\nID del mensaje (para \`/sorteo finalizar\`): \`${message.id}\``,
  );
}

// ---------- botón: participar ----------
async function join(i: ButtonInteraction): Promise<void> {
  const guild = i.guild;
  if (!guild) return;
  const data = await getData(guild.id);
  const giveaway = data.active[i.message.id];
  if (!giveaway) {
    await i.reply(ephemeral("Este sorteo ya terminó."));
    return;
  }
  if (giveaway.participants.includes(i.user.id)) {
    await i.reply(ephemeral("Ya estás participando en este sorteo."));
    return;
  }
  giveaway.participants.push(i.user.id);
  await setData(guild.id, data);
  await i.update({ embeds: [await buildEmbed(guild, giveaway, "active")] });
}

export const giveaways: Feature = {
  name: "giveaways",
  commands: [giveawayCommand],
  register(client: Client): void {
    client.once(Events.ClientReady, async () => {
      let resumed = 0;
      for (const guildId of await guildIds()) {
        const data = await getData(guildId);
        for (const [messageId, giveaway] of Object.entries(data.active)) {
          if (giveaway.endsAt <= Date.now()) {
            await endGiveaway(client, guildId, messageId).catch((err) => log.error("sorteos", "Error finalizando sorteo vencido", err));
          } else {
            scheduleEnd(client, guildId, messageId, giveaway.endsAt);
            resumed++;
          }
        }
      }
      if (resumed > 0) log.info("sorteos", `Retomé ${resumed} sorteo(s) activo(s) después del reinicio.`);
    });
  },
  async handleInteraction(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton() && interaction.customId === JOIN_BUTTON_ID) {
      await join(interaction);
      return true;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(CREATE_MODAL_PREFIX)) {
      await handleCreateModal(interaction);
      return true;
    }
    return false;
  },
};
