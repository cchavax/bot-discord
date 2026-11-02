// Arranque para hosts que ejecutan `node index.js` (Pterodactyl / bot-hosting.net): el bot está
// en TypeScript, así que primero se registra tsx y después se carga el punto de entrada real.
import { register } from "tsx/esm/api";

register();
await import("./src/index.ts");
