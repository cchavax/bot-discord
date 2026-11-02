/**
 * Piezas visuales compartidas por todos los sistemas: el embed con la "marca" del servidor
 * (nombre en el footer, foto del bot, color) y las respuestas efímeras.
 *
 * La marca se configura por servidor con `/ajustes marca`. Si no se configuró nada, el footer
 * usa el nombre del bot y el nombre del servidor es el de Discord: así el bot queda prolijo
 * en cualquier servidor nuevo sin tocar nada.
 */
import { EmbedBuilder, type Guild, MessageFlags } from "discord.js";
import { getValue } from "./store.js";

export const BRANDING_KEY = "branding";
export const DEFAULT_COLOR = 0x000000;

export interface Branding {
  /** Texto del footer de los embeds (ej. "Aura System"). */
  systemName?: string;
  /** Cómo se nombra al servidor en los mensajes (ej. "Aura Craft"), por si el nombre de Discord tiene adornos. */
  serverName?: string;
  /** Color del costado de los embeds. Si no se define, cada sistema usa el suyo. */
  color?: number;
}

export const getBranding = (guildId: string): Promise<Branding> => getValue<Branding>(guildId, BRANDING_KEY, {});

export const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral }) as const;

/** Nombre del servidor para usar en textos ("Bienvenido a X"). */
export async function serverName(guild: Guild): Promise<string> {
  return (await getBranding(guild.id)).serverName ?? guild.name;
}

/** Embed base con footer, foto del bot y hora. `color` es el color propio del sistema que lo usa. */
export async function brandEmbed(guild: Guild, color: number = DEFAULT_COLOR): Promise<EmbedBuilder> {
  const branding = await getBranding(guild.id);
  const bot = guild.client.user;
  return new EmbedBuilder()
    .setColor(branding.color ?? color)
    .setFooter({ text: branding.systemName ?? bot.username, iconURL: bot.displayAvatarURL() })
    .setTimestamp();
}

/** "#6c3ce9" o "6c3ce9" → número. Devuelve null si no es un color hexadecimal válido. */
export function parseHexColor(input: string): number | null {
  const match = input.trim().match(/^#?([0-9a-f]{6})$/i);
  return match?.[1] ? Number.parseInt(match[1], 16) : null;
}

export const formatHexColor = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;
