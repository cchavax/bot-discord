/**
 * Categorías de ticket. Cada servidor puede armar las suyas con `/ticket categoria agregar`;
 * mientras no lo haga, se usan estas por defecto (las de Aura Craft).
 *
 * key       = identificador corto (sin espacios), va en el nombre del canal.
 * staffFrom = (solo en las de por defecto) nombre del rango MÍNIMO que atiende esta categoría,
 *             ese rango y todos los superiores. Se busca por nombre entre los roles del servidor.
 *
 * Todo lo de este archivo es puro (sin discord.js) para poder testearlo.
 */
import { type Rank, roleNamesFrom } from "../../ranks.js";

export interface TicketCategory {
  key: string;
  label: string;
  emoji: string;
  description: string;
  staffFrom: string;
}

/** Categoría lista para usar en un servidor. */
export interface ResolvedCategory {
  key: string;
  label: string;
  emoji: string;
  description: string;
  /** Postulación: se puede abrir/cerrar y va en su propio panel. */
  application: boolean;
  /** Rol del rango mínimo que atiende. null = todo el staff. */
  minRoleId: string | null;
  /** Preguntas del formulario que se completa antes de abrir el ticket (vacío = sin formulario). */
  questions?: string[];
}

/** Máximo de categorías por panel (una fila de botones). */
export const MAX_CATEGORIES = 5;
/** Máximo de preguntas por formulario (lo que entra en una ventana de Discord). */
export const MAX_QUESTIONS = 5;
/** Largo máximo de cada pregunta (el título de un campo de Discord). */
export const MAX_QUESTION_LENGTH = 45;

export const TICKET_CATEGORIES: readonly TicketCategory[] = [
  {
    key: "soporte",
    label: "Soporte",
    emoji: "<:64005web:1565185117029138462>",
    description: "Dudas o ayuda general.",
    staffFrom: "Helper Jr",
  },
  {
    key: "reporte",
    label: "Reportar jugador",
    emoji: "<:report_message:1565181456924282891>",
    description: "Reportar a un jugador.",
    staffFrom: "Moderador Jr",
  },
  {
    key: "apelacion",
    label: "Apelar sanción",
    emoji: "<:13206moderateur:1565184381956522084>",
    description: "Apelar una sanción.",
    staffFrom: "Moderador Sr",
  },
  {
    key: "otro",
    label: "Otro",
    emoji: "<:forum_badge:1565181030732795945>",
    description: "Otra consulta.",
    staffFrom: "Helper Jr",
  },
];

/** "Reportar jugador" → "reportar-jugador". Las de postulación llevan el prefijo "postulacion-". */
export function categoryKey(label: string, application: boolean): string {
  const base =
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20) || "categoria";
  return application ? `postulacion-${base}` : base;
}

/** Un emoji que Discord acepta en un botón: uno personalizado (<:nombre:id>) o uno común (🎫). */
export function isValidEmoji(text: string): boolean {
  const t = text.trim();
  if (/^<a?:\w{2,32}:\d{17,20}>$/.test(t)) return true;
  return t.length <= 16 && /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u.test(t) && !/\s/.test(t);
}

/**
 * IDs (o nombres, en la plantilla) de los rangos que atienden una categoría: desde su rango
 * mínimo para arriba. Si no tiene mínimo, o ese rol ya no es un rango, la atiende todo el staff.
 */
export function staffRolesFor(cat: Pick<ResolvedCategory, "minRoleId">, ranks: readonly Rank[]): string[] {
  if (cat.minRoleId && ranks.some((r) => r.role === cat.minRoleId)) return roleNamesFrom(cat.minRoleId, ranks);
  return ranks.map((r) => r.role);
}
