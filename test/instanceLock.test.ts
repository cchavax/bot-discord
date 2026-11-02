/** Tests del bloqueo que evita dos copias del bot a la vez. Ejecutar con:  npm test */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { acquireLock, isAlive, releaseLock } from "../src/instanceLock.js";

const tempLock = () => path.join(mkdtempSync(path.join(tmpdir(), "aura-lock-")), "bot.lock");

describe("bloqueo de instancia", () => {
  it("reconoce procesos vivos y muertos", () => {
    assert.ok(isAlive(process.pid));
    assert.ok(!isAlive(0));
    assert.ok(!isAlive(Number.NaN));
  });

  it("toma el bloqueo si no hay nadie y lo suelta al terminar", () => {
    const file = tempLock();
    assert.equal(acquireLock(file), null);
    assert.equal(readFileSync(file, "utf8"), String(process.pid));
    releaseLock(file);
    assert.ok(!existsSync(file));
  });

  it("no arranca si otra copia viva ya lo tiene", () => {
    const file = tempLock();
    // El proceso padre (npm/tsx) está vivo y no es este: hace de "otra copia".
    writeFileSync(file, String(process.ppid));
    assert.equal(acquireLock(file), process.ppid);
    // Y no se lo saca: el archivo sigue siendo de la otra copia.
    releaseLock(file);
    assert.equal(readFileSync(file, "utf8"), String(process.ppid));
  });

  it("ignora un bloqueo viejo de un proceso que ya no existe", () => {
    const file = tempLock();
    writeFileSync(file, "999999999");
    assert.equal(acquireLock(file), null);
    assert.equal(readFileSync(file, "utf8"), String(process.pid));
  });
});
