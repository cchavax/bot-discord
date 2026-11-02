/** Sistema 5b: encuestas. Usa las encuestas nativas de Discord (votos y cierre los maneja Discord solo). */
import { type ChatInputCommandInteraction, InteractionContextType, SlashCommandBuilder } from "discord.js";
import type { Command, Feature } from "../types.js";

const MAX_OPTIONS = 5;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 768; // 32 días: el máximo que permite Discord

const pollCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("encuesta")
    .setDescription("Crea una encuesta")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName("pregunta").setDescription("La pregunta").setRequired(true).setMaxLength(300))
    .addStringOption((o) => o.setName("opcion1").setDescription("Opción 1").setRequired(true).setMaxLength(55))
    .addStringOption((o) => o.setName("opcion2").setDescription("Opción 2").setRequired(true).setMaxLength(55))
    .addStringOption((o) => o.setName("opcion3").setDescription("Opción 3").setMaxLength(55))
    .addStringOption((o) => o.setName("opcion4").setDescription("Opción 4").setMaxLength(55))
    .addStringOption((o) => o.setName("opcion5").setDescription("Opción 5").setMaxLength(55))
    .addIntegerOption((o) =>
      o
        .setName("horas")
        .setDescription(`Cuánto dura, en horas (por defecto ${DEFAULT_HOURS}, máximo ${MAX_HOURS})`)
        .setMinValue(1)
        .setMaxValue(MAX_HOURS),
    )
    .addBooleanOption((o) => o.setName("multiple").setDescription("¿Se puede votar más de una opción? (por defecto no)"))
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const pregunta = interaction.options.getString("pregunta", true);
    const opciones = Array.from({ length: MAX_OPTIONS }, (_, i) => interaction.options.getString(`opcion${i + 1}`)).filter(
      (texto): texto is string => Boolean(texto),
    );
    const horas = interaction.options.getInteger("horas") ?? DEFAULT_HOURS;
    const multiple = interaction.options.getBoolean("multiple") ?? false;

    await interaction.reply({
      poll: {
        question: { text: pregunta },
        answers: opciones.map((texto) => ({ text: texto })),
        duration: horas,
        allowMultiselect: multiple,
      },
    });
  },
};

export const polls: Feature = {
  name: "polls",
  commands: [pollCommand],
  register(): void {
    /* no necesita eventos: Discord maneja los votos y el cierre */
  },
};
