/** Tests de la lógica de apodos. Ejecutar con:  npm test */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_NICK,
  compose,
  desiredNick,
  findRank,
  rankChanged,
  stripTag,
} from "../src/nickLogic.js";
import { RANKS, type Rank, nextTierUp, staffTiers } from "../src/ranks.js";

const rank = (role: string): Rank => {
  const r = RANKS.find((x) => x.role === role);
  if (!r) throw new Error(`rango inexistente: ${role}`);
  return r;
};

describe("formato del tag", () => {
  it("formato básico, sin guion", () => {
    assert.equal(compose(rank("Head Staff"), ".cchava"), "[Head Staff] .cchava");
  });

  it("el límite de 32 nunca se pasa", () => {
    for (const r of RANKS) {
      for (const base of ["a", "x".repeat(15), "x".repeat(40)]) {
        assert.ok(compose(r, base).length <= MAX_NICK, `${r.role} / ${base}`);
      }
    }
  });

  it("usa la abreviatura si no entra completo", () => {
    const base = "x".repeat(20); // "[Moderador Sr] " + 20 = 35 > 32
    assert.equal(compose(rank("Moderador Sr"), base), `[Mod Sr] ${base}`);
  });

  it("trunca el nombre si ni con abreviatura entra", () => {
    const out = compose(rank("Moderador Sr"), "x".repeat(40));
    assert.equal(out.length, 32);
    assert.ok(out.startsWith("[Mod Sr] "));
  });

  it("trunca el nombre en rangos sin abreviatura", () => {
    const out = compose(rank("Helper Sr"), "x".repeat(40));
    assert.equal(out.length, 32);
    assert.ok(out.startsWith("[Helper Sr] "));
  });
});

describe("stripTag", () => {
  it("quita el tag completo y el abreviado", () => {
    assert.equal(stripTag("[Moderador Sr] Pepe"), "Pepe");
    assert.equal(stripTag("[Mod Sr] Pepe"), "Pepe");
    assert.equal(stripTag("[HS] Pepe"), "Pepe");
  });

  it("no confunde Moderador con Moderador Sr", () => {
    assert.equal(stripTag("[Moderador Sr] Ana"), "Ana");
    assert.equal(stripTag("[Moderador] Ana"), "Ana");
  });

  it("no toca corchetes ajenos", () => {
    assert.equal(stripTag("[ES] Juan"), "[ES] Juan");
    assert.equal(stripTag("[Cordoba] Juan"), "[Cordoba] Juan");
  });
});

describe("findRank", () => {
  it("gana el rango más alto", () => {
    assert.equal(findRank(["Helper", "Moderador Jr", "Staff"])?.role, "Moderador Jr");
    assert.equal(findRank(["Head Staff", "Admin"])?.role, "Head Staff");
  });

  it("los roles no distinguen mayúsculas", () => {
    assert.equal(findRank(["head staff"])?.role, "Head Staff");
  });

  it("ignora adornos al principio y al final del nombre del rol", () => {
    assert.equal(findRank(["・ Admin Sr"])?.role, "Admin Sr");
    assert.equal(findRank(["🛡️ Moderador"])?.role, "Moderador");
    assert.equal(findRank(["• Helper Jr •"])?.role, "Helper Jr");
    assert.equal(findRank(["--- Head Staff ---"])?.role, "Head Staff");
  });

  it("los adornos no hacen que un rol coincida con otro", () => {
    assert.equal(findRank(["・ Moderador Sr"])?.role, "Moderador Sr");
    assert.equal(findRank(["・ Staff"]), null);
  });

  it("sin rango devuelve null", () => {
    assert.equal(findRank(["Jugador", "Staff", "Eventos"]), null);
  });
});

describe("rankChanged (qué dispara el cambio de tag)", () => {
  it("alta: de sin rango a Helper Jr", () => {
    assert.equal(rankChanged(["Jugador"], ["Jugador", "Helper Jr"]), true);
  });

  it("ascenso: de Helper a Moderador Jr", () => {
    assert.equal(rankChanged(["Staff", "Helper"], ["Staff", "Moderador Jr"]), true);
  });

  it("baja: pierde el único rango", () => {
    assert.equal(rankChanged(["Staff", "Trial"], ["Jugador"]), true);
  });

  it("un rol que no es de rango NO dispara cambio", () => {
    assert.equal(rankChanged(["Staff", "Moderador"], ["Staff", "Moderador", "Eventos"]), false);
  });

  it("sumar un rango más bajo al que ya tiene NO cambia el principal", () => {
    assert.equal(rankChanged(["Moderador"], ["Moderador", "Helper"]), false);
  });

  it("sin cambios de roles NO dispara cambio", () => {
    assert.equal(rankChanged(["Jugador"], ["Jugador"]), false);
  });
});

describe("desiredNick", () => {
  it("staff sin apodo usa el nombre global", () => {
    assert.equal(desiredNick(null, "Luli", rank("Helper")), "[Helper] Luli");
  });

  it("un cambio de rango reemplaza el tag", () => {
    assert.equal(desiredNick("[Helper] Luli", "Luli", rank("Moderador")), "[Moderador] Luli");
  });

  it("es idempotente", () => {
    const r = rank("Moderador");
    const once = desiredNick("Luli", "Luli", r);
    assert.equal(desiredNick(once, "Luli", r), once);
  });

  it("al dejar de ser staff se quita el tag", () => {
    assert.equal(desiredNick("[Helper] Luli", "Luli", null), "Luli");
    assert.equal(desiredNick("[Helper]", "Luli", null), null);
  });

  it("un no-staff sin tag no cambia", () => {
    assert.equal(desiredNick(null, "Luli", null), null);
    assert.equal(desiredNick("[ES] Juan", "Juan", null), "[ES] Juan");
  });
});

describe("nextTierUp", () => {
  it("de Trial (cualquier variante), el tier de arriba es Helper completo", () => {
    assert.deepEqual(nextTierUp("Trial"), ["Helper Sr", "Helper", "Helper Jr"]);
    assert.deepEqual(nextTierUp("Trial Sr"), ["Helper Sr", "Helper", "Helper Jr"]);
  });

  it("de cualquier variante de Helper, el tier de arriba es Moderador completo", () => {
    assert.deepEqual(nextTierUp("Helper Jr"), ["Moderador Sr", "Moderador", "Moderador Jr"]);
    assert.deepEqual(nextTierUp("Helper"), ["Moderador Sr", "Moderador", "Moderador Jr"]);
  });

  it("de Admin, el tier de arriba es Head Staff solo", () => {
    assert.deepEqual(nextTierUp("Admin"), ["Head Staff"]);
  });

  it("Owner no tiene tier superior", () => {
    assert.equal(nextTierUp("Owner"), null);
  });

  it("un rango que no existe no tiene tier superior", () => {
    assert.equal(nextTierUp("Inventado"), null);
  });
});

describe("rangos propios de un servidor (por ID de rol)", () => {
  const custom: Rank[] = [
    { role: "111", tag: "Dueño", tier: "dueño" },
    { role: "222", tag: "Mod Sr", short: "MSr", tier: "mod" },
    { role: "333", tag: "Mod", tier: "mod" },
    { role: "444", tag: "Ayudante" },
  ];

  it("encuentra el rango por ID y respeta el orden de la lista", () => {
    assert.equal(findRank(["999", "333", "444"], custom)?.tag, "Mod");
  });

  it("quita solo los tags de esa lista", () => {
    assert.equal(stripTag("[Ayudante] Pepe", custom), "Pepe");
    assert.equal(stripTag("[Helper] Pepe", custom), "[Helper] Pepe");
  });

  it("desiredNick usa los tags propios", () => {
    assert.equal(desiredNick("[Ayudante] Pepe", "Pepe", custom[2] ?? null, custom), "[Mod] Pepe");
  });

  it("los grupos agrupan rangos seguidos, y un rango sin grupo es su propio nivel", () => {
    assert.deepEqual(staffTiers(custom), [["111"], ["222", "333"], ["444"]]);
    assert.deepEqual(nextTierUp("444", custom), ["222", "333"]);
    assert.deepEqual(nextTierUp("333", custom), ["111"]);
  });

  it("sin rangos no rompe nada", () => {
    assert.equal(findRank(["1"], []), null);
    assert.equal(stripTag("[Mod] Pepe", []), "[Mod] Pepe");
    assert.equal(desiredNick("Pepe", "Pepe", null, []), "Pepe");
  });
});
