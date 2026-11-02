/**
 * Anuncios: `/anuncio crear` abre un formulario (título, texto, imagen, color) y publica un
 * embed con la marca del servidor, al toque o programado ("18:30", "en 2h", "30/10 20:00"),
 * y opcionalmente repetido cada día o cada semana. Los programados se guardan en el store y
 * sobreviven reinicios: un reloj revisa cada 30 segundos si hay alguno para mandar.
 */
import {
  ActionRowBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
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
import { brandEmbed, ephemeral, parseHexColor } from "../../ui.js";
import { DEFAULT_TIMEZONE, type Repeat, TIMEZONES, nextOccurrence, parseWhen } from "./logic.js";

const DATA_KEY = "announcements";
const MODAL_PREFIX = "announce:create:";
const TICK_MS = 30_000;

interface Announcement {
  id: number;
  channelId: string;
  roleId?: string;
  title: string;
  text: string;
  image?: string;
  color?: number;
  sendAt: number;
  repeat: Repeat;
  createdBy: string;
}

interface AnnouncementsStore {
  nextId: number;
  scheduled: Announcement[];
  timezone?: string;
}

const getData = (guildId: string): Promise<AnnouncementsStore> =>
  getValue<AnnouncementsStore>(guildId, DATA_KEY, { nextId: 1, scheduled: [] });
const setData = (guildId: string, data: AnnouncementsStore): Promise<void> => setValue(guildId, DATA_KEY, data);

const REPEAT_LABEL: Record<Repeat, string> = { no: "una vez", diario: "todos los días", semanal: "todas las semanas" };

/** Publica un anuncio. Devuelve null si salió bien, o el problema. */
async function publish(guild: Guild, a: Omit<Announcement, "id" | "sendAt" | "repeat" | "createdBy">): Promise<string | null> {
  const channel = await guild.channels.fetch(a.channelId).catch(() => null);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    return "el canal ya no existe";
  }
  const embed = (await brandEmbed(guild)).setTitle(a.title).setDescription(a.text);
  if (a.color !== undefined) embed.setColor(a.color);
  if (a.image) embed.setImage(a.image);
  const everyone = a.roleId === guild.id;
  const content = a.roleId ? (everyone ? "@everyone" : `<@&${a.roleId}>`) : undefined;
  const sent = await channel
    .send({
      content,
      embeds: [embed],
      allowedMentions: everyone ? { parse: ["everyone"] } : { roles: a.roleId ? [a.roleId] : [] },
    })
    .catch(() => null);
  if (!sent) return (await channelProblem(guild, channel.id)) ?? "Discord no me dejó publicarlo";
  return null;
}

async function tick(client: Client): Promise<void> {
  const now = Date.now();
  for (const guildId of await guildIds()) {
    const data = await getData(guildId);
    const due = data.scheduled.filter((a) => a.sendAt <= now);
    if (due.length === 0) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    for (const a of due) {
      const problem = await publish(guild, a);
      if (problem) log.warn("anuncios", `No pude mandar el anuncio #${a.id} en ${guild.name}: ${problem}.`);
      else log.ok("anuncios", `Anuncio #${a.id} publicado en ${guild.name}.`);
      const next = nextOccurrence(a.sendAt, a.repeat, now);
      if (next) a.sendAt = next;
      else data.scheduled = data.scheduled.filter((x) => x.id !== a.id);
    }
    await setData(guildId, data);
  }
}

function buildModal(customId: string): ModalBuilder {
  const input = (id: string, label: string, style: TextInputStyle, required: boolean, max: number, placeholder?: string) => {
    const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (placeholder) field.setPlaceholder(placeholder);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
  };
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle("Nuevo anuncio")
    .addComponents(
      input("title", "Título", TextInputStyle.Short, true, 256, "📢 ¡Novedades!"),
      input("text", "Texto (acepta **negrita**, listas…)", TextInputStyle.Paragraph, true, 4000),
      input("image", "Imagen (link, opcional)", TextInputStyle.Short, false, 500, "https://…/banner.png"),
      input("color", "Color del costado (opcional)", TextInputStyle.Short, false, 7, "#6c3ce9"),
    );
}

const announceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("anuncio")
    .setDescription("Anuncios con estilo, al toque o programados")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("crear")
        .setDescription("Abre el formulario para armar un anuncio")
        .addChannelOption((o) =>
          o
            .setName("canal")
            .setDescription("Dónde publicarlo")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addRoleOption((o) => o.setName("mencionar").setDescription("Rol a mencionar (podés elegir @everyone)"))
        .addStringOption((o) =>
          o.setName("cuando").setDescription("Vacío = ahora. Ej: 18:30, en 2h, 30/10 20:00 (hora del servidor)").setMaxLength(30),
        )
        .addStringOption((o) =>
          o
            .setName("repetir")
            .setDescription("Para anuncios programados")
            .addChoices({ name: "No", value: "no" }, { name: "Todos los días", value: "diario" }, { name: "Todas las semanas", value: "semanal" }),
        ),
    )
    .addSubcommand((s) => s.setName("lista").setDescription("Anuncios programados"))
    .addSubcommand((s) =>
      s
        .setName("cancelar")
        .setDescription("Cancela un anuncio programado")
        .addIntegerOption((o) => o.setName("id").setDescription("Número (lo da /anuncio lista)").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName("zona")
        .setDescription("Zona horaria para programar anuncios")
        .addStringOption((o) =>
          o
            .setName("zona")
            .setDescription("Cuál")
            .setRequired(true)
            .addChoices(...TIMEZONES.map((z) => ({ name: z.name, value: z.value }))),
        ),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();
    const data = await getData(guild.id);
    const timezone = data.timezone ?? DEFAULT_TIMEZONE;

    if (sub === "zona") {
      const zona = interaction.options.getString("zona", true);
      await setData(guild.id, { ...data, timezone: zona });
      const now = new Date().toLocaleTimeString("es-AR", { timeZone: zona, hour: "2-digit", minute: "2-digit" });
      await interaction.reply(ephemeral(`✅ Zona horaria guardada. Ahí ahora son las **${now}**.`));
      return;
    }

    if (sub === "lista") {
      if (data.scheduled.length === 0) {
        await interaction.reply(ephemeral("No hay anuncios programados."));
        return;
      }
      const lines = [...data.scheduled]
        .sort((a, b) => a.sendAt - b.sendAt)
        .map(
          (a) =>
            `\`#${a.id}\` **${a.title}** → <#${a.channelId}> — <t:${Math.floor(a.sendAt / 1000)}:f> (<t:${Math.floor(a.sendAt / 1000)}:R>)` +
            `${a.repeat !== "no" ? ` 🔁 ${REPEAT_LABEL[a.repeat]}` : ""}`,
        );
      await interaction.reply(ephemeral(`🗓️ **Anuncios programados**\n${lines.join("\n")}\n\nCancelá uno con \`/anuncio cancelar id:<número>\`.`));
      return;
    }

    if (sub === "cancelar") {
      const id = interaction.options.getInteger("id", true);
      const found = data.scheduled.find((a) => a.id === id);
      if (!found) {
        await interaction.reply(ephemeral(`⚠️ No hay ningún anuncio programado #${id}.`));
        return;
      }
      await setData(guild.id, { ...data, scheduled: data.scheduled.filter((a) => a.id !== id) });
      await interaction.reply(ephemeral(`✅ Cancelé el anuncio #${id} (**${found.title}**).`));
      return;
    }

    // sub === "crear": sin llamadas a la API antes del modal (hay 3 segundos para mostrarlo).
    const channel = interaction.options.getChannel("canal", true);
    const role = interaction.options.getRole("mencionar");
    const when = interaction.options.getString("cuando") ?? "";
    const repeat = (interaction.options.getString("repetir") ?? "no") as Repeat;
    const sendAt = parseWhen(when, Date.now(), timezone);
    if (sendAt === null) {
      await interaction.reply(
        ephemeral("⚠️ No entendí el `cuando`. Ejemplos: `18:30`, `en 2h`, `en 1d`, `30/10 20:00` o `30/10/2026 20:00`. Vacío = ahora."),
      );
      return;
    }
    const immediate = sendAt <= Date.now() + 5000;
    if (immediate && repeat !== "no") {
      await interaction.reply(ephemeral("⚠️ Para que se repita, decime también desde cuándo (ej. `cuando: 18:00`)."));
      return;
    }
    await interaction.showModal(
      buildModal(`${MODAL_PREFIX}${channel.id}:${role?.id ?? "-"}:${immediate ? 0 : sendAt}:${repeat}`),
    );
  },
};

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [channelId = "", roleRaw, sendAtRaw, repeatRaw] = interaction.customId.slice(MODAL_PREFIX.length).split(":");
  const roleId = roleRaw && roleRaw !== "-" ? roleRaw : undefined;
  const sendAt = Number(sendAtRaw);
  const repeat = (repeatRaw ?? "no") as Repeat;

  const title = interaction.fields.getTextInputValue("title").trim();
  const text = interaction.fields.getTextInputValue("text").trim();
  const image = interaction.fields.getTextInputValue("image").trim() || undefined;
  const colorText = interaction.fields.getTextInputValue("color").trim();
  const color = colorText ? parseHexColor(colorText) : undefined;
  if (color === null) {
    await interaction.editReply("⚠️ El color no es válido (usá algo como `#6c3ce9`). No publiqué nada.");
    return;
  }
  if (image && !/^https?:\/\/\S+$/i.test(image)) {
    await interaction.editReply("⚠️ La imagen tiene que ser un link que empiece con https://. No publiqué nada.");
    return;
  }

  const content = { channelId, roleId, title, text, image, color };
  if (!sendAt) {
    const problem = await publish(guild, content);
    await interaction.editReply(problem ? `⚠️ No pude publicarlo: ${problem}.` : `✅ Anuncio publicado en <#${channelId}>.`);
    return;
  }

  const data = await getData(guild.id);
  const announcement: Announcement = { ...content, id: data.nextId, sendAt, repeat, createdBy: interaction.user.id };
  await setData(guild.id, { ...data, nextId: data.nextId + 1, scheduled: [...data.scheduled, announcement] });
  await interaction.editReply(
    `✅ Anuncio #${announcement.id} programado para <t:${Math.floor(sendAt / 1000)}:f> (<t:${Math.floor(sendAt / 1000)}:R>) en <#${channelId}>` +
      `${repeat !== "no" ? `, y después ${REPEAT_LABEL[repeat]}` : ""}.\nLo ves con \`/anuncio lista\`.`,
  );
}

export const announcements: Feature = {
  name: "announcements",
  commands: [announceCommand],
  register(client: Client): void {
    client.once(Events.ClientReady, () => {
      // Si una vuelta tarda más de 30 s (muchos anuncios), la siguiente no arranca encima: evita dobles envíos.
      let running = false;
      const run = () => {
        if (running) return;
        running = true;
        tick(client)
          .catch((err) => log.error("anuncios", "Error mandando anuncios programados", err))
          .finally(() => {
            running = false;
          });
      };
      run();
      setInterval(run, TICK_MS).unref();
    });
  },
  async handleInteraction(interaction: Interaction): Promise<boolean> {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith(MODAL_PREFIX)) return false;
    await handleModal(interaction);
    return true;
  },
};
