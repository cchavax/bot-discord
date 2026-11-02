/** Lógica pura de sorteos: parsear los premios del modal, armar los cupos y elegir ganadores al azar. */

export interface PrizeEntry {
  name: string;
  quantity: number;
}

/**
 * Parsea el texto del modal (un premio por línea, formato "Premio" o "Premio x3") en una
 * lista de premios con su cantidad. Líneas vacías se ignoran.
 */
export function parsePrizes(text: string): PrizeEntry[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(.*?)\s+x\s*(\d+)$/i);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        return { name: match[1].trim(), quantity: Math.max(1, Number(match[2])) };
      }
      return { name: line, quantity: 1 };
    })
    .filter((prize) => prize.name.length > 0);
}

/** Convierte la lista de premios en una lista plana de cupos (un casillero por cada unidad a sortear). */
export function expandPrizeSlots(prizes: readonly PrizeEntry[]): string[] {
  return prizes.flatMap((prize) => Array(Math.max(prize.quantity, 0)).fill(prize.name) as string[]);
}

/**
 * Elige hasta `count` ganadores entre `participants`, sin repetir a nadie.
 * `random` es inyectable para poder testear de forma determinística (por defecto, Math.random).
 */
export function pickWinners(participants: readonly string[], count: number, random: () => number = Math.random): string[] {
  const pool = [...participants];
  const winners: string[] = [];
  const total = Math.min(Math.max(count, 0), pool.length);

  for (let i = 0; i < total; i++) {
    const index = Math.floor(random() * pool.length);
    winners.push(...pool.splice(index, 1));
  }

  return winners;
}
