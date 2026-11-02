/**
 * Rangos de staff, de mayor a menor.
 *
 * role  = identificador del rol. En la PLANTILLA de abajo es el nombre del rol en Discord (no
 *         distingue mayúsculas ni adornos); en los rangos configurados con `/staff` es el ID del rol.
 * tag   = texto que va entre corchetes en el apodo.
 * short = abreviatura que se usa si el apodo completo supera los 32 caracteres.
 * tier  = grupo para derivar tickets: Sr/base/Jr del mismo grupo cuentan como el mismo nivel.
 *         Si no tiene, el rango es su propio grupo.
 *
 * Toda la lógica de acá es pura (sin discord.js) para poder testearla.
 */
export interface Rank {
  role: string;
  tag: string;
  short?: string;
  tier?: string;
}

/**
 * Normaliza el nombre de un rol para compararlo: quita todo lo que no sea letra o número
 * al principio y al final (puntos, emojis, guiones, espacios) y pasa a minúsculas.
 * Así "・ Admin Sr", "🛡️ Admin Sr" y "Admin Sr" cuentan como el mismo rol.
 */
export function normalizeRoleName(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim().toLowerCase();
}

/**
 * Plantilla por defecto (la de Aura Craft): se usa en los servidores que no configuraron sus
 * rangos con `/staff`, buscando cada rol por nombre.
 * Orden: el primero que coincida con los roles del miembro es su rango principal.
 */
export const RANKS: readonly Rank[] = [
  { role: "Owner", tag: "Owner", tier: "Owner" },
  { role: "Head Staff", tag: "Head Staff", short: "HS", tier: "Head Staff" },
  { role: "Admin Sr", tag: "Admin Sr", tier: "Admin" },
  { role: "Admin", tag: "Admin", tier: "Admin" },
  { role: "Admin Jr", tag: "Admin Jr", tier: "Admin" },
  { role: "Moderador Sr", tag: "Moderador Sr", short: "Mod Sr", tier: "Moderador" },
  { role: "Moderador", tag: "Moderador", short: "Mod", tier: "Moderador" },
  { role: "Moderador Jr", tag: "Moderador Jr", short: "Mod Jr", tier: "Moderador" },
  { role: "Helper Sr", tag: "Helper Sr", tier: "Helper" },
  { role: "Helper", tag: "Helper", tier: "Helper" },
  { role: "Helper Jr", tag: "Helper Jr", tier: "Helper" },
  { role: "Trial Sr", tag: "Trial Sr", tier: "Trial" },
  { role: "Trial", tag: "Trial", tier: "Trial" },
];

const sameRole = (a: string, b: string): boolean => normalizeRoleName(a) === normalizeRoleName(b);
const tierOf = (r: Rank): string => normalizeRoleName(r.tier ?? r.role);

/**
 * Roles desde el más alto hasta `minRole` inclusive.
 * Sirve para "este rango o superior", ej. roleNamesFrom("Helper Jr").
 */
export function roleNamesFrom(minRole: string, ranks: readonly Rank[] = RANKS): string[] {
  const i = ranks.findIndex((r) => sameRole(r.role, minRole));
  if (i === -1) throw new Error(`Rango desconocido: ${minRole}`);
  return ranks.slice(0, i + 1).map((r) => r.role);
}

/**
 * Grupos de rangos (tiers) de mayor a menor, armados con los rangos consecutivos que comparten
 * `tier`. Ej. de la plantilla: [Owner], [Head Staff], [Admin Sr, Admin, Admin Jr], ...
 */
export function staffTiers(ranks: readonly Rank[] = RANKS): string[][] {
  const tiers: string[][] = [];
  let current: string | null = null;
  for (const r of ranks) {
    if (tierOf(r) !== current) {
      tiers.push([]);
      current = tierOf(r);
    }
    tiers.at(-1)?.push(r.role);
  }
  return tiers;
}

/** El tier inmediatamente superior al de `role`, o null si ya es el más alto o no es un rango conocido. */
export function nextTierUp(role: string, ranks: readonly Rank[] = RANKS): readonly string[] | null {
  const tiers = staffTiers(ranks);
  const index = tiers.findIndex((tier) => tier.some((r) => sameRole(r, role)));
  if (index <= 0) return null;
  return tiers[index - 1] ?? null;
}
