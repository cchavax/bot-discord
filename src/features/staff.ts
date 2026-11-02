/**
 * Rangos de staff de cada servidor. Los usan los tags de apodo, los tickets (quién atiende cada
 * categoría y a quién se deriva) y lo que venga después (moderación).
 *
 * - Si el servidor NO configuró nada, se usa la plantilla de src/ranks.ts buscando cada rol por
 *   nombre (así Aura Craft sigue andando igual que siempre).
 * - Con `/staff rango agregar` se arma una lista propia con los roles reales del servidor. El
 *   orden lo da la posición del rol en Discord (más arriba = rango más alto), así que no hay que
 *   ordenarlos a mano: alcanza con tener los roles bien ordenados en Ajustes → Roles.
 */
import {
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { RANKS, type Rank, normalizeRoleName, staffTiers } from "../ranks.js";
import { getValue, setValue } from "../store.js";
import type { Command, Feature, HealthCheck } from "../types.js";
import { brandEmbed, ephemeral } from "../ui.js";

const CONFIG_KEY = "staff";
const MAX_TAG = 20;

export interface StaffRankConfig {
  roleId: string;
  tag: string;
  short?: string;
  tier?: string;
}

interface StaffConfig {
  /** Si no está, se usa la plantilla por nombre. */
  ranks?: StaffRankConfig[];
}

const getConfig = (guildId: string): Promise<StaffConfig> => getValue<StaffConfig>(guildId, CONFIG_KEY, {});

/** Rangos de la plantilla que existen en el servidor, ya pasados a ID de rol. */
function templateRanks(guild: Guild): StaffRankConfig[] {
  const out: StaffRankConfig[] = [];
  for (const r of RANKS) {
    const role = guild.roles.cache.find((x) => normalizeRoleName(x.name) === normalizeRoleName(r.role));
    if (role) out.push({ roleId: role.id, tag: r.tag, short: r.short, tier: r.tier });
  }
  return out;
}

/**
 * Rangos de staff del servidor, de mayor a menor, con `role` = ID del rol.
 * Los roles que ya no existen se ignoran.
 */
export async function getRanks(guild: Guild): Promise<Rank[]> {
  const cfg = await getConfig(guild.id);
  if (!cfg.ranks) return templateRanks(guild).map((r) => ({ role: r.roleId, tag: r.tag, short: r.short, tier: r.tier }));

  return cfg.ranks
    .map((r) => ({ cfg: r, role: guild.roles.cache.get(r.roleId) }))
    .filter((x): x is { cfg: StaffRankConfig; role: NonNullable<typeof x.role> } => Boolean(x.role))
    .sort((a, b) => b.role.position - a.role.position)
    .map(({ cfg: r }) => ({ role: r.roleId, tag: r.tag, short: r.short, tier: r.tier }));
}

/** Si el servidor usa la plantilla por nombre (no configuró sus rangos). */
export const usesTemplate = async (guildId: string): Promise<boolean> => !(await getConfig(guildId)).ranks;

/** IDs de los roles del miembro, para pasarle a findRank/rankChanged junto con getRanks. */
export const roleIds = (member: Pick<GuildMember, "roles">): string[] => member.roles.cache.map((r) => r.id);

// ---------- comando ----------
const staffCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Rangos de staff de este servidor")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("rangos").setDescription("Muestra los rangos de staff y cómo se agrupan"))
    .addSubcommandGroup((g) =>
      g
        .setName("rango")
        .setDescription("Agregar o quitar rangos")
        .addSubcommand((s) =>
          s
            .setName("agregar")
            .setDescription("Suma un rol como rango de staff (o lo edita si ya estaba)")
            .addRoleOption((o) => o.setName("rol").setDescription("Rol del rango").setRequired(true))
            .addStringOption((o) =>
              o.setName("tag").setDescription("Texto entre corchetes en el apodo, ej. Mod Sr").setRequired(true).setMaxLength(MAX_TAG),
            )
            .addStringOption((o) =>
              o.setName("abreviatura").setDescription("Tag corto si el apodo no entra, ej. MSr").setMaxLength(MAX_TAG),
            )
            .addStringOption((o) =>
              o
                .setName("grupo")
                .setDescription("Rangos con el mismo grupo cuentan como el mismo nivel al derivar (ej. Moderador)")
                .setMaxLength(40),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName("quitar")
            .setDescription("Deja de considerar un rol como rango de staff")
            .addRoleOption((o) => o.setName("rol").setDescription("Rol a quitar").setRequired(true)),
        ),
    )
    .addSubcommand((s) =>
      s.setName("restablecer").setDescription("Vuelve a la plantilla por nombre (Owner, Head Staff, Admin Sr…)"),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();

    if (sub === "restablecer") {
      await setValue(guild.id, CONFIG_KEY, {} satisfies StaffConfig);
      await interaction.reply(ephemeral("✅ Volví a la plantilla de rangos por nombre. Mirá cómo quedó con `/staff rangos`."));
      return;
    }

    if (group === "rango") {
      const role = interaction.options.getRole("rol", true);
      const cfg = await getConfig(guild.id);
      // La primera vez que se toca algo, se parte de lo que ya se estaba usando (la plantilla),
      // así agregar un rango no hace desaparecer a todos los demás.
      const ranks = cfg.ranks ? [...cfg.ranks] : templateRanks(guild);
      const others = ranks.filter((r) => r.roleId !== role.id);

      if (sub === "quitar") {
        if (others.length === ranks.length) {
          await interaction.reply(ephemeral(`<@&${role.id}> no era un rango de staff.`));
          return;
        }
        await setValue(guild.id, CONFIG_KEY, { ranks: others } satisfies StaffConfig);
        await interaction.reply(ephemeral(`✅ <@&${role.id}> ya no es un rango de staff.`));
        return;
      }

      // sub === "agregar"
      if (role.id === guild.id) {
        await interaction.reply(ephemeral("⚠️ @everyone no puede ser un rango de staff."));
        return;
      }
      const tag = interaction.options.getString("tag", true).trim().replace(/[[\]]/g, "");
      const short = interaction.options.getString("abreviatura")?.trim().replace(/[[\]]/g, "") || undefined;
      const tier = interaction.options.getString("grupo")?.trim() || undefined;
      if (!tag) {
        await interaction.reply(ephemeral("⚠️ El tag no puede quedar vacío."));
        return;
      }
      const existed = others.length !== ranks.length;
      await setValue(guild.id, CONFIG_KEY, { ranks: [...others, { roleId: role.id, tag, short, tier }] } satisfies StaffConfig);
      await interaction.reply(
        ephemeral(
          `✅ ${existed ? "Actualicé" : "Agregué"} el rango <@&${role.id}> → \`[${tag}]\`${short ? ` (corto: \`[${short}]\`)` : ""}` +
            `${tier ? `, grupo **${tier}**` : ""}.\n` +
            "El orden lo da la posición del rol en Ajustes → Roles. Para aplicar los tags al staff que ya tenía el rol: `/tags sincronizar`.",
        ),
      );
      return;
    }

    // sub === "rangos"
    const ranks = await getRanks(guild);
    const template = await usesTemplate(guild.id);
    if (ranks.length === 0) {
      await interaction.reply(
        ephemeral(
          "No hay rangos de staff en este servidor." +
            (template ? " (La plantilla busca roles llamados Owner, Head Staff, Admin Sr… y no encontré ninguno.)" : "") +
            "\nSumá uno con `/staff rango agregar`.",
        ),
      );
      return;
    }
    const tiers = staffTiers(ranks);
    const byRole = new Map(ranks.map((r) => [r.role, r]));
    const lines = tiers.map((tier, i) => {
      const items = tier.map((id) => {
        const r = byRole.get(id);
        return `<@&${id}> \`[${r?.tag ?? "?"}]\`${r?.short ? ` / \`[${r.short}]\`` : ""}`;
      });
      return `**${i + 1}.** ${items.join(" · ")}`;
    });
    const embed = (await brandEmbed(guild))
      .setTitle("🛡️ Rangos de staff")
      .setDescription(
        `De mayor a menor. Cada línea es un nivel: al **derivar** un ticket se llama al nivel de arriba.\n\n${lines.join("\n")}` +
          (template ? "\n\n*Usando la plantilla por nombre. Si agregás o quitás un rango, se pasa a tu propia lista.*" : ""),
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

async function checkHealth(guild: Guild): Promise<HealthCheck> {
  const ranks = await getRanks(guild);
  if (ranks.length === 0) {
    return { label: "Rangos de staff", ok: false, detail: "no hay ninguno (falta `/staff rango agregar`); solo los admins atienden tickets" };
  }
  const template = await usesTemplate(guild.id);
  return { label: "Rangos de staff", ok: true, detail: `${ranks.length} rango(s)${template ? " (plantilla por nombre)" : ""}` };
}

export const staff: Feature = {
  name: "staff",
  commands: [staffCommand],
  checkHealth,
  register(): void {
    /* solo comandos: los demás sistemas leen los rangos con getRanks */
  },
};
