/**
 * Sistema: agradecimiento por boost. Cuando alguien booster el servidor, se manda un embed al
 * canal configurado agradeciendo el apoyo, con la recompensa (si ya se definió) y la indicación
 * de reclamarla abriendo un ticket.
 *
 * También arma el panel combinado de recompensas (`/recompensas panel`): una sola publicación
 * que junta los hitos de invitaciones y la recompensa de boost, y se actualiza sola si cambian.
 */
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  type EmbedBuilder,
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
import { brandEmbed, ephemeral } from "../ui.js";
import { getMilestones } from "./invites/index.js";

const CONFIG_KEY = "boosts";
const PANEL_KEY = "rewardsPanel";
const BOOST_FOOTER = "Sistema de Boosts";
const REWARDS_FOOTER = "Sistema de Recompensas";
const BOOST_COLOR = 0xf47fff; // rosa/violeta, el color de los boosts de Discord
// Emoji de "recompensa" para el panel combinado (distinto del :gift: que usan los sorteos).
const GIFT_EMOJI = "<a:gift:1565408638913482763>";
const BOOST_EMOJI = "<a:boost:1565407668171186268>";
const HEART_EMOJI = "<a:boost_gems_month_24:1565408940714623017>";
const HEARTS_EMOJI = "<a:flyingredhearts:1565413398303215766>";
const REWARDS_COLOR = 0xe74c3c; // rojo
const MEMBER_EMOJI = "<:19492membres:1565184515293581492>";
const DEFAULT_REWARD = "Por definir";

interface BoostsConfig {
  channelId?: string;
  reward?: string;
}

interface RewardsPanelRef {
  channelId: string;
  messageId: string;
}

const getConfig = (guildId: string): Promise<BoostsConfig> => getValue<BoostsConfig>(guildId, CONFIG_KEY, {});
const setConfig = (guildId: string, cfg: BoostsConfig): Promise<void> => setValue(guildId, CONFIG_KEY, cfg);
const getPanelRef = (guildId: string): Promise<RewardsPanelRef | null> => getValue<RewardsPanelRef | null>(guildId, PANEL_KEY, null);
const setPanelRef = (guildId: string, ref: RewardsPanelRef | null): Promise<void> => setValue(guildId, PANEL_KEY, ref);

// ---------- panel combinado: hitos de invitaciones + recompensa de boost ----------
async function buildRewardsEmbed(guild: Guild): Promise<EmbedBuilder> {
  const milestones = await getMilestones(guild.id);
  const reward = (await getConfig(guild.id)).reward ?? DEFAULT_REWARD;

  const invitesText =
    milestones.length === 0
      ? "Todavía no hay hitos configurados."
      : milestones.map((m) => `${GIFT_EMOJI} **${m.count}** invitados verificados → ${m.reward}`).join("\n");

  return (await brandEmbed(guild))
    .setColor(REWARDS_COLOR)
    .setTitle(`${GIFT_EMOJI} Recompensas del servidor`)
    .setDescription(`${HEARTS_EMOJI} En agradecimiento a ustedes, ofrecemos estas recompensas por apoyar al servidor desde donde puedan.`)
    .addFields(
      { name: `${MEMBER_EMOJI} Por invitar`, value: invitesText },
      { name: `${BOOST_EMOJI} Por boostear`, value: `${GIFT_EMOJI} ${reward}` },
    )
    .setFooter({ text: REWARDS_FOOTER, iconURL: guild.client.user.displayAvatarURL() });
}

/** Si hay un panel de recompensas fijado, lo edita. No hace nada si no hay uno. */
async function refreshRewardsPanel(guild: Guild): Promise<void> {
  const ref = await getPanelRef(guild.id);
  if (!ref) return;
  const channel = await guild.channels.fetch(ref.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await channel.messages.fetch(ref.messageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [await buildRewardsEmbed(guild)] }).catch(() => {});
}

// ---------- evento: alguien empieza a boostear ----------
async function onBoost(member: GuildMember): Promise<void> {
  const cfg = await getConfig(member.guild.id);
  if (!cfg.channelId) return;
  const channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const reward = cfg.reward ?? DEFAULT_REWARD;
  const embed = (await brandEmbed(member.guild))
    .setColor(BOOST_COLOR)
    .setTitle(`${HEART_EMOJI} ¡Gracias por boostear el servidor!`)
    .setDescription(
      `<@${member.id}> acaba de boostear. ¡Gracias por bancar al servidor! ${HEART_EMOJI}\n\n` +
        `Recompensa: ${BOOST_EMOJI} **${reward}**\n\nPara reclamarla, abrí un ticket y contanos.`,
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setFooter({ text: BOOST_FOOTER, iconURL: member.client.user.displayAvatarURL() });

  await channel.send({ embeds: [embed] }).catch((err) => log.error("boosts", `No pude avisar el boost de ${member.user.tag}`, err));
}

// ---------- comandos ----------
const boostCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("boost")
    .setDescription("Sistema de agradecimiento por boost")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define el canal donde se agradece a quien booste a")
        .addChannelOption((o) =>
          o.setName("canal").setDescription("Canal de agradecimientos").addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("recompensa")
        .setDescription("Define qué se gana por boostear")
        .addStringOption((o) => o.setName("texto").setDescription("Ej: Rol Booster + 500 monedas").setRequired(true).setMaxLength(100)),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();
    const cfg = await getConfig(guild.id);

    if (sub === "config") {
      const canal = interaction.options.getChannel("canal", true);
      await setConfig(guild.id, { ...cfg, channelId: canal.id });
      const problem = await channelProblem(guild, canal.id);
      await interaction.reply(
        ephemeral(
          `✅ Canal de agradecimientos por boost configurado en <#${canal.id}>.` + (problem ? `\n\n⚠️ Ojo: ${problem}.` : ""),
        ),
      );
      return;
    }

    // sub === "recompensa"
    const texto = interaction.options.getString("texto", true).trim();
    await setConfig(guild.id, { ...cfg, reward: texto });
    await refreshRewardsPanel(guild);
    await interaction.reply(ephemeral(`✅ Recompensa por boostear: ${texto}`));
  },
};

const rewardsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("recompensas")
    .setDescription("Panel combinado de recompensas (invitaciones y boost)")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("panel")
        .setDescription("Publica (o re-fija) el panel de recompensas")
        .addChannelOption((o) =>
          o.setName("canal").setDescription("Canal donde publicarlo (por defecto, este)").addChannelTypes(ChannelType.GuildText),
        ),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const targetId = interaction.options.getChannel("canal")?.id ?? interaction.channelId;
    const target = await guild.channels.fetch(targetId).catch(() => null);
    if (!target || target.type !== ChannelType.GuildText) {
      await interaction.reply(ephemeral("⚠️ Elegí un canal de texto para publicar el panel."));
      return;
    }
    const message = await target.send({ embeds: [await buildRewardsEmbed(guild)] }).catch(() => null);
    if (!message) {
      const problem = await channelProblem(guild, target.id);
      await interaction.reply(ephemeral(`⚠️ No pude publicar el panel en <#${target.id}>${problem ? `: ${problem}` : "."}`));
      return;
    }
    await setPanelRef(guild.id, { channelId: target.id, messageId: message.id });
    await interaction.reply(ephemeral(`✅ Panel de recompensas publicado en <#${target.id}>. Se va a actualizar solo.`));
  },
};

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  if (!cfg.channelId) return { label: "Boosts", ok: false, detail: "no configurado (falta `/boost config`)" };
  const problem = await channelProblem(guild, cfg.channelId);
  if (problem) return { label: "Boosts", ok: false, detail: problem };
  if (!cfg.reward) return { label: "Boosts", ok: true, detail: `canal <#${cfg.channelId}> (falta la recompensa: \`/boost recompensa\`)` };
  return { label: "Boosts", ok: true, detail: `canal <#${cfg.channelId}>` };
}

export const boosts: Feature = {
  name: "boosts",
  commands: [boostCommand, rewardsCommand],
  checkHealth,
  register(client: Client): void {
    client.on(Events.GuildMemberUpdate, (before, after) => {
      if (!before.premiumSince && after.premiumSince) {
        onBoost(after).catch((err) => log.error("boosts", "Error al agradecer un boost", err));
      }
    });
  },
};
