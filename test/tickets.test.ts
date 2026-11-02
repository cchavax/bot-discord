/** Tests de tickets (parte pura) y de los rangos. Ejecutar con:  npm test */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPLICATION_CATEGORIES } from "../src/features/tickets/applicationCategories.js";
import { TICKET_CATEGORIES, categoryKey, isValidEmoji, staffRolesFor } from "../src/features/tickets/categories.js";
import { buildTranscript } from "../src/features/tickets/transcript.js";
import { RANKS, normalizeRoleName, roleNamesFrom } from "../src/ranks.js";

describe("normalizeRoleName", () => {
  it("quita adornos y pasa a minúsculas", () => {
    assert.equal(normalizeRoleName("・ Admin Sr"), "admin sr");
    assert.equal(normalizeRoleName("  🛡️ Moderador  "), "moderador");
    assert.equal(normalizeRoleName("Helper Jr"), "helper jr");
  });

  it("conserva los espacios internos", () => {
    assert.equal(normalizeRoleName("・ Head Staff"), "head staff");
  });
});

describe("roleNamesFrom", () => {
  it("incluye desde Owner hasta el rango pedido", () => {
    const names = roleNamesFrom("Moderador Jr");
    assert.equal(names[0], "Owner");
    assert.equal(names.at(-1), "Moderador Jr");
    assert.ok(names.includes("Head Staff"));
    assert.ok(names.includes("Moderador Sr"));
  });

  it("no incluye rangos más bajos", () => {
    const names = roleNamesFrom("Moderador Jr");
    assert.ok(!names.includes("Helper"));
    assert.ok(!names.includes("Trial"));
  });

  it("no distingue mayúsculas y falla con rangos inexistentes", () => {
    assert.equal(roleNamesFrom("owner").length, 1);
    assert.throws(() => roleNamesFrom("Inexistente"));
  });
});

describe("categorías de ticket", () => {
  it("hay entre 1 y 5 (un botón por categoría en una fila)", () => {
    assert.ok(TICKET_CATEGORIES.length >= 1 && TICKET_CATEGORIES.length <= 5);
  });

  it("las claves son únicas y no contienen '|' (se guardan en el tema del canal)", () => {
    const keys = TICKET_CATEGORIES.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const k of keys) assert.ok(!k.includes("|") && !/\s/.test(k), k);
  });

  it("cada staffFrom es un rango que existe", () => {
    const roles = new Set(RANKS.map((r) => r.role));
    for (const c of TICKET_CATEGORIES) assert.ok(roles.has(c.staffFrom), `${c.key} -> ${c.staffFrom}`);
  });

  it("las etiquetas entran en un botón (máx. 80 caracteres)", () => {
    for (const c of TICKET_CATEGORIES) assert.ok(c.label.length <= 80);
  });
});

describe("categorías de postulación", () => {
  it("las claves no chocan con las de soporte (comparten el mismo buscador)", () => {
    const supportKeys = new Set(TICKET_CATEGORIES.map((c) => c.key));
    for (const c of APPLICATION_CATEGORIES) assert.ok(!supportKeys.has(c.key), c.key);
  });

  it("cada staffFrom es un rango que existe", () => {
    const roles = new Set(RANKS.map((r) => r.role));
    for (const c of APPLICATION_CATEGORIES) assert.ok(roles.has(c.staffFrom), `${c.key} -> ${c.staffFrom}`);
  });
});

describe("buildTranscript", () => {
  const header = {
    channel: "soporte-luli",
    category: "Soporte",
    opener: "luli (123)",
    closedBy: "pepe",
    closedAt: new Date("2026-10-28T20:30:00Z"),
  };

  it("ordena por hora y muestra autor y texto", () => {
    const out = buildTranscript(header, [
      { time: new Date("2026-10-28T20:10:00Z"), author: "pepe", content: "Hola", attachments: [] },
      { time: new Date("2026-10-28T20:05:00Z"), author: "luli", content: "Necesito ayuda", attachments: [] },
    ]);
    assert.ok(out.indexOf("luli: Necesito ayuda") < out.indexOf("pepe: Hola"));
    assert.ok(out.includes("[2026-10-28 20:05 UTC] luli: Necesito ayuda"));
  });

  it("indenta mensajes de varias líneas y lista adjuntos", () => {
    const out = buildTranscript(header, [
      { time: new Date("2026-10-28T20:05:00Z"), author: "luli", content: "linea1\nlinea2", attachments: ["https://x/y.png"] },
    ]);
    assert.ok(out.includes("luli: linea1\n    linea2"));
    assert.ok(out.includes("    📎 https://x/y.png"));
  });

  it("indica cuando nadie reclamó el ticket y cuántos mensajes hay", () => {
    const out = buildTranscript(header, []);
    assert.ok(out.includes("Atendido por: (nadie lo reclamó)"));
    assert.ok(out.includes("Mensajes: 0"));
  });

  it("no modifica el arreglo original", () => {
    const entries = [
      { time: new Date("2026-10-28T20:10:00Z"), author: "b", content: "2", attachments: [] },
      { time: new Date("2026-10-28T20:05:00Z"), author: "a", content: "1", attachments: [] },
    ];
    buildTranscript(header, entries);
    assert.equal(entries[0]?.author, "b");
  });
});

describe("categorías configurables", () => {
  const ranks = [
    { role: "1", tag: "Owner" },
    { role: "2", tag: "Mod" },
    { role: "3", tag: "Helper" },
  ];

  it("la atiende el rango mínimo y los de arriba", () => {
    assert.deepEqual(staffRolesFor({ minRoleId: "2" }, ranks), ["1", "2"]);
  });

  it("sin rango mínimo, o si ese rol ya no es rango, la atiende todo el staff", () => {
    assert.deepEqual(staffRolesFor({ minRoleId: null }, ranks), ["1", "2", "3"]);
    assert.deepEqual(staffRolesFor({ minRoleId: "999" }, ranks), ["1", "2", "3"]);
  });

  it("arma claves sin tildes ni espacios, con prefijo para postulaciones", () => {
    assert.equal(categoryKey("Apelar sanción", false), "apelar-sancion");
    assert.equal(categoryKey("Builder", true), "postulacion-builder");
    assert.equal(categoryKey("!!!", false), "categoria");
  });

  it("acepta emojis comunes y de servidor, y rechaza texto", () => {
    assert.ok(isValidEmoji("🎫"));
    assert.ok(isValidEmoji("<:ticket:1565178754542604339>"));
    assert.ok(isValidEmoji("<a:wave:1565153135184449637>"));
    assert.ok(!isValidEmoji("ticket"));
    assert.ok(!isValidEmoji(":ticket:"));
    assert.ok(!isValidEmoji("🎫 hola"));
  });
});
