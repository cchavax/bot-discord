/**
 * Evita que corran dos copias del bot a la vez. Con el mismo token, las dos reciben los mismos
 * eventos, se pelean las respuestas ("Unknown interaction") y cada una guarda su propia versión
 * de data/config.json pisando lo que guardó la otra.
 *
 * Al arrancar se escribe data/bot.lock con el PID. Si ya existe y ese proceso sigue vivo, no se
 * arranca. Si el proceso ya no existe (se cerró de golpe), el archivo viejo se ignora.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

const LOCK_FILE = path.join(DATA_DIR, "bot.lock");

/** true si hay un proceso vivo con ese PID. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // señal 0: no hace nada, solo verifica que el proceso exista
    return true;
  } catch (err) {
    // EPERM = existe pero es de otro usuario: igual cuenta como vivo.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Toma el bloqueo. Devuelve el PID de la otra copia si ya hay una corriendo, o null si quedó tomado. */
export function acquireLock(file = LOCK_FILE): number | null {
  if (existsSync(file)) {
    const other = Number(readFileSync(file, "utf8").trim());
    if (other !== process.pid && isAlive(other)) return other;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, String(process.pid), "utf8");
  return null;
}

/** Suelta el bloqueo (solo si es nuestro). */
export function releaseLock(file = LOCK_FILE): void {
  try {
    if (Number(readFileSync(file, "utf8").trim()) === process.pid) rmSync(file);
  } catch {
    /* ya no estaba */
  }
}
