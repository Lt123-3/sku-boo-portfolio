import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getShipFromAddress } from "./shippo.server.js";

const KEYS = [
  "SHIP_FROM_NAME",
  "SHIP_FROM_STREET1",
  "SHIP_FROM_CITY",
  "SHIP_FROM_STATE",
  "SHIP_FROM_ZIP",
];

describe("getShipFromAddress", () => {
  let saved;

  beforeEach(() => {
    // Snapshot then clear every SHIP_FROM_* var so each test starts clean.
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function setRequired() {
    process.env.SHIP_FROM_STREET1 = "123 Warehouse Way";
    process.env.SHIP_FROM_CITY = "Portland";
    process.env.SHIP_FROM_STATE = "OR";
    process.env.SHIP_FROM_ZIP = "97201";
  }

  it("returns the address when all required vars are set", () => {
    setRequired();
    process.env.SHIP_FROM_NAME = "Sku-Boo HQ";
    expect(getShipFromAddress()).toEqual({
      name: "Sku-Boo HQ",
      street1: "123 Warehouse Way",
      city: "Portland",
      state: "OR",
      zip: "97201",
    });
  });

  it("falls back to 'Shipping Desk' when SHIP_FROM_NAME is unset", () => {
    setRequired();
    expect(getShipFromAddress().name).toBe("Shipping Desk");
  });

  it.each(["SHIP_FROM_STREET1", "SHIP_FROM_CITY", "SHIP_FROM_STATE", "SHIP_FROM_ZIP"])(
    "throws when %s is missing",
    (missing) => {
      setRequired();
      delete process.env[missing];
      expect(() => getShipFromAddress()).toThrow(/SHIP_FROM_\* env vars not fully set/);
    },
  );

  it("treats an empty-string value as missing", () => {
    setRequired();
    process.env.SHIP_FROM_CITY = "";
    expect(() => getShipFromAddress()).toThrow(/Server misconfigured/);
  });
});
