/** Punto de entrada del bot. Ejecutar con:  npm start  (o npm run dev para recarga automática) */
import { Client, Events, GatewayIntentBits, type Guild, MessageFlags, Partials } from "discord.js";
import { config } from "./config.js";
import { announcements } from "./features/announcements/index.js";
import { automod } from "./features/automod/index.js";
import { boosts } from "./features/boosts.js";
import { giveaways } from "./features/giveaways/index.js";
import { invites } from "./features/invites/index.js";
import { mcBridge } from "./features/mcBridge/index.js";
import { memberCount } from "./features/memberCount.js";
import { moderation } from "./features/moderation/index.js";
import { nicknames } from "./features/nicknames.js";
import { polls } from "./features/polls.js";
import { getServerLogChannelId, serverLogs } from "./features/serverLogs.js";
import { createSettings, healthEmbed, runHealthChecks } from "./features/settings.js";
import { suggestions } from "./features/suggestions.js";
import { getLogChannelId, tickets } from "./features/tickets/index.js";
import { verification } from "./features/verification.js";
import { staff } from "./features/staff.js";
import { welcome } from "./features/welcome.js";
import { acquireLock, releaseLock } from "./instanceLock.js";
import { log } from "./log.js";
import { flush } from "./store.js";
import type { Command, Feature } from "./types.js";

// Cada sistema es una "feature". Para sumar uno nuevo, agregalo a esta lista.
const features: Feature[] = [
  createSettings(() => features),
  serverLogs,
  staff,
  moderation,
  automod,
  nicknames,
  tickets,
  welcome,
  verification,
  memberCount,
  invites,
  boosts,
  suggestions,
  polls,
  giveaways,
  announcements,
  mcBridge,
];

const commands = new Map<string, Command>();
for (const feature of features) {
  for (const command of feature.commands) {
    if (commands.has(command.data.name)) throw new Error(`Hay dos comandos con el mismo nombre: /${command.data.name}`);
    commands.set(command.data.name, command);
  }
}
const commandData = [...commands.values()].map((cmd) => cmd.data);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // PRIVILEGIADO: activarlo en el Developer Portal
    GatewayIntentBits.MessageContent, // PRIVILEGIADO: para leer el texto de los mensajes (transcripciones y logs)
    GatewayIntentBits.GuildMessages, // mensajes editados/borrados (registro del servidor)
    GatewayIntentBits.GuildModeration, // baneos (registro del servidor)
    GatewayIntentBits.GuildVoiceStates, // entradas/salidas de voz (registro del servidor)
    GatewayIntentBits.GuildInvites, // invitaciones creadas (sistema de invitaciones)
  ],
  // Para enterarse de mensajes borrados/editados aunque sean de antes de prender el bot.
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

/**
 * Los comandos se registran en cada servidor (no globales): así aparecen al instante, también
 * en un servidor nuevo apenas agregan el bot.
 */
async function registerCommands(guild: Guild): Promise<boolean> {
  try {
    await guild.commands.set(commandData);
    return true;
  } catch (err) {
    log.error("comandos", `No pude registrar los comandos en ${guild.name} (¿invitaron al bot sin el permiso "applications.commands"?)`, err);
    return false;
  }
}

/** Revisa la configuración de un servidor, la muestra en consola y la avisa en su canal de registros. */
async function reportHealth(guild: Guild): Promise<void> {
  const results = await runHealthChecks(guild, features);
  const okCount = results.filter((r) => r.ok).length;
  log.plain(`  ${guild.name} — ${okCount}/${results.length} sistemas listos`);
  for (const r of results) {
    // En consola, las menciones <#id> no se leen: las dejamos como #id.
    const detail = r.detail.replace(/<[#@]&?(\d+)>/g, "#$1").replace(/`/g, "");
    log.plain(`    ${r.ok ? "✓" : "⚠"} ${r.label}: ${detail}`);
  }

  const logChannelId = (await getServerLogChannelId(guild.id)) ?? (await getLogChannelId(guild.id));
  if (!logChannelId) return;
  const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel?.isTextBased()) return;
  await logChannel.send({ embeds: [await healthEmbed(guild, results, "🟢 Bot iniciado")] }).catch(() => {});
}

client.once(Events.ClientReady, async (c) => {
  const guilds = [...c.guilds.cache.values()];
  log.section(`✨ ${c.user.tag} conectado — ${guilds.length} servidor(es), ${commands.size} comandos`);

  let registered = 0;
  for (const guild of guilds) if (await registerCommands(guild)) registered++;
  log.ok("comandos", `Registrados en ${registered}/${guilds.length} servidor(es): /${[...commands.keys()].join(", /")}`);

  if (guilds.length === 0) {
    log.warn("servidores", "No estoy en ningún servidor todavía. Invitame con el link de OAuth2 (scopes: bot + applications.commands).");
    return;
  }

  log.section("Estado de la configuración");
  for (const guild of guilds) await reportHealth(guild).catch((err) => log.error("estado", `No pude revisar ${guild.name}`, err));
  log.plain("");
  log.ok("bot", "Listo. Usá /ajustes estado en Discord para revisar un servidor en cualquier momento.");
});

client.on(Events.GuildCreate, (guild) => {
  registerCommands(guild).catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    await commands
      .get(interaction.commandName)
      ?.autocomplete?.(interaction)
      .catch((err) => log.error("interacción", `Error en el autocompletado de /${interaction.commandName}`, err));
    return;
  }
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) {
        await interaction.reply({ content: "⚠️ Ese comando ya no existe. Esperá un momento a que se actualice la lista.", flags: MessageFlags.Ephemeral });
        return;
      }
      await command.execute(interaction);
      return;
    }
    for (const feature of features) {
      if (feature.handleInteraction && (await feature.handleInteraction(interaction))) return;
    }
  } catch (err) {
    const where = interaction.isChatInputCommand()
      ? `/${interaction.commandName}`
      : "customId" in interaction
        ? `botón/formulario "${interaction.customId}"`
        : "una interacción";
    log.error("interacción", `Error en ${where} (${interaction.user.tag}${interaction.guild ? `, ${interaction.guild.name}` : ""})`, err);
    if (interaction.isRepliable()) {
      const reply = { content: "⚠️ Hubo un error. Probá de nuevo.", flags: MessageFlags.Ephemeral } as const;
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  }
});

for (const feature of features) feature.register(client);

// ---------- errores generales y apagado ----------
client.on(Events.Error, (err) => log.error("discord", "Error del cliente", err));
client.on(Events.Warn, (message) => log.warn("discord", message));
client.on(Events.ShardDisconnect, () => log.warn("discord", "Se cortó la conexión con Discord, reintentando…"));
client.on(Events.ShardResume, () => log.ok("discord", "Conexión recuperada."));
process.on("unhandledRejection", (err) => log.error("proceso", "Promesa sin manejar", err));
process.on("uncaughtException", (err) => log.error("proceso", "Error sin manejar", err));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("bot", `Apagando (${signal})… guardando datos pendientes.`);
  await flush();
  await client.destroy();
  releaseLock();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("Ctrl+C"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("exit", () => releaseLock());

const otherPid = acquireLock();
if (otherPid !== null) {
  log.error(
    "bot",
    `Ya hay otra copia del bot corriendo (proceso ${otherPid}). Cerrala antes de abrir esta: si corren dos a la vez se pisan los datos y las respuestas.`,
  );
  process.exit(1);
}

log.info("bot", "Conectando con Discord…");
try {
  await client.login(config.token);
} catch (err) {
  const message = (err as Error).message ?? "";
  if (/disallowed intents/i.test(message)) {
    log.error("bot", "Discord rechazó los intents. Activá SERVER MEMBERS INTENT y MESSAGE CONTENT INTENT en el Developer Portal → Bot → Privileged Gateway Intents");
  } else if (/token/i.test(message)) {
    log.error("bot", "El token no es válido. Generá uno nuevo en el Developer Portal → Bot → Reset Token y ponelo en DISCORD_TOKEN del .env");
  } else {
    log.error("bot", "No pude conectarme a Discord", err);
  }
  process.exit(1);
}
