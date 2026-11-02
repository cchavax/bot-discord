/** Tests de moderación, automod y anuncios (lógica pura). Ejecutar con:  npm test */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextOccurrence, parseWhen, zonedToUtc } from "../src/features/announcements/logic.js";
import { SlidingWindow, blockedLinks, hasInvite, linkDomains, parseDomainList } from "../src/features/automod/logic.js";
import { type ModCase, activeWarns, escalationFor, formatDuration, parseDuration } from "../src/features/moderation/logic.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("parseDuration", () => {
  it("entiende unidades y combinaciones", () => {
    assert.equal(parseDuration("10m"), 10 * MIN);
    assert.equal(parseDuration("1h30m"), 90 * MIN);
    assert.equal(parseDuration("2d"), 2 * DAY);
    assert.equal(parseDuration("1 sem"), 7 * DAY);
    assert.equal(parseDuration("1h 30m"), 90 * MIN);
  });

  it("un número solo son minutos", () => {
    assert.equal(parseDuration("15"), 15 * MIN);
  });

  it("rechaza lo que no entiende", () => {
    assert.equal(parseDuration("mucho"), null);
    assert.equal(parseDuration("10x"), null);
    assert.equal(parseDuration(""), null);
    assert.equal(parseDuration("0m"), null);
  });

  it("formatea en las dos unidades más grandes", () => {
    assert.equal(formatDuration(90 * MIN), "1 h 30 min");
    assert.equal(formatDuration(2 * DAY + 3 * HOUR + 5 * MIN), "2 d 3 h");
  });
});

describe("escala de sanciones", () => {
  const cases: ModCase[] = [
    { id: 1, type: "warn", userId: "a", moderatorId: "m", reason: "x", at: 0 },
    { id: 2, type: "warn", userId: "a", moderatorId: "m", reason: "x", at: 0, removed: true },
    { id: 3, type: "mute", userId: "a", moderatorId: "m", reason: "x", at: 0 },
    { id: 4, type: "warn", userId: "b", moderatorId: "m", reason: "x", at: 0 },
  ];

  it("cuenta solo los warns vigentes de esa persona", () => {
    assert.equal(activeWarns(cases, "a"), 1);
    assert.equal(activeWarns(cases, "c"), 0);
  });

  it("se dispara justo al llegar a la cantidad, no después", () => {
    const steps = [{ warns: 3, action: "mute" as const, durationMs: HOUR }];
    assert.equal(escalationFor(steps, 2), null);
    assert.deepEqual(escalationFor(steps, 3), steps[0]);
    assert.equal(escalationFor(steps, 4), null);
  });
});

describe("automod", () => {
  it("detecta invitaciones a otros servidores", () => {
    assert.ok(hasInvite("entren a discord.gg/abc123"));
    assert.ok(hasInvite("https://discord.com/invite/xyz"));
    assert.ok(!hasInvite("discord.com/channels/1/2"));
  });

  it("saca los dominios de los links", () => {
    assert.deepEqual(linkDomains("mirá https://www.YouTube.com/watch?v=1 y www.twitch.tv/x"), ["youtube.com", "twitch.tv"]);
  });

  it("deja pasar dominios permitidos (y sus subdominios) y los de Discord", () => {
    assert.deepEqual(blockedLinks("https://m.youtube.com/x https://cdn.discordapp.com/a.png", ["youtube.com"]), []);
    assert.deepEqual(blockedLinks("https://scam.ru/free-nitro", ["youtube.com"]), ["scam.ru"]);
  });

  it("no confunde un dominio que termina igual", () => {
    assert.deepEqual(blockedLinks("https://notyoutube.com", ["youtube.com"]), ["notyoutube.com"]);
  });

  it("arma la lista de permitidos desde texto libre", () => {
    assert.deepEqual(parseDomainList("YouTube.com, https://twitch.tv/algo  x.com basura"), ["youtube.com", "twitch.tv", "x.com"]);
  });

  it("la ventana de tiempo cuenta solo lo reciente", () => {
    const w = new SlidingWindow();
    assert.equal(w.hit("u", 5000, 0), 1);
    assert.equal(w.hit("u", 5000, 1000), 2);
    assert.equal(w.hit("u", 5000, 7000), 1); // los de 0 y 1000 ya salieron de la ventana
    assert.equal(w.hit("otro", 5000, 7000), 1);
  });
});

describe("anuncios: cuándo", () => {
  const tz = "America/Argentina/Buenos_Aires"; // UTC-3, sin horario de verano
  // 30/10/2026 15:00 en Argentina = 18:00 UTC
  const now = Date.UTC(2026, 9, 30, 18, 0);

  it("pasa hora de Argentina a UTC", () => {
    assert.equal(zonedToUtc(2026, 10, 30, 15, 0, tz), now);
  });

  it("vacío o 'ahora' es ya", () => {
    assert.equal(parseWhen("", now, tz), now);
    assert.equal(parseWhen("ahora", now, tz), now);
  });

  it("tiempos relativos", () => {
    assert.equal(parseWhen("en 2h", now, tz), now + 2 * HOUR);
    assert.equal(parseWhen("1h30m", now, tz), now + 90 * MIN);
  });

  it("una hora de hoy, o de mañana si ya pasó", () => {
    assert.equal(parseWhen("18:30", now, tz), Date.UTC(2026, 9, 30, 21, 30));
    assert.equal(parseWhen("10:00", now, tz), Date.UTC(2026, 9, 31, 13, 0));
  });

  it("fecha y hora", () => {
    assert.equal(parseWhen("31/10 20:00", now, tz), Date.UTC(2026, 9, 31, 23, 0));
    assert.equal(parseWhen("1/1/2027 00:00", now, tz), Date.UTC(2027, 0, 1, 3, 0));
  });

  it("rechaza fechas inválidas o pasadas con año", () => {
    assert.equal(parseWhen("32/10 20:00", now, tz), null);
    assert.equal(parseWhen("25:00", now, tz), null);
    assert.equal(parseWhen("1/1/2020 10:00", now, tz), null);
    assert.equal(parseWhen("mañana", now, tz), null);
  });

  it("repeticiones: la próxima siempre en el futuro, sin mandar las atrasadas", () => {
    assert.equal(nextOccurrence(now, "no", now), null);
    assert.equal(nextOccurrence(now, "diario", now), now + DAY);
    assert.equal(nextOccurrence(now, "semanal", now), now + 7 * DAY);
    assert.equal(nextOccurrence(now - 3 * DAY - HOUR, "diario", now), now + 23 * HOUR);
  });
});
