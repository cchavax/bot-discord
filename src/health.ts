/**
 * Ayudas para los chequeos de configuración (Feature.checkHealth): no alcanza con que el canal
 * o el rol existan, el bot también tiene que poder usarlos. En un servidor nuevo lo más común
 * es que falte un permiso, y esto lo dice con nombre y apellido.
 */
import { type Guild, PermissionFlagsBits, type PermissionResolvable, PermissionsBitField } from "discord.js";

const PERMISSION_NAMES: Partial<Record<keyof typeof PermissionFlagsBits, string>> = {
  ViewChannel: "Ver canal",
  SendMessages: "Enviar mensajes",
  EmbedLinks: "Insertar enlaces",
  AttachFiles: "Adjuntar archivos",
  ReadMessageHistory: "Leer el historial",
  AddReactions: "Añadir reacciones",
  ManageChannels: "Gestionar canales",
  ManageRoles: "Gestionar roles",
  ManageGuild: "Gestionar servidor",
  ManageNicknames: "Gestionar apodos",
  MentionEveryone: "Mencionar a todos",
  Connect: "Conectar",
};

export const TEXT_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
] as const;

function permissionNames(perms: PermissionsBitField): string {
  return perms
    .toArray()
    .map((name) => PERMISSION_NAMES[name] ?? name)
    .join(", ");
}

/**
 * Revisa que el canal exista y que el bot tenga los permisos pedidos ahí.
 * Devuelve null si está todo bien, o el problema en una frase.
 */
export async function channelProblem(guild: Guild, channelId: string, needed: readonly PermissionResolvable[] = TEXT_PERMS): Promise<string | null> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return "el canal configurado ya no existe";
  const me = guild.members.me;
  if (!me) return null;
  const missing = channel.permissionsFor(me).missing(needed as PermissionResolvable[]);
  if (missing.length === 0) return null;
  return `me faltan permisos en <#${channel.id}>: ${permissionNames(new PermissionsBitField(missing))}`;
}

/** Permisos generales (de servidor) que le faltan al bot, o null si los tiene todos. */
export function guildPermissionProblem(guild: Guild, needed: readonly PermissionResolvable[]): string | null {
  const me = guild.members.me;
  if (!me) return null;
  const missing = me.permissions.missing(needed as PermissionResolvable[]);
  if (missing.length === 0) return null;
  return `me falta el permiso de servidor: ${permissionNames(new PermissionsBitField(missing))}`;
}

/** Revisa que el rol exista y que el bot lo pueda dar/quitar (tiene que estar por encima en la lista). */
export async function roleProblem(guild: Guild, roleId: string): Promise<string | null> {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return "el rol configurado ya no existe";
  const perm = guildPermissionProblem(guild, [PermissionFlagsBits.ManageRoles]);
  if (perm) return perm;
  if (!role.editable) return `el rol <@&${role.id}> está por encima del mío: subí mi rol en Ajustes del servidor → Roles`;
  return null;
}
