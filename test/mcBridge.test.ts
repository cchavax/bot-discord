import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAuthorized } from "../src/features/mcBridge/server.js";
import { createLinkCode, pollStaffChat, pushStaffChatToMinecraft, redeemLinkCode } from "../src/features/mcBridge/store.js";

describe("puente con Minecraft", () => {
  it("solo acepta el header con el secreto exacto", () => {
    assert.equal(isAuthorized("Bearer abc", "abc"), true);
    assert.equal(isAuthorized("Bearer abd", "abc"), false);
    assert.equal(isAuthorized("abc", "abc"), false);
    assert.equal(isAuthorized(undefined, "abc"), false);
    assert.equal(isAuthorized("Bearer ", undefined), false);
  });

  it("los códigos tienen 6 caracteres legibles y se usan una sola vez", () => {
    const code = createLinkCode("g1", "u1");
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(redeemLinkCode(code.toLowerCase())?.discordId, "u1");
    assert.equal(redeemLinkCode(code), null);
  });

  it("los ids del staff chat superan a cualquier cursor de una ejecución anterior del bot", () => {
    const cursorDeLaEjecucionAnterior = 500;
    pushStaffChatToMinecraft("g2", "Ana", "hola");
    const [message] = pollStaffChat("g2", cursorDeLaEjecucionAnterior);
    assert.equal(message?.text, "hola");
  });
});
