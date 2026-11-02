/**
 * Servidor HTTP que habla con el plugin de Minecraft (proyecto aparte: ../minecraft-plugin).
 *
 * El plugin es siempre el que llama (polling), nunca al revés: así no hace falta abrir ningún
 * puerto en el hosting de Minecraft (Pterodactyl/Minehost), que ya corre afuera de esta
 * máquina. Este bot sí necesita quedar accesible por HTTP desde ese hosting (un puerto
 * reenviado, un túnel o un dominio apuntando a MC_BRIDGE_PORT) para que el plugin lo alcance.
 *
 * Autenticación: header "Authorization: Bearer <MC_BRIDGE_SECRET>" en cada pedido (salvo
 * /health). Sin ese secreto el bridge no arranca: así no queda un endpoint abierto por error.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ChannelType, type Client, RESTJSONErrorCodes } from "discord.js";
import { log } from "../../log.js";
import { brandEmbed } from "../../ui.js";
import {
  findLinkByUuid,
  getConfig,
  getLinksForDiscordId,
  pollStaffChat,
  pushStaffChatToMinecraft,
  redeemLinkCode,
  setLink,
  setLinkReplacingPrevious,
} from "./store.js";

const MAX_BODY_BYTES = 64 * 1024;

let client: Client | null = null;
export function attachClient(c: Client): void {
  client = c;
}

interface PlayerRef {
  uuid: string;
  username: string;
}

function isPlayerRef(v: unknown): v is PlayerRef {
  return Boolean(v) && typeof (v as PlayerRef).uuid === "string" && typeof (v as PlayerRef).username === "string";
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

async function sendToChannel(guildId: string, channelId: string | undefined, build: (embed: Awaited<ReturnType<typeof brandEmbed>>) => Awaited<ReturnType<typeof brandEmbed>>, color: number): Promise<void> {
  if (!client || !channelId) return;
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const embed = build((await brandEmbed(guild)).setColor(color));
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

const COLOR = { sanction: 0x992d22, staffmode: 0x3498db } as const;
const TICKET_STATUS_COLOR: Record<string, number> = { pending: 0xe67e22, attending: 0x3498db, resolved: 0x2ecc71, denied: 0x992d22 };
const TICKET_STATUS_LABEL: Record<string, string> = { pending: "🟠 Pendiente", attending: "🔵 Atendiendo", resolved: "✅ Resuelto", denied: "⛔ Denegado" };
const TICKET_TYPE_LABEL: Record<string, string> = { report: "🚩 Reporte de jugador", help: "🆘 Pedido de ayuda" };

async function handleSanction(guildId: string, body: unknown): Promise<[number, unknown]> {
  const b = body as { type?: string; target?: PlayerRef; author?: string; reason?: string; durationMinutes?: number };
  if (!b.type || !isPlayerRef(b.target) || !b.author) return [400, { error: "faltan campos (type, target, author)" }];
  const cfg = await getConfig(guildId);
  const kindLabel: Record<string, string> = { ban: "🔨 Ban", mute: "🔇 Mute", kick: "👟 Kick", warn: "⚠️ Advertencia", unban: "✅ Unban", unmute: "✅ Unmute" };
  const title = kindLabel[b.type] ?? `Sanción (${b.type})`;
  await sendToChannel(
    guildId,
    cfg.sanctionChannelId,
    (e) =>
      e
        .setTitle(`${title} en Minecraft`)
        .addFields(
          { name: "Jugador", value: `${b.target!.username} (\`${b.target!.uuid}\`)`, inline: true },
          { name: "Autor", value: b.author!, inline: true },
          ...(b.durationMinutes ? [{ name: "Duración", value: `${b.durationMinutes} min`, inline: true }] : []),
          { name: "Motivo", value: b.reason?.trim() || "*(sin motivo)*" },
        ),
    COLOR.sanction,
  );
  return [200, { ok: true }];
}

/** Reportes y pedidos de ayuda ("tickets"): a diferencia del resto, estos quedan con estado
 * (pendiente → atendiendo → resuelto/denegado) y el embed en Discord se EDITA a medida que
 * cambia, en vez de mandar un mensaje nuevo cada vez. El plugin es quien guarda el estado real
 * (SQLite); acá solo mantenemos el embed al día, usando el id del mensaje que devolvimos al crearlo. */
function ticketEmbedFields(b: { type?: string; reporter?: PlayerRef; target?: PlayerRef; reason?: string; status?: string; attendedBy?: string }) {
  const fields: { name: string; value: string; inline: boolean }[] = [{ name: "Jugador", value: b.reporter!.username, inline: true }];
  if (b.target) fields.push({ name: b.type === "report" ? "Reportado" : "Objetivo", value: b.target.username, inline: true });
  fields.push({ name: "Estado", value: TICKET_STATUS_LABEL[b.status ?? "pending"] ?? b.status ?? "?", inline: true });
  if (b.attendedBy) fields.push({ name: "Atendido por", value: b.attendedBy, inline: true });
  fields.push({ name: "Motivo", value: b.reason?.trim() || "*(sin motivo)*", inline: false });
  return fields;
}

async function handleTicketCreate(guildId: string, body: unknown): Promise<[number, unknown]> {
  const b = body as { type?: string; reporter?: PlayerRef; target?: PlayerRef; reason?: string };
  if (!b.type || !isPlayerRef(b.reporter) || (b.target !== undefined && !isPlayerRef(b.target))) {
    return [400, { error: "faltan campos (type, reporter)" }];
  }
  const cfg = await getConfig(guildId);
  if (!client || !cfg.reportChannelId) return [200, { ok: true, messageId: null }];
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  const channel = guild ? await guild.channels.fetch(cfg.reportChannelId).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText) return [200, { ok: true, messageId: null }];

  const embed = (await brandEmbed(guild!))
    .setColor(TICKET_STATUS_COLOR.pending!)
    .setTitle(TICKET_TYPE_LABEL[b.type] ?? b.type)
    .addFields(ticketEmbedFields({ ...b, status: "pending" }));
  const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  return [200, { ok: true, messageId: message?.id ?? null }];
}

async function handleTicketUpdate(guildId: string, body: unknown): Promise<[number, unknown]> {
  const b = body as { messageId?: string; type?: string; reporter?: PlayerRef; target?: PlayerRef; reason?: string; status?: string; attendedBy?: string };
  if (!b.messageId || !b.status || !isPlayerRef(b.reporter)) return [400, { error: "faltan campos (messageId, status, reporter)" }];
  const cfg = await getConfig(guildId);
  if (!client || !cfg.reportChannelId) return [200, { ok: true }];
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  const channel = guild ? await guild.channels.fetch(cfg.reportChannelId).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText) return [200, { ok: true }];
  const message = await channel.messages.fetch(b.messageId).catch(() => null);
  if (!message) return [200, { ok: true }];

  const existing = message.embeds[0];
  const embed = (await brandEmbed(guild!))
    .setColor(TICKET_STATUS_COLOR[b.status] ?? TICKET_STATUS_COLOR.pending!)
    .setTitle(existing?.title ?? (b.type ? (TICKET_TYPE_LABEL[b.type] ?? b.type) : "Ticket"))
    .addFields(ticketEmbedFields(b));
  await message.edit({ embeds: [embed] }).catch(() => {});
  return [200, { ok: true }];
}

async function handleStaffMode(guildId: string, body: unknown): Promise<[number, unknown]> {
  const b = body as { player?: PlayerRef; enabled?: boolean };
  if (!isPlayerRef(b.player) || typeof b.enabled !== "boolean") return [400, { error: "faltan campos (player, enabled)" }];
  const cfg = await getConfig(guildId);
  await sendToChannel(
    guildId,
    cfg.sanctionChannelId,
    (e) => e.setTitle(b.enabled ? "🟢 Modo staff activado" : "⚪ Modo staff desactivado").setDescription(b.player!.username),
    COLOR.staffmode,
  );
  return [200, { ok: true }];
}

async function handleStaffChatIn(guildId: string, body: unknown): Promise<[number, unknown]> {
  const b = body as { player?: PlayerRef; text?: string };
  if (!isPlayerRef(b.player) || typeof b.text !== "string" || !b.text.trim()) return [400, { error: "faltan campos (player, text)" }];
  const cfg = await getConfig(guildId);
  if (client && cfg.staffChatChannelId) {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    const channel = guild ? await guild.channels.fetch(cfg.staffChatChannelId).catch(() => null) : null;
    if (channel?.type === ChannelType.GuildText) {
      await channel.send({ content: `🎮 **${b.player.username}:** ${b.text.trim()}`, allowedMentions: { parse: [] } }).catch(() => {});
    }
  }
  return [200, { ok: true }];
}

function handleStaffChatPoll(guildId: string, url: URL): [number, unknown] {
  const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
  const messages = pollStaffChat(guildId, after);
  return [200, { messages }];
}

async function handleLinkRedeem(guildId: string, body: unknown): Promise<[number, unknown]> {
  const b = body as { code?: string; uuid?: string; username?: string };
  if (!b.code || !b.uuid || !b.username) return [400, { error: "faltan campos (code, uuid, username)" }];
  const entry = redeemLinkCode(b.code);
  if (!entry || entry.guildId !== guildId) return [404, { error: "código inválido o vencido" }];
  const link = { uuid: b.uuid, username: b.username, discordId: entry.discordId, linkedAt: Date.now() };
  if (entry.allowMultiple) await setLink(guildId, link);
  else await setLinkReplacingPrevious(guildId, link);
  if (client) {
    const user = await client.users.fetch(entry.discordId).catch(() => null);
    await user?.send(`✅ Vinculaste tu cuenta de Discord con **${b.username}** en Minecraft.`).catch(() => {});
  }
  return [200, { ok: true, discordId: entry.discordId }];
}

async function handleWhitelistCheck(guildId: string, url: URL): Promise<[number, unknown]> {
  const uuid = url.searchParams.get("uuid");
  if (!uuid) return [400, { error: "pasá ?uuid=" }];
  const cfg = await getConfig(guildId);
  if (!cfg.whitelistRoleId) return [200, { roleConfigured: false, linked: false, hasRole: false }];
  const found = await findLinkByUuid(guildId, uuid);
  if (!found) return [200, { roleConfigured: true, linked: false, hasRole: false }];
  if (!client) throw new Error("el bot todavía no está conectado a Discord");
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
  // Solo "no es miembro" significa que no tiene el rol. Un corte de Discord tiene que terminar en
  // error: el plugin saca de la whitelist a quien responda hasRole=false.
  const member = await guild.members.fetch(found.discordId).catch((err: { code?: number }) => {
    if (err.code === RESTJSONErrorCodes.UnknownMember) return null;
    throw err;
  });
  const hasRole = member?.roles.cache.has(cfg.whitelistRoleId) ?? false;
  return [200, { roleConfigured: true, linked: true, hasRole }];
}

async function handleLinkStatus(guildId: string, url: URL): Promise<[number, unknown]> {
  const uuid = url.searchParams.get("uuid");
  const discordId = url.searchParams.get("discordId");
  if (uuid) {
    const found = await findLinkByUuid(guildId, uuid);
    return [200, found ? { linked: true, discordId: found.discordId } : { linked: false }];
  }
  if (discordId) {
    const links = await getLinksForDiscordId(guildId, discordId);
    return [200, links.length ? { linked: true, accounts: links.map((l) => ({ uuid: l.uuid, username: l.username })) } : { linked: false }];
  }
  return [400, { error: "pasá ?uuid= o ?discordId=" }];
}

const GUILD_ROUTE = /^\/api\/guilds\/([^/]+)\/([a-z/]+)$/;

/** Compara en tiempo constante: un !== común filtra cuántos caracteres del secreto coinciden. */
export function isAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const received = createHash("sha256").update(header).digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(received, expected);
}

async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req.headers.authorization, process.env.MC_BRIDGE_SECRET)) {
    send(res, 401, { error: "no autorizado" });
    return;
  }

  const match = GUILD_ROUTE.exec(url.pathname);
  if (!match) {
    send(res, 404, { error: "ruta desconocida" });
    return;
  }
  const guildId = match[1]!;
  const route = match[2]!;

  try {
    if (req.method === "POST" && route === "sanctions") return void send(res, ...(await handleSanction(guildId, await readBody(req))));
    if (req.method === "POST" && route === "tickets") return void send(res, ...(await handleTicketCreate(guildId, await readBody(req))));
    if (req.method === "POST" && route === "tickets/update") return void send(res, ...(await handleTicketUpdate(guildId, await readBody(req))));
    if (req.method === "POST" && route === "staffmode") return void send(res, ...(await handleStaffMode(guildId, await readBody(req))));
    if (req.method === "POST" && route === "staffchat") return void send(res, ...(await handleStaffChatIn(guildId, await readBody(req))));
    if (req.method === "GET" && route === "staffchat/poll") return void send(res, ...handleStaffChatPoll(guildId, url));
    if (req.method === "POST" && route === "link/redeem") return void send(res, ...(await handleLinkRedeem(guildId, await readBody(req))));
    if (req.method === "GET" && route === "link/status") return void send(res, ...(await handleLinkStatus(guildId, url)));
    if (req.method === "GET" && route === "whitelist/check") return void send(res, ...(await handleWhitelistCheck(guildId, url)));
    send(res, 404, { error: "ruta desconocida" });
  } catch (err) {
    log.error("mcBridge", "Error atendiendo un pedido del plugin", err);
    if (!res.headersSent) send(res, 500, { error: "error interno" });
  }
}

/** Reexportado para que el comando /staffchat del bot pueda encolar un mensaje hacia Minecraft. */
export { pushStaffChatToMinecraft };

let started = false;
export function startMcBridgeServer(): void {
  if (started) return;
  const secret = process.env.MC_BRIDGE_SECRET;
  if (!secret) {
    log.info("mcBridge", "MC_BRIDGE_SECRET no está en el .env: el puente con Minecraft queda apagado.");
    return;
  }
  const port = Number.parseInt(process.env.MC_BRIDGE_PORT ?? "", 10) || 8787;
  const server = createServer((req, res) => {
    void router(req, res);
  });
  server.on("error", (err) => log.error("mcBridge", "No pude levantar el servidor del puente con Minecraft", err));
  server.listen(port, () => {
    started = true;
    log.ok("mcBridge", `Puente con Minecraft escuchando en el puerto ${port}.`);
  });
}
