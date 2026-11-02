import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Guild,
  Interaction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

/** Un comando slash: su definición y lo que hace al ejecutarse. */
export interface Command {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  /** Sugerencias mientras se escribe una opción con `.setAutocomplete(true)`. */
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

/** Resultado de revisar si un sistema está bien configurado (ver Feature.checkHealth). */
export interface HealthCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** Un sistema del bot (tags, tickets, logs...). Cada uno se registra en src/index.ts. */
export interface Feature {
  name: string;
  commands: Command[];
  /** Engancha los eventos que necesite. */
  register(client: Client): void;
  /** Botones, menús y formularios del sistema. Devuelve true si la interacción era suya. */
  handleInteraction?(interaction: Interaction): Promise<boolean>;
  /** Si el sistema tiene configuración (canales, roles), la revisa y dice si sigue en pie. */
  checkHealth?(guild: Guild): Promise<HealthCheck>;
}
