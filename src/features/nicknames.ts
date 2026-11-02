/** Sistema 1: tags de apodo sincronizados con el rol de staff. */
import {
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type GuildMember,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { log } from "../log.js";
import { desiredNick, findRank, rankChanged } from "../nickLogic.js";
import type { Rank } from "../ranks.js";
import type { Command, Feature } from "../types.js";
import { getRanks, roleIds } from "./staff.js";

type SyncResult = "ok" | "igual" | "skip" | "error";

function targetNick(member: GuildMember, ranks: readonly Rank[]): string | null {
  const rank = findRank(roleIds(member), ranks);
  const fallback = member.user.globalName ?? member.user.username;
  return desiredNick(member.nickname, fallback, rank, ranks);
}

export async function syncMember(member: GuildMember, ranks: readonly Rank[]): Promise<SyncResult> {
  if (member.user.bot) return "igual";
  // Discord no permite que un bot cambie el apodo del dueño del servidor.
  if (member.id === member.guild.ownerId) return "skip";

  const target = targetNick(member, ranks);
  if (target === member.nickname) return "igual";

  try {
    await member.setNickname(target, "Sincronización de tag de staff");
    return "ok";
  } catch (err) {
    log.warn("tags", `No pude cambiar el apodo de ${member.user.tag} en ${member.guild.name} (¿mi rol está por debajo del suyo?): ${(err as Error).message}`);
    return "error";
  }
}

const tagsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("tags")
    .setDescription("Tags de apodo del staff")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s.setName("sincronizar").setDescription("Aplica el tag a todo el staff de una vez (uso manual)"),
    )
    .addSubcommand((s) =>
      s
        .setName("ver")
        .setDescription("Muestra qué apodo le correspondería a un miembro")
        .addUserOption((o) => o.setName("miembro").setDescription("Miembro a consultar").setRequired(true)),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    if (interaction.options.getSubcommand() === "sincronizar") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Si Discord frena el pedido (pasa justo después de prender), alcanza con los que ya están cargados.
      const members = await guild.members.fetch().catch(() => guild.members.cache);
      const ranks = await getRanks(guild);
      if (ranks.length === 0) {
        await interaction.editReply("⚠️ Este servidor no tiene rangos de staff. Sumalos con `/staff rango agregar`.");
        return;
      }
      const counts: Record<SyncResult, number> = { ok: 0, igual: 0, skip: 0, error: 0 };
      for (const member of members.values()) {
        counts[await syncMember(member, ranks)]++;
      }
      let msg =
        `✅ Actualizados: **${counts.ok}**\n` +
        `➖ Sin cambios: **${counts.igual}**\n` +
        `⏭️ Omitidos (dueño del servidor): **${counts.skip}**\n` +
        `⚠️ Con error: **${counts.error}**`;
      if (counts.error > 0) {
        msg +=
          "\n\nLos errores suelen ser porque el rol del bot está **por debajo** del rol de esa " +
          "persona. Subí el rol del bot en Ajustes → Roles.";
      }
      await interaction.editReply(msg);
      return;
    }

    // subcomando "ver"
    const user = interaction.options.getUser("miembro", true);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Esa persona no está en el servidor." });
      return;
    }
    const ranks = await getRanks(guild);
    const rank = findRank(roleIds(member), ranks);
    const target = targetNick(member, ranks);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
      content:
        `Rango detectado: ${rank ? `<@&${rank.role}>` : "**ninguno (no es staff)**"}\n` +
        `Apodo actual: \`${member.nickname ?? "(sin apodo)"}\`\n` +
        `Apodo correspondiente: \`${target ?? "(sin apodo)"}\``,
    });
  },
};

export const nicknames: Feature = {
  name: "nicknames",
  commands: [tagsCommand],
  register(client: Client): void {
    // Cargamos todos los miembros al arrancar para tener el estado "anterior" de cada uno
    // y poder detectar qué rol se agregó o se quitó.
    client.once(Events.ClientReady, async (c) => {
      for (const guild of c.guilds.cache.values()) {
        await guild.members.fetch().catch((err) => log.warn("tags", `No pude cargar los miembros de ${guild.name}: ${(err as Error).message}`));
      }
    });
    client.on(Events.GuildCreate, (guild) => {
      guild.members.fetch().catch(() => {});
    });

    // El tag SOLO cambia cuando cambia el rango principal de alguien.
    // Cambios de apodo o de roles que no son de rango (Eventos, Builders...) no hacen nada.
    client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
      if (oldMember.partial) return; // sin estado anterior no se puede saber si cambió el rango
      const ranks = await getRanks(newMember.guild);
      if (!rankChanged(roleIds(oldMember), roleIds(newMember), ranks)) return;
      await syncMember(newMember, ranks);
    });
  },
};
