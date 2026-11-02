/** Lógica pura del sistema de invitaciones: qué invite se usó al entrar alguien, y qué hitos se cruzan. */

export interface InviteSnapshot {
  code: string;
  uses: number;
  inviterId?: string;
  /** Usos máximos (0 = ilimitada). Sirve para detectar invitaciones que Discord borra al agotarse. */
  maxUses?: number;
}

export interface InviteMilestone {
  count: number;
  reward: string;
}

/**
 * Compara el estado de las invitaciones justo antes y justo después de que alguien entró,
 * y devuelve la que se usó para entrar:
 *  1. la que subió sus usos, o
 *  2. si ninguna subió, una que desapareció justo cuando le quedaba un solo uso (Discord borra
 *     las invitaciones de "1 uso" o con límite apenas se agotan, así que no aparece en `after`).
 */
export function detectUsedInvite(before: InviteSnapshot[], after: InviteSnapshot[]): InviteSnapshot | undefined {
  for (const inv of after) {
    const prevUses = before.find((b) => b.code === inv.code)?.uses ?? 0;
    if (inv.uses > prevUses) return inv;
  }
  const afterCodes = new Set(after.map((a) => a.code));
  const exhausted = before.filter((b) => !afterCodes.has(b.code) && b.maxUses && b.uses + 1 >= b.maxUses);
  // Si se borraron varias a la vez no hay forma de saber cuál fue: mejor no adivinar.
  return exhausted.length === 1 ? exhausted[0] : undefined;
}

/** Hitos que se cruzan al pasar de `previousCount` a `newCount` invitados verificados. */
export function milestonesReached(
  milestones: readonly InviteMilestone[],
  previousCount: number,
  newCount: number,
): InviteMilestone[] {
  return milestones.filter((m) => m.count > previousCount && m.count <= newCount);
}
