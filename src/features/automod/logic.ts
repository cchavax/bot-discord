/** Lógica pura del automod: ventanas de tiempo (spam, raid), links, invitaciones y menciones. */

/**
 * Cuenta eventos por clave en una ventana de tiempo deslizante. Ej. mensajes por usuario en
 * los últimos 5 segundos, o entradas al servidor en los últimos 30.
 */
export class SlidingWindow {
  private readonly events = new Map<string, number[]>();

  /** Registra un evento y devuelve cuántos hubo en la ventana (incluido este). */
  hit(key: string, windowMs: number, now = Date.now()): number {
    const recent = (this.events.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.events.set(key, recent);
    return recent.length;
  }

  reset(key: string): void {
    this.events.delete(key);
  }

  /** Borra claves viejas para que no crezca para siempre. */
  prune(maxAgeMs: number, now = Date.now()): void {
    for (const [key, times] of this.events) {
      if (times.every((t) => now - t >= maxAgeMs)) this.events.delete(key);
    }
  }
}

const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/[\w-]+/i;
const URL_RE = /\bhttps?:\/\/[^\s<>]+|\bwww\.[^\s<>]+/gi;

/** Si el texto tiene una invitación a otro servidor de Discord. */
export const hasInvite = (text: string): boolean => INVITE_RE.test(text);

/** Dominios de los links del texto ("https://www.youtube.com/x" → "youtube.com"). */
export function linkDomains(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0].startsWith("www.") ? `http://${match[0]}` : match[0];
    try {
      out.push(new URL(raw).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      /* link mal formado: lo ignoramos */
    }
  }
  return out;
}

/** Si el dominio está permitido (también cuentan los subdominios: "m.youtube.com" vale por "youtube.com"). */
export function isAllowedDomain(domain: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => {
    const base = a.toLowerCase().replace(/^www\./, "").trim();
    return base.length > 0 && (domain === base || domain.endsWith(`.${base}`));
  });
}

/** Links no permitidos del texto. Las invitaciones de Discord las maneja su propio filtro. */
export function blockedLinks(text: string, allowed: readonly string[]): string[] {
  const ownDiscord = ["discord.com", "discord.gg", "discordapp.com", "dsc.gg", "discord.media", "discordapp.net", "tenor.com"];
  return linkDomains(text).filter((d) => !isAllowedDomain(d, [...allowed, ...ownDiscord]));
}

/** "youtube.com, twitch.tv  x.com" → ["youtube.com", "twitch.tv", "x.com"]. */
export function parseDomainList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
        .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)),
    ),
  ];
}
