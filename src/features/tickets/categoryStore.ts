/**
 * Categorías de ticket de cada servidor (soporte y postulaciones), guardadas en el store.
 * Si el servidor no armó las suyas, se usan las de por defecto, con el rango mínimo buscado por
 * nombre entre sus roles.
 */
import type { Guild } from "discord.js";
import { normalizeRoleName } from "../../ranks.js";
import { getValue, setValue } from "../../store.js";
import { APPLICATION_CATEGORIES } from "./applicationCategories.js";
import { type ResolvedCategory, TICKET_CATEGORIES, type TicketCategory } from "./categories.js";

const CONFIG_KEY = "ticketCategories";

export type CategoryConfig = Omit<ResolvedCategory, "application">;

interface CategoriesStore {
  /** Si no está, se usan las de por defecto. */
  support?: CategoryConfig[];
  applications?: CategoryConfig[];
}

export type CategoryType = "support" | "applications";

const getStore = (guildId: string): Promise<CategoriesStore> => getValue<CategoriesStore>(guildId, CONFIG_KEY, {});

function resolveDefault(guild: Guild, c: TicketCategory, application: boolean): ResolvedCategory {
  const role = guild.roles.cache.find((r) => normalizeRoleName(r.name) === normalizeRoleName(c.staffFrom));
  return { key: c.key, label: c.label, emoji: c.emoji, description: c.description, application, minRoleId: role?.id ?? null };
}

/** Categorías de un tipo, ya resueltas para este servidor. */
export async function getCategories(guild: Guild, type: CategoryType): Promise<ResolvedCategory[]> {
  const store = await getStore(guild.id);
  const application = type === "applications";
  const custom = store[type];
  if (custom) return custom.map((c) => ({ ...c, application }));
  return (application ? APPLICATION_CATEGORIES : TICKET_CATEGORIES).map((c) => resolveDefault(guild, c, application));
}

export async function getAllCategories(guild: Guild): Promise<ResolvedCategory[]> {
  return [...(await getCategories(guild, "support")), ...(await getCategories(guild, "applications"))];
}

export async function findCategory(guild: Guild, key: string): Promise<ResolvedCategory | undefined> {
  return (await getAllCategories(guild)).find((c) => c.key === key);
}

/** Guarda la lista de un tipo. La primera vez que se toca, deja de usar las de por defecto. */
export async function saveCategories(guild: Guild, type: CategoryType, list: ResolvedCategory[]): Promise<void> {
  const store = await getStore(guild.id);
  const toConfig = ({ application: _app, ...rest }: ResolvedCategory): CategoryConfig => rest;
  await setValue(guild.id, CONFIG_KEY, { ...store, [type]: list.map(toConfig) } satisfies CategoriesStore);
}

/** Vuelve a las categorías de por defecto de un tipo. */
export async function resetCategories(guild: Guild, type: CategoryType): Promise<void> {
  const store = await getStore(guild.id);
  const { [type]: _removed, ...rest } = store;
  await setValue(guild.id, CONFIG_KEY, rest satisfies CategoriesStore);
}
