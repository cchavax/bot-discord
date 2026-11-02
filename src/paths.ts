/**
 * Carpeta de datos del bot (config.json y transcripciones). Se calcula desde la ubicación de
 * este archivo, no desde la carpeta desde la que se ejecuta el comando: así el bot encuentra
 * sus datos aunque lo arranques desde otro lado (ej. un servicio o un panel de hosting).
 * Se puede cambiar con la variable de entorno DATA_DIR.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, "data");
