import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Revisá tu archivo .env (podés copiar .env.example).`);
  }
  return value;
}

export const config = {
  token: required("DISCORD_TOKEN"),
  /**
   * OPCIONAL. El bot funciona en todos los servidores donde esté. GUILD_ID solo se usa para:
   *  - pasar la configuración vieja (de cuando era de un solo servidor) a ese servidor, y
   *  - las encuestas/hitos que se mandaron por DM antes del cambio a multi-servidor.
   */
  legacyGuildId: process.env.GUILD_ID || undefined,
} as const;
