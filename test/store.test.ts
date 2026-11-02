/** Tests de la migración del store al formato por servidor y de los colores de marca. Ejecutar con:  npm test */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateLegacy } from "../src/store.js";
import { formatHexColor, parseHexColor } from "../src/ui.js";

describe("migrateLegacy", () => {
  it("deja igual un archivo que ya está en el formato nuevo", () => {
    const raw = { version: 2, guilds: { "1": { welcome: { channelId: "a" } } } };
    const { data, migrated } = migrateLegacy(raw, "1");
    assert.equal(migrated, false);
    assert.deepEqual(data, raw);
  });

  it("un archivo vacío arranca en el formato nuevo sin migrar nada", () => {
    assert.deepEqual(migrateLegacy({}, "1"), { data: { version: 2, guilds: {} }, migrated: false });
  });

  it("mueve las claves viejas al servidor de GUILD_ID y conserva la marca original", () => {
    const raw = { welcome: { channelId: "a" }, tickets: { categoryId: "b" } };
    const { data, migrated } = migrateLegacy(raw, "123");
    assert.equal(migrated, true);
    assert.deepEqual(data.guilds["123"]?.welcome, { channelId: "a" });
    assert.deepEqual(data.guilds["123"]?.tickets, { categoryId: "b" });
    assert.deepEqual(data.guilds["123"]?.branding, { systemName: "Aura System", serverName: "Aura Craft" });
  });

  it("sin GUILD_ID no pierde nada: lo guarda aparte", () => {
    const raw = { welcome: { channelId: "a" } };
    const { data } = migrateLegacy(raw, undefined);
    assert.deepEqual(data.guilds, {});
    assert.deepEqual(data.legacy, raw);
  });
});

describe("colores de marca", () => {
  it("acepta hex con o sin #", () => {
    assert.equal(parseHexColor("#6c3ce9"), 0x6c3ce9);
    assert.equal(parseHexColor("FFD700"), 0xffd700);
  });

  it("rechaza lo que no es un color", () => {
    assert.equal(parseHexColor("violeta"), null);
    assert.equal(parseHexColor("#12345"), null);
  });

  it("formatea con ceros a la izquierda", () => {
    assert.equal(formatHexColor(0x00ff00), "#00ff00");
  });
});
