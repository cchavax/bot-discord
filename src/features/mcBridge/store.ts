/**
 * Persistencia y estado del puente con el servidor de Minecraft.
 *
 * - Canales configurados (reportes, sanciones, staff chat) y los vínculos Discord↔Minecraft
 *   se guardan por servidor en el store de siempre (data/config.json).
 * - Los códigos de vinculación y la cola del staff chat (Discord → Minecraft) son efímeros:
 *   viven solo en memoria porque no importa perderlos si el bot se reinicia.
 */
import { randomInt } from "node:crypto";
import { getValue, setValue } from "../../store.js";

const CONFIG_KEY = "mcBridge";
const LINKS_KEY = "mcLinks";

export interface McBridgeConfig {
  reportChannelId?: string;
  sanctionChannelId?: string;
  staffChatChannelId?: string;
  /** Rol de Discord que, si lo tenés y vinculaste tu cuenta, te deja entrar a un server con whitelist. */
  whitelistRoleId?: string;
}

export type ChannelKind = "reportChannelId" | "sanctionChannelId" | "staffChatChannelId";

export const getConfig = (guildId: string): Promise<McBridgeConfig> => getValue<McBridgeConfig>(guildId, CONFIG_KEY, {});

export async function setChannel(guildId: string, kind: ChannelKind, channelId: string | null): Promise<void> {
  const cfg = await getConfig(guildId);
  const next: McBridgeConfig = { ...cfg };
  if (channelId) next[kind] = channelId;
  else delete next[kind];
  await setValue(guildId, CONFIG_KEY, next);
}

export async function setWhitelistRole(guildId: string, roleId: string | null): Promise<void> {
  const cfg = await getConfig(guildId);
  const next: McBridgeConfig = { ...cfg };
  if (roleId) next.whitelistRoleId = roleId;
  else delete next.whitelistRoleId;
  await setValue(guildId, CONFIG_KEY, next);
}

/**
 * Un vínculo es por CUENTA DE MINECRAFT (el mapa va por uuid), no por cuenta de Discord: así
 * una misma persona puede vincular varios personajes (su cuenta principal, una de testing, etc)
 * con el mismo Discord — solo corre /vincular de nuevo por cada uno. Lo único que no puede pasar
 * es que el MISMO personaje quede linkeado a dos Discords distintos a la vez (una vinculación
 * nueva simplemente pisa la vieja, porque hace falta controlar ese personaje en el juego para
 * redimir el código).
 */
export interface McLink {
  uuid: string;
  username: string;
  discordId: string;
  linkedAt: number;
}

export const getLinks = (guildId: string): Promise<Record<string, McLink>> =>
  getValue<Record<string, McLink>>(guildId, LINKS_KEY, {});

export async function setLink(guildId: string, link: McLink): Promise<void> {
  const links = await getLinks(guildId);
  await setValue(guildId, LINKS_KEY, { ...links, [link.uuid.toLowerCase()]: link });
}

/** Vincula reemplazando cualquier OTRA cuenta que ese Discord tuviera antes (el caso normal:
 * 1 Discord = 1 personaje a la vez). Para sumar varias sin reemplazar, ver /vincular-dev. */
export async function setLinkReplacingPrevious(guildId: string, link: McLink): Promise<void> {
  const links = await getLinks(guildId);
  const next: Record<string, McLink> = {};
  for (const [uuid, existing] of Object.entries(links)) {
    if (existing.discordId === link.discordId && uuid !== link.uuid.toLowerCase()) continue; // se reemplaza
    next[uuid] = existing;
  }
  next[link.uuid.toLowerCase()] = link;
  await setValue(guildId, LINKS_KEY, next);
}

export async function findLinkByUuid(guildId: string, uuid: string): Promise<McLink | null> {
  const links = await getLinks(guildId);
  return links[uuid.toLowerCase()] ?? null;
}

/** Todas las cuentas de Minecraft que tiene vinculadas un mismo Discord (puede ser más de una). */
export async function getLinksForDiscordId(guildId: string, discordId: string): Promise<McLink[]> {
  const links = await getLinks(guildId);
  return Object.values(links).filter((l) => l.discordId === discordId);
}

// ---------- códigos de vinculación (efímeros, en memoria) ----------

interface LinkCode {
  guildId: string;
  discordId: string;
  createdAt: number;
  /** true si viene de /vincular-dev: puede sumar otra cuenta sin reemplazar la que ya tenía. */
  allowMultiple: boolean;
}

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LINK_CODE_LENGTH = 6;
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin O/0 ni I/1, que se confunden al tipear
const linkCodes = new Map<string, LinkCode>();

function pruneLinkCodes(): void {
  const now = Date.now();
  for (const [code, entry] of linkCodes) {
    if (now - entry.createdAt > LINK_CODE_TTL_MS) linkCodes.delete(code);
  }
}

/** Genera un código de 6 caracteres válido por 10 minutos para vincular una cuenta. */
export function createLinkCode(guildId: string, discordId: string, allowMultiple = false): string {
  pruneLinkCodes();
  let code: string;
  do {
    code = Array.from({ length: LINK_CODE_LENGTH }, () => LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]).join("");
  } while (linkCodes.has(code));
  linkCodes.set(code, { guildId, discordId, createdAt: Date.now(), allowMultiple });
  return code;
}

/** Consume un código (una sola vez) y devuelve a quién pertenecía, o null si no es válido/venció. */
export function redeemLinkCode(code: string): LinkCode | null {
  pruneLinkCodes();
  const key = code.trim().toUpperCase();
  const entry = linkCodes.get(key);
  if (!entry) return null;
  linkCodes.delete(key);
  return entry;
}

// ---------- cola del staff chat (Discord -> Minecraft), efímera en memoria ----------

export interface OutboundStaffChatMessage {
  id: number;
  at: number;
  author: string;
  text: string;
}

const OUTBOX_MAX_AGE_MS = 5 * 60 * 1000;
const outbox = new Map<string, OutboundStaffChatMessage[]>();
// Arranca del reloj y no de 1: el plugin recuerda el último id, y si el bot se reinicia con ids
// más bajos, ese cursor descartaría todos los mensajes nuevos sin avisar.
let nextOutboundId = Date.now();

export function pushStaffChatToMinecraft(guildId: string, author: string, text: string): void {
  const list = outbox.get(guildId) ?? [];
  list.push({ id: nextOutboundId++, at: Date.now(), author, text });
  outbox.set(guildId, list);
}

/** Mensajes nuevos desde `afterId` (y de paso limpia los viejos para no crecer sin límite). */
export function pollStaffChat(guildId: string, afterId: number): OutboundStaffChatMessage[] {
  const now = Date.now();
  const list = (outbox.get(guildId) ?? []).filter((m) => now - m.at < OUTBOX_MAX_AGE_MS);
  outbox.set(guildId, list);
  return list.filter((m) => m.id > afterId);
}
