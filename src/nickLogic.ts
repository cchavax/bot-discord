/** Lógica pura de apodos (sin depender de discord.js, así se puede testear). */
import { RANKS, normalizeRoleName, type Rank } from "./ranks.js";

export const MAX_NICK = 32;
export const SEP = " ";

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function knownTags(ranks: readonly Rank[]): string[] {
  const tags = new Set<string>();
  for (const r of ranks) {
    tags.add(r.tag);
    if (r.short) tags.add(r.short);
  }
  // Los más largos primero, para que "Moderador Sr" no coincida como "Moderador".
  return [...tags].sort((a, b) => b.length - a.length);
}

// Patrón por lista de rangos, cacheado mientras la lista sea la misma (ej. la plantilla RANKS).
const patterns = new WeakMap<readonly Rank[], RegExp>();

function tagPattern(ranks: readonly Rank[]): RegExp {
  let pattern = patterns.get(ranks);
  if (!pattern) {
    const tags = knownTags(ranks).map(escapeRegex);
    // Sin rangos no hay ningún tag nuestro que quitar: un patrón que nunca coincide.
    pattern = tags.length > 0 ? new RegExp(`^\\[(?:${tags.join("|")})\\]\\s*`, "i") : /(?!)/;
    patterns.set(ranks, pattern);
  }
  return pattern;
}

/** Quita nuestro prefijo de staff si está. No toca otros corchetes (ej. "[ES] Juan"). */
export function stripTag(name: string, ranks: readonly Rank[] = RANKS): string {
  return name.replace(tagPattern(ranks), "");
}

/** Devuelve el rango más alto que tenga el miembro, según el orden de `ranks`. */
export function findRank(roles: Iterable<string>, ranks: readonly Rank[] = RANKS): Rank | null {
  const owned = new Set([...roles].map(normalizeRoleName));
  return ranks.find((r) => owned.has(normalizeRoleName(r.role))) ?? null;
}

/** True si el rango principal cambió entre dos listas de roles (ascenso, baja, alta, cambio). */
export function rankChanged(oldRoles: Iterable<string>, newRoles: Iterable<string>, ranks: readonly Rank[] = RANKS): boolean {
  return findRank(oldRoles, ranks)?.role !== findRank(newRoles, ranks)?.role;
}

/** Arma "[Tag] nombre" respetando el límite de 32 caracteres. */
export function compose(rank: Rank, base: string): string {
  const name = base.trim();
  const full = `[${rank.tag}]${SEP}${name}`;
  if (full.length <= MAX_NICK) return full;

  const label = rank.short ?? rank.tag;
  const prefix = `[${label}]${SEP}`;
  if (rank.short && (prefix + name).length <= MAX_NICK) return prefix + name;
  return prefix + name.slice(0, MAX_NICK - prefix.length);
}

/**
 * Apodo que debería tener el miembro.
 * currentNick: apodo actual en el servidor (null si no tiene).
 * fallbackName: nombre a usar si no tiene apodo (nombre visible global).
 * rank: rango principal, o null si no es staff.
 * Devuelve null cuando el miembro debería quedar sin apodo.
 */
export function desiredNick(
  currentNick: string | null,
  fallbackName: string,
  rank: Rank | null,
  ranks: readonly Rank[] = RANKS,
): string | null {
  if (rank === null) {
    // Ya no es staff: solo quitamos nuestro tag, si lo tenía.
    if (currentNick === null) return null;
    const cleaned = stripTag(currentNick, ranks).trim();
    return cleaned || null;
  }
  const base = (currentNick ? stripTag(currentNick, ranks) : fallbackName).trim() || fallbackName;
  return compose(rank, base);
}
