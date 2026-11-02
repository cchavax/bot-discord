/** Lógica pura de anuncios programados: entender "cuándo" y calcular la próxima repetición. */

export type Repeat = "no" | "diario" | "semanal";

const DAY = 24 * 60 * 60 * 1000;

export const TIMEZONES = [
  { name: "Argentina / Uruguay (UTC-3)", value: "America/Argentina/Buenos_Aires" },
  { name: "Chile", value: "America/Santiago" },
  { name: "Colombia / Perú / Ecuador (UTC-5)", value: "America/Bogota" },
  { name: "México (centro)", value: "America/Mexico_City" },
  { name: "España", value: "Europe/Madrid" },
  { name: "UTC", value: "UTC" },
] as const;

export const DEFAULT_TIMEZONE = "America/Argentina/Buenos_Aires";

/** Cuántos ms está adelantada la zona respecto de UTC en ese instante (ej. Argentina: -3 h). */
function tzOffset(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Fecha y hora "de reloj" en una zona → instante UTC (ms). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - tzOffset(guess, timeZone);
  // Segunda pasada por si justo hay cambio de horario entre la estimación y el resultado.
  return guess - tzOffset(first, timeZone);
}

/** Fecha de hoy (año, mes, día) en una zona. */
function todayIn(now: number, timeZone: string): { year: number; month: number; day: number } {
  const local = new Date(now + tzOffset(now, timeZone));
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

/**
 * Entiende cuándo mandar un anuncio. Devuelve el instante en ms, o null si no se entiende o ya pasó.
 *  - "ahora" o vacío → now
 *  - "en 2h", "30m", "1h30m", "2d" → dentro de ese tiempo
 *  - "18:30" → hoy a esa hora (o mañana si ya pasó)
 *  - "30/10 18:30" o "30/10/2026 18:30" → ese día a esa hora
 */
export function parseWhen(input: string, now: number, timeZone: string = DEFAULT_TIMEZONE): number | null {
  const t = input.trim().toLowerCase();
  if (t === "" || t === "ahora" || t === "ya") return now;

  const relative = t.replace(/^en\s+/, "").replace(/\s+/g, "");
  const parts = [...relative.matchAll(/(\d+)(d|h|m)/g)];
  if (parts.length > 0 && parts.map((p) => p[0]).join("") === relative) {
    const sizes: Record<string, number> = { d: DAY, h: 60 * 60 * 1000, m: 60 * 1000 };
    return now + parts.reduce((sum, p) => sum + Number(p[1]) * (sizes[p[2] ?? ""] ?? 0), 0);
  }

  const time = t.match(/^(\d{1,2}):(\d{2})$/);
  if (time) {
    const [hour, minute] = [Number(time[1]), Number(time[2])];
    if (hour > 23 || minute > 59) return null;
    const { year, month, day } = todayIn(now, timeZone);
    const at = zonedToUtc(year, month, day, hour, minute, timeZone);
    return at > now ? at : at + DAY;
  }

  const date = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})$/);
  if (date) {
    const [day, month, hour, minute] = [Number(date[1]), Number(date[2]), Number(date[4]), Number(date[5])];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const year = date[3] ? Number(date[3]) : todayIn(now, timeZone).year;
    let at = zonedToUtc(year, month, day, hour, minute, timeZone);
    // Sin año y ya pasó → el año que viene.
    if (!date[3] && at <= now) at = zonedToUtc(year + 1, month, day, hour, minute, timeZone);
    return at > now - 60_000 ? at : null;
  }
  return null;
}

/** Próxima vez que toca mandar un anuncio que se repite (siempre en el futuro), o null si no se repite. */
export function nextOccurrence(sendAt: number, repeat: Repeat, now: number): number | null {
  if (repeat === "no") return null;
  const step = repeat === "diario" ? DAY : 7 * DAY;
  let next = sendAt + step;
  // Si el bot estuvo apagado varios días, no mandamos todos los atrasados: saltamos al próximo.
  while (next <= now) next += step;
  return next;
}
