/**
 * Sistema 5a: sugerencias. Los botones 👍/👎 son el voto de la gente (cualquiera puede tocarlos,
 * y se puede cambiar o sacar el voto); el tercero, con el lápiz, es el que usa el staff para
 * aprobar o rechazar la sugerencia (abre un modal para poner el motivo).
 */
import {
  ActionRowBuilder,
  type ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
  type Interaction,
  InteractionContextType,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { TEXT_PERMS, channelProblem } from "../health.js";
import { getValue, setValue } from "../store.js";
import type { Command, Feature, HealthCheck } from "../types.js";
import { brandEmbed, ephemeral } from "../ui.js";

const CONFIG_KEY = "suggestions";
const VOTES_KEY = "suggestionVotes";
const LIKE_BUTTON_ID = "suggestion:vote:like";
const DISLIKE_BUTTON_ID = "suggestion:vote:dislike";
const RESOLVE_BUTTON_ID = "suggestion:resolve";
const RESOLVE_MODAL_PREFIX = "suggestion:resolve:";

const SUGGESTION_EMOJI = "<a:lightbulb:1565387032723988563>";
const CLOCK_EMOJI = "<:icon_clock:1565386192193716364>";
// Voto de la gente (botones 1 y 2).
const LIKE_EMOJI = "<:84613like:1565185331685359727>";
const DISLIKE_EMOJI = "<:63157dislike:1565185083206537287>";
// Decisión del staff (botón 3, con motivo): check/cruz, distintos del like/dislike del voto.
const RESOLVE_EMOJI = "<:11569crayon:1565184356782182430>";
const ACCEPT_EMOJI = "<:60226check:1565185016537948240>";
const REJECT_EMOJI = "<:19463croix:1565184487090819104>";

const SUGGESTION_FOOTER = "Sistema de Sugerencias";
const PENDING_COLOR = 0xf1c40f;
const SUGGESTION_PERMS = [...TEXT_PERMS, PermissionFlagsBits.ReadMessageHistory] as const;

interface SuggestionsConfig {
  channelId?: string;
}

interface VoteRecord {
  like: string[];
  dislike: string[];
}

const getConfig = (guildId: string): Promise<SuggestionsConfig> => getValue<SuggestionsConfig>(guildId, CONFIG_KEY, {});

// Votos por mensaje de sugerencia: quién tocó like y quién dislike (para poder cambiar o sacar el voto).
const getVotes = (guildId: string): Promise<Record<string, VoteRecord>> =>
  getValue<Record<string, VoteRecord>>(guildId, VOTES_KEY, {});
const setVotes = (guildId: string, data: Record<string, VoteRecord>): Promise<void> => setValue(guildId, VOTES_KEY, data);

function suggestionRow(votes: VoteRecord | undefined, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(LIKE_BUTTON_ID)
      .setLabel(`${votes?.like.length ?? 0}`)
      .setEmoji(LIKE_EMOJI)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(DISLIKE_BUTTON_ID)
      .setLabel(`${votes?.dislike.length ?? 0}`)
      .setEmoji(DISLIKE_EMOJI)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder().setCustomId(RESOLVE_BUTTON_ID).setEmoji(RESOLVE_EMOJI).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

/** Embed con el estado ya resuelto (aceptada/rechazada), con motivo opcional. */
function resolvedEmbed(original: Parameters<typeof EmbedBuilder.from>[0], accepted: boolean, userId: string, motivo: string): EmbedBuilder {
  const estado = accepted ? `${ACCEPT_EMOJI} Aceptada por <@${userId}>` : `${REJECT_EMOJI} Rechazada por <@${userId}>`;
  return EmbedBuilder.from(original)
    .setColor(accepted ? 0x00ff00 : 0xff0000)
    .setFields({ name: "Estado", value: motivo ? `${estado}\n${motivo}` : estado });
}

// ---------- comandos ----------
const configCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("sugerencias")
    .setDescription("Configuración del sistema de sugerencias")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define el canal donde se publican las sugerencias")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Canal de sugerencias")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const canal = interaction.options.getChannel("canal", true);
    await setValue(guild.id, CONFIG_KEY, { channelId: canal.id } satisfies SuggestionsConfig);
    const problem = await channelProblem(guild, canal.id, SUGGESTION_PERMS);
    await interaction.reply(
      ephemeral(
        `✅ Canal de sugerencias configurado en <#${canal.id}>.` +
          (problem ? `\n\n⚠️ Ojo: ${problem}.` : "\nLos miembros ya pueden usar `/sugerir`."),
      ),
    );
  },
};

const suggestCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("sugerir")
    .setDescription("Mandá una sugerencia para el servidor")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName("texto").setDescription("Tu sugerencia").setRequired(true).setMaxLength(1000))
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const cfg = await getConfig(guild.id);
    if (!cfg.channelId) {
      await interaction.reply(ephemeral("⚠️ Todavía no hay canal de sugerencias configurado. Avisale a un admin."));
      return;
    }
    const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply(ephemeral("⚠️ El canal de sugerencias configurado ya no existe. Avisale a un admin."));
      return;
    }

    const texto = interaction.options.getString("texto", true);
    const embed = (await brandEmbed(guild))
      .setColor(PENDING_COLOR)
      .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
      .setTitle(`${SUGGESTION_EMOJI} Sugerencia`)
      .setDescription(texto)
      .addFields({ name: "Estado", value: `${CLOCK_EMOJI} Pendiente` })
      .setThumbnail(interaction.user.displayAvatarURL())
      .setFooter({ text: SUGGESTION_FOOTER, iconURL: guild.client.user.displayAvatarURL() });

    const message = await channel.send({ embeds: [embed], components: [suggestionRow(undefined)] }).catch(() => null);
    if (!message) {
      await interaction.reply(ephemeral("⚠️ No pude publicar tu sugerencia (me faltan permisos en el canal). Avisale a un admin."));
      return;
    }
    await interaction.reply(ephemeral(`✅ Sugerencia publicada en <#${channel.id}>.`));
  },
};

// ---------- botones 1 y 2: la gente vota (cualquiera puede, y se puede cambiar o sacar el voto) ----------
async function vote(i: ButtonInteraction, like: boolean): Promise<void> {
  const guild = i.guild;
  if (!guild) return;
  const votes = await getVotes(guild.id);
  const record = votes[i.message.id] ?? { like: [], dislike: [] };
  const mine = like ? record.like : record.dislike;
  const other = like ? record.dislike : record.like;

  const idx = mine.indexOf(i.user.id);
  if (idx !== -1) {
    mine.splice(idx, 1); // ya había votado esto: lo saca
  } else {
    const otherIdx = other.indexOf(i.user.id);
    if (otherIdx !== -1) other.splice(otherIdx, 1); // tenía el voto contrario: se lo cambia
    mine.push(i.user.id);
  }

  votes[i.message.id] = record;
  await setVotes(guild.id, votes);
  await i.update({ components: [suggestionRow(record)] });
}

// ---------- botón 3: el staff aprueba o rechaza (abre un modal para el motivo) ----------
function buildResolveModal(channelId: string, messageId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${RESOLVE_MODAL_PREFIX}${channelId}:${messageId}`)
    .setTitle("Resolver sugerencia")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("decision")
          .setLabel("1 = Aprobar, 2 = Rechazar")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("1 o 2")
          .setRequired(true)
          .setMaxLength(2),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("motivo")
          .setLabel("Motivo (opcional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
}

async function openResolveModal(i: ButtonInteraction): Promise<void> {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await i.reply(ephemeral("⚠️ Solo el staff puede resolver sugerencias."));
    return;
  }
  // Sin llamadas a la API antes del modal: tiene que ser la primera respuesta.
  await i.showModal(buildResolveModal(i.channelId, i.message.id));
}

async function handleResolveModal(i: ModalSubmitInteraction): Promise<void> {
  const guild = i.guild;
  if (!guild) return;
  const [channelId, messageId] = i.customId.slice(RESOLVE_MODAL_PREFIX.length).split(":");
  const decisionRaw = i.fields.getTextInputValue("decision").trim();
  const motivo = i.fields.getTextInputValue("motivo").trim();
  const accepted = decisionRaw === "1";
  const rejected = decisionRaw === "2";
  if (!accepted && !rejected) {
    await i.reply(ephemeral("⚠️ Poné **1** para aprobar o **2** para rechazar."));
    return;
  }
  if (!channelId || !messageId) {
    await i.reply(ephemeral("⚠️ Algo salió mal. Probá de nuevo desde el botón."));
    return;
  }
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  const message = channel?.type === ChannelType.GuildText ? await channel.messages.fetch(messageId).catch(() => null) : null;
  const original = message?.embeds[0];
  if (!message || !original) {
    await i.reply(ephemeral("⚠️ No encontré el mensaje de la sugerencia (puede que se haya borrado)."));
    return;
  }

  const votes = (await getVotes(guild.id))[messageId];
  const embed = resolvedEmbed(original, accepted, i.user.id, motivo);
  await message.edit({ embeds: [embed], components: [suggestionRow(votes, true)] });
  await i.reply(ephemeral(`✅ Sugerencia ${accepted ? "aceptada" : "rechazada"}.`));
}

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  if (!cfg.channelId) return { label: "Sugerencias", ok: false, detail: "no configuradas (falta `/sugerencias config`)" };
  const problem = await channelProblem(guild, cfg.channelId, SUGGESTION_PERMS);
  if (problem) return { label: "Sugerencias", ok: false, detail: problem };
  return { label: "Sugerencias", ok: true, detail: `canal <#${cfg.channelId}>` };
}

export const suggestions: Feature = {
  name: "suggestions",
  commands: [configCommand, suggestCommand],
  checkHealth,
  register(): void {
    /* este sistema solo usa comandos, botones y un modal */
  },
  async handleInteraction(interaction: Interaction): Promise<boolean> {
    if (interaction.isModalSubmit() && interaction.customId.startsWith(RESOLVE_MODAL_PREFIX)) {
      await handleResolveModal(interaction);
      return true;
    }
    if (!interaction.isButton()) return false;
    if (interaction.customId === LIKE_BUTTON_ID) {
      await vote(interaction, true);
      return true;
    }
    if (interaction.customId === DISLIKE_BUTTON_ID) {
      await vote(interaction, false);
      return true;
    }
    if (interaction.customId === RESOLVE_BUTTON_ID) {
      await openResolveModal(interaction);
      return true;
    }
    return false;
  },
};
