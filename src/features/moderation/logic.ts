/** Lógica pura de moderación: duraciones, escala de sanciones automáticas y conteo de warns. */

export type CaseType = "warn" | "mute" | "unmute" | "kick" | "ban" | "unban";

export interface ModCase {
  id: number;
  type: CaseType;
  userId: string;
  moderatorId: string;
  reason: string;
  at: number;
  durationMs?: number;
  /** Sanción anulada con `/sancion quitar` (queda en el historial, pero no cuenta). */
  removed?: boolean;
  /** La puso el bot solo (escala automática o automod). */
  auto?: boolean;
}

export type EscalationAction = "mute" | "kick" | "ban";

export interface EscalationStep {
  warns: number;
  action: EscalationAction;
  durationMs?: number;
}

/** Escala por defecto: 3 warns → 1 hora de mute, 5 warns → 1 día de mute. */
export const DEFAULT_ESCALATION: readonly EscalationStep[] = [
  { warns: 3, action: "mute", durationMs: 60 * 60 * 1000 },
  { warns: 5, action: "mute", durationMs: 24 * 60 * 60 * 1000 },
];

/** El máximo de timeout que permite Discord: 28 días. */
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  sem: 7 * 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * "10m", "1h30m", "2d", "1 sem" → milisegundos. Un número solo cuenta como minutos.
 * Devuelve null si no se entiende.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t) * UNITS.m!;
  const parts = [...t.matchAll(/(\d+)(sem|s|m|h|d|w)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== t) return null;
  const total = parts.reduce((sum, p) => sum + Number(p[1]) * (UNITS[p[2] ?? ""] ?? 0), 0);
  return total > 0 ? total : null;
}

/** 5400000 → "1 h 30 min". */
export function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [UNITS.d!, "d"],
    [UNITS.h!, "h"],
    [UNITS.m!, "min"],
    [UNITS.s!, "s"],
  ];
  const out: string[] = [];
  let rest = ms;
  for (const [size, label] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      out.push(`${n} ${label}`);
      rest -= n * size;
    }
  }
  return out.slice(0, 2).join(" ") || "0 s";
}

/** Warns vigentes de una persona (sin contar los anulados). */
export function activeWarns(cases: readonly ModCase[], userId: string): number {
  return cases.filter((c) => c.userId === userId && c.type === "warn" && !c.removed).length;
}

/** El paso de la escala que se dispara JUSTO al llegar a `warnCount` warns (o null). */
export function escalationFor(steps: readonly EscalationStep[], warnCount: number): EscalationStep | null {
  return steps.find((s) => s.warns === warnCount) ?? null;
}
