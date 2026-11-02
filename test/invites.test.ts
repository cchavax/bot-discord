/** Tests de la lógica de invitaciones. Ejecutar con:  npm test */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type InviteSnapshot, detectUsedInvite, milestonesReached } from "../src/features/invites/logic.js";

describe("detectUsedInvite", () => {
  it("encuentra la invitación cuyos usos subieron", () => {
    const before = [
      { code: "AAA", uses: 2, inviterId: "1" },
      { code: "BBB", uses: 0, inviterId: "2" },
    ];
    const after = [
      { code: "AAA", uses: 2, inviterId: "1" },
      { code: "BBB", uses: 1, inviterId: "2" },
    ];
    assert.deepEqual(detectUsedInvite(before, after), { code: "BBB", uses: 1, inviterId: "2" });
  });

  it("devuelve undefined si nada cambió (puede ser un vínculo vanity)", () => {
    const before = [{ code: "AAA", uses: 2, inviterId: "1" }];
    const after = [{ code: "AAA", uses: 2, inviterId: "1" }];
    assert.equal(detectUsedInvite(before, after), undefined);
  });

  it("una invitación nueva con un uso también cuenta", () => {
    const before: InviteSnapshot[] = [];
    const after = [{ code: "CCC", uses: 1, inviterId: "3" }];
    assert.deepEqual(detectUsedInvite(before, after), { code: "CCC", uses: 1, inviterId: "3" });
  });

  it("detecta una invitación de 1 uso que Discord borró al usarse", () => {
    const before = [
      { code: "AAA", uses: 2, inviterId: "1", maxUses: 0 },
      { code: "ONE", uses: 0, inviterId: "4", maxUses: 1 },
    ];
    const after = [{ code: "AAA", uses: 2, inviterId: "1", maxUses: 0 }];
    assert.equal(detectUsedInvite(before, after)?.code, "ONE");
  });

  it("no adivina si una ilimitada desapareció (la borraron a mano)", () => {
    const before = [{ code: "AAA", uses: 2, inviterId: "1", maxUses: 0 }];
    assert.equal(detectUsedInvite(before, []), undefined);
  });

  it("no adivina si se borraron varias con un uso restante a la vez", () => {
    const before = [
      { code: "X", uses: 0, inviterId: "1", maxUses: 1 },
      { code: "Y", uses: 4, inviterId: "2", maxUses: 5 },
    ];
    assert.equal(detectUsedInvite(before, []), undefined);
  });
});

describe("milestonesReached", () => {
  const milestones = [
    { count: 5, reward: "A" },
    { count: 10, reward: "B" },
    { count: 15, reward: "C" },
  ];

  it("ningún hito si no se llegó al primero", () => {
    assert.deepEqual(milestonesReached(milestones, 2, 4), []);
  });

  it("un hito al cruzarlo justo", () => {
    assert.deepEqual(milestonesReached(milestones, 4, 5), [{ count: 5, reward: "A" }]);
  });

  it("varios hitos de una si se saltean (ej. recompensas manuales atrasadas)", () => {
    assert.deepEqual(milestonesReached(milestones, 3, 11), [
      { count: 5, reward: "A" },
      { count: 10, reward: "B" },
    ]);
  });

  it("no repite un hito ya cruzado antes", () => {
    assert.deepEqual(milestonesReached(milestones, 5, 5), []);
  });
});
