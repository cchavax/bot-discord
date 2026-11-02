/** Sistema: contador de miembros (el nombre de un canal de voz muestra cuántos hay). */
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type Guild,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { channelProblem } from "../health.js";
import { log } from "../log.js";
import { getValue, setValue } from "../store.js";
import type { Command, Feature, HealthCheck } from "../types.js";
import { ephemeral } from "../ui.js";

const CONFIG_KEY = "memberCount";
// Discord solo deja renombrar un canal 2 veces cada 10 minutos: nunca actualizamos más seguido que eso.
const MIN_UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const COUNTER_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] as const;

interface MemberCountConfig {
  channelId?: string;
}

const getConfig = (guildId: string): Promise<MemberCountConfig> => getValue<MemberCountConfig>(guildId, CONFIG_KEY, {});

export const formatCounterName = (count: number): string => `👥 Miembros: ${count}`;

// Última actualización por servidor (cada canal tiene su propio límite de Discord).
const lastUpdate = new Map<string, number>();

async function updateCounter(guild: Guild, force = false): Promise<void> {
  const cfg = await getConfig(guild.id);
  if (!cfg.channelId) return;
  if (!force && Date.now() - (lastUpdate.get(guild.id) ?? 0) < MIN_UPDATE_INTERVAL_MS) return;

  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) return;

  const name = formatCounterName(guild.memberCount);
  if (channel.name === name) return;
  lastUpdate.set(guild.id, Date.now());
  await channel
    .setName(name, "Actualización del contador de miembros")
    .catch((err) => log.warn("contador", `No pude renombrar el canal del contador en ${guild.name}: ${(err as Error).message}`));
}

const counterCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("contador")
    .setDescription("Contador de miembros en un canal de voz")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((s) =>
      s
        .setName("config")
        .setDescription("Define el canal de voz que muestra el contador de miembros")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Canal de voz a renombrar")
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const canal = interaction.options.getChannel("canal", true);
    await setValue(guild.id, CONFIG_KEY, { channelId: canal.id } satisfies MemberCountConfig);
    const problem = await channelProblem(guild, canal.id, COUNTER_PERMS);
    await interaction.reply(
      ephemeral(
        problem
          ? `✅ Contador configurado en <#${canal.id}>.\n\n⚠️ Ojo: ${problem}. Así no lo puedo renombrar.`
          : `✅ Contador configurado en <#${canal.id}>. Se actualiza solo (como mucho cada 10 minutos, por un límite de Discord).`,
      ),
    );
    await updateCounter(guild, true);
  },
};

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const cfg = await getConfig(guild.id);
  if (!cfg.channelId) return { label: "Contador de miembros", ok: false, detail: "no configurado (falta `/contador config`)" };
  const problem = await channelProblem(guild, cfg.channelId, COUNTER_PERMS);
  if (problem) return { label: "Contador de miembros", ok: false, detail: problem };
  return { label: "Contador de miembros", ok: true, detail: `canal <#${cfg.channelId}>` };
}

export const memberCount: Feature = {
  name: "memberCount",
  commands: [counterCommand],
  checkHealth,
  register(client: Client): void {
    client.once(Events.ClientReady, (c) => {
      for (const guild of c.guilds.cache.values()) updateCounter(guild, true).catch(() => {});
    });
    client.on(Events.GuildMemberAdd, (member) => {
      updateCounter(member.guild).catch(() => {});
    });
    client.on(Events.GuildMemberRemove, (member) => {
      updateCounter(member.guild).catch(() => {});
    });
    // Por si entraron o salieron varios dentro de la ventana de 10 minutos: se corrige en la próxima vuelta.
    setInterval(() => {
      for (const guild of client.guilds.cache.values()) updateCounter(guild).catch(() => {});
    }, MIN_UPDATE_INTERVAL_MS).unref();
  },
};
