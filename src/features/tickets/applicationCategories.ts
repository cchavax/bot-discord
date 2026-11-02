/**
 * Categorías del panel de postulaciones por defecto (staff, builder, social/streamer/colabos).
 * A diferencia de las de soporte (categories.ts), estas se pueden abrir o cerrar con
 * `/ticket postulaciones abrir|cerrar` porque no siempre se están buscando.
 * Cada servidor puede reemplazarlas con `/ticket categoria agregar tipo:Postulación`.
 */
import type { TicketCategory } from "./categories.js";

export const APPLICATION_CATEGORIES: readonly TicketCategory[] = [
  {
    key: "postulacion-staff",
    label: "Staff",
    emoji: "<:40528administrateur:1565184663176351924>",
    description: "Postularte para sumarte al staff.",
    staffFrom: "Moderador Jr",
  },
  {
    key: "postulacion-builder",
    label: "Builder",
    emoji: "<:67811jeu:1565185206120489132>",
    description: "Postularte como builder.",
    staffFrom: "Helper Jr",
  },
  {
    key: "postulacion-social",
    label: "Social",
    emoji: "<:clip_blurple:1565189063705895042>",
    description: "Streamer, colabos y contenido del servidor.",
    staffFrom: "Helper Jr",
  },
];
