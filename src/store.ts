/**
 * Almacenamiento simple en un archivo JSON local (data/config.json), separado POR SERVIDOR:
 *
 *   { "version": 2, "guilds": { "<guildId>": { "tickets": {...}, "welcome": {...} } } }
 *
 * Es temporal a propósito: todos los sistemas pasan por estas funciones, así que cuando
 * llegue la base de datos (PostgreSQL) solo se reemplaza este archivo.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./log.js";
import { DATA_DIR } from "./paths.js";

const FILE = path.join(DATA_DIR, "config.json");

type GuildData = Record<string, unknown>;

export interface StoreData {
  version: 2;
  guilds: Record<string, GuildData>;
  /** Datos del formato viejo (un solo servidor) que no se pudieron asignar a ninguno. */
  legacy?: Record<string, unknown>;
}

/**
 * Pasa el formato viejo (todas las claves sueltas, un solo servidor) al nuevo por servidor.
 * Si no se sabe a qué servidor pertenecían (falta GUILD_ID), quedan guardadas en `legacy`
 * para no perderlas. Devuelve también si hubo que migrar algo.
 */
export function migrateLegacy(raw: Record<string, unknown>, legacyGuildId: string | undefined): { data: StoreData; migrated: boolean } {
  if (raw.version === 2 && typeof raw.guilds === "object" && raw.guilds !== null) {
    return { data: raw as unknown as StoreData, migrated: false };
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) return { data: { version: 2, guilds: {} }, migrated: false };
  if (!legacyGuildId) return { data: { version: 2, guilds: {}, legacy: raw }, migrated: true };

  // El servidor original ya usaba "Aura System" y "Aura Craft": se conservan tal cual.
  const branding = { systemName: "Aura System", serverName: "Aura Craft" };
  return { data: { version: 2, guilds: { [legacyGuildId]: { branding, ...raw } } }, migrated: true };
}

let cache: StoreData | null = null;
let loading: Promise<StoreData> | null = null;

// Si dos sistemas leen a la vez al arrancar, que el archivo se lea (y migre) una sola vez.
function load(): Promise<StoreData> {
  if (cache) return Promise.resolve(cache);
  loading ??= readAndMigrate();
  return loading;
}

async function readAndMigrate(): Promise<StoreData> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(FILE, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const { data, migrated } = migrateLegacy(raw, process.env.GUILD_ID);
  cache = data;
  if (migrated) {
    if (data.legacy) {
      log.warn("store", "Encontré configuración del formato viejo pero no hay GUILD_ID en el .env para saber de qué servidor es. La guardé aparte (\"legacy\") sin usarla.");
    } else {
      log.info("store", `Migré la configuración vieja al formato por servidor (servidor ${process.env.GUILD_ID}).`);
    }
    await persist();
  }
  return cache;
}

// Todas las escrituras pasan por acá, una a la vez: si dos sistemas guardan casi al mismo
// tiempo, la segunda espera a que termine la primera. Si no, se pisan el mismo archivo
// temporal y una de las dos termina en ENOENT al renombrarlo.
let writeQueue: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  writeQueue = writeQueue
    .catch(() => {
      /* un error en la escritura anterior no debe trabar las siguientes */
    })
    .then(async () => {
      const data = await load();
      await mkdir(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await rename(tmp, FILE); // escritura atómica: no queda un archivo a medias
    });
  return writeQueue;
}

export async function getValue<T>(guildId: string, key: string, fallback: T): Promise<T> {
  const data = await load();
  const guild = data.guilds[guildId];
  return guild && key in guild ? (guild[key] as T) : fallback;
}

export async function setValue(guildId: string, key: string, value: unknown): Promise<void> {
  const data = await load();
  const guild = (data.guilds[guildId] ??= {});
  guild[key] = value;
  await persist();
}

/** IDs de todos los servidores que tienen algo guardado (para retomar sorteos al prender, etc.). */
export async function guildIds(): Promise<string[]> {
  return Object.keys((await load()).guilds);
}

/** Espera a que terminen las escrituras pendientes (para apagar el bot sin perder nada). */
export function flush(): Promise<void> {
  return writeQueue.catch(() => {});
}
