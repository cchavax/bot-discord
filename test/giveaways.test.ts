/** Tests de la lógica de sorteos. Ejecutar con:  npm test */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandPrizeSlots, parsePrizes, pickWinners } from "../src/features/giveaways/logic.js";

describe("pickWinners", () => {
  it("sin participantes, no hay ganadores", () => {
    assert.deepEqual(pickWinners([], 3), []);
  });

  it("si piden más ganadores que participantes, devuelve a todos sin repetir", () => {
    const result = pickWinners(["a", "b"], 5, () => 0);
    assert.deepEqual([...result].sort(), ["a", "b"]);
  });

  it("nunca repite a la misma persona", () => {
    const result = pickWinners(["a", "b", "c", "d"], 3, () => 0.99);
    assert.equal(new Set(result).size, result.length);
    assert.equal(result.length, 3);
  });

  it("es determinístico con un random fijo", () => {
    // pool=[a,b,c] -> idx 0 => "a"; pool=[b,c] -> idx 0 => "b"
    assert.deepEqual(pickWinners(["a", "b", "c"], 2, () => 0), ["a", "b"]);
  });

  it("con count 0 no elige a nadie", () => {
    assert.deepEqual(pickWinners(["a", "b"], 0), []);
  });
});

describe("parsePrizes", () => {
  it("una línea sin cantidad vale 1", () => {
    assert.deepEqual(parsePrizes("Rango VIP"), [{ name: "Rango VIP", quantity: 1 }]);
  });

  it("entiende el formato 'Premio x3'", () => {
    assert.deepEqual(parsePrizes("Diamante x3"), [{ name: "Diamante", quantity: 3 }]);
  });

  it("ignora líneas vacías y espacios de más", () => {
    assert.deepEqual(parsePrizes("  Rango VIP x2  \n\n  Diamante  "), [
      { name: "Rango VIP", quantity: 2 },
      { name: "Diamante", quantity: 1 },
    ]);
  });

  it("no entiende 'x0' como vacío, lo deja en 1 como mínimo", () => {
    assert.deepEqual(parsePrizes("Diamante x0"), [{ name: "Diamante", quantity: 1 }]);
  });
});

describe("expandPrizeSlots", () => {
  it("repite el nombre según la cantidad", () => {
    assert.deepEqual(expandPrizeSlots([{ name: "Diamante", quantity: 2 }]), ["Diamante", "Diamante"]);
  });

  it("junta los cupos de varios premios en orden", () => {
    assert.deepEqual(
      expandPrizeSlots([
        { name: "Rango VIP", quantity: 1 },
        { name: "Diamante", quantity: 2 },
      ]),
      ["Rango VIP", "Diamante", "Diamante"],
    );
  });

  it("sin premios, no hay cupos", () => {
    assert.deepEqual(expandPrizeSlots([]), []);
  });
});
