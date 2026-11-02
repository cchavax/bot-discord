/**
 * Logs de consola con hora y sistema, para que se entienda de un vistazo qué pasó y dónde:
 *
 *   [14:32:05] ✓ tickets     Ticket creado: soporte-luli (Aura Craft)
 *   [14:32:09] ⚠ invites     No pude detectar con qué invitación entró pepe (Aura Craft)
 *
 * Nunca loguees el token ni el contenido del .env.
 */
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
} as const;

// Sin colores si la salida no es una terminal (ej. se guarda en un archivo) o si se pide NO_COLOR.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (color: keyof typeof COLORS, text: string): string => (useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text);

const time = (): string => new Date().toTimeString().slice(0, 8);

function line(icon: string, color: keyof typeof COLORS, scope: string, message: string): string {
  return `${paint("dim", `[${time()}]`)} ${paint(color, icon)} ${paint("cyan", scope.padEnd(13))}${message}`;
}

/** Saca el mensaje legible de un error de Discord/Node, sin el stack completo (salvo en modo debug). */
function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const base = code !== undefined ? `${err.message} (código ${String(code)})` : err.message;
    return process.env.DEBUG ? `${base}\n${err.stack ?? ""}` : base;
  }
  return String(err);
}

export const log = {
  info: (scope: string, message: string): void => console.log(line("•", "reset", scope, message)),
  ok: (scope: string, message: string): void => console.log(line("✓", "green", scope, message)),
  warn: (scope: string, message: string): void => console.warn(line("⚠", "yellow", scope, message)),
  error: (scope: string, message: string, err?: unknown): void =>
    console.error(line("✗", "red", scope, err === undefined ? message : `${message}: ${describe(err)}`)),
  /** Título de sección (ej. al arrancar). */
  section: (title: string): void => console.log(`\n${paint("bold", title)}`),
  plain: (text: string): void => console.log(text),
};
