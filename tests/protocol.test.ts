import { describe, expect, test } from "bun:test";
import { CREDITS_SERVICE_ORIGIN, creditsProtocol } from "../src/index.js";
import { profile } from "./helpers.js";

describe("protocol", () => {
  test("describes commands, exit codes and lifecycle from the product prefix", () => {
    const protocol = creditsProtocol(profile);
    expect(protocol.schemaVersion).toBe("hraness-credits-protocol-v1");
    expect(protocol.product).toEqual({ id: "peopleblade", name: "PeopleBlade" });
    expect(protocol.serviceOrigin).toBe(CREDITS_SERVICE_ORIGIN);
    expect(protocol.commands.status).toEqual(["peopleblade", "credits", "status", "--json"]);
    expect(protocol.commands.email).toEqual(["peopleblade", "credits", "email", "--to", "{address}"]);
    expect(protocol.commands.estimate).toEqual(["peopleblade", "credits", "estimate", "{operation}", "--json"]);
    expect(protocol.commands.signout).toEqual(["peopleblade", "credits", "signout"]);
    expect(Object.keys(protocol.commands)).toEqual(["protocol", "status", "topup", "email", "wait", "estimate", "signout"]);
    expect(protocol.exitCodes["3"]).toBe("payment still required after wait timed out");
    expect(protocol.schemas.required).toBe("hraness-credits-required-v1");
    expect(protocol.lifecycle.payment.toLowerCase()).toContain("never enter card details");
    expect(Object.isFrozen(protocol)).toBe(true);
    expect(Object.isFrozen(protocol.lifecycle)).toBe(true);
  });

  test("survives JSON serialization unchanged and keeps pricing opaque", () => {
    const protocol = creditsProtocol({ ...profile, command: ["npx", "peopleblade"], serviceOrigin: "http://127.0.0.1:8787" });
    const text = JSON.stringify(protocol);
    expect(JSON.parse(text)).toEqual(protocol);
    expect(protocol.commands.wait).toEqual(["npx", "peopleblade", "credits", "wait", "--json"]);
    expect(protocol.serviceOrigin).toBe("http://127.0.0.1:8787");
    for (const forbidden of ["take rate", "takeRate", "margin", "provider cost", "uplift"]) expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  test("rejects invalid profiles", () => {
    expect(() => creditsProtocol({ ...profile, command: [] })).toThrow(TypeError);
    expect(() => creditsProtocol({ ...profile, id: "People Blade" })).toThrow(TypeError);
  });
});
