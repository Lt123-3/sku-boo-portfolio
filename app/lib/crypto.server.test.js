import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "./crypto.server.js";

describe("crypto.server encrypt/decrypt", () => {
  it("round-trips a plain string", () => {
    const plaintext = "hello world";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("round-trips a realistic API key", () => {
    const key = "sk-ant-api03-abcDEF123456_-xyz";
    expect(decrypt(encrypt(key))).toBe(key);
  });

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("round-trips unicode and punctuation", () => {
    const s = "clé — café ☕ \"quotes\" 'apostrophe' \n newline";
    expect(decrypt(encrypt(s))).toBe(s);
  });

  it("coerces non-string input to a string", () => {
    expect(decrypt(encrypt(12345))).toBe("12345");
  });

  it("produces the iv:authTag:ciphertext hex shape", () => {
    const payload = encrypt("shape check");
    const parts = payload.split(":");
    expect(parts).toHaveLength(3);
    // 12-byte IV -> 24 hex chars; 16-byte GCM tag -> 32 hex chars.
    expect(parts[0]).toMatch(/^[0-9a-f]{24}$/);
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it("uses a fresh IV each call, so ciphertext differs for the same input", () => {
    expect(encrypt("same input")).not.toBe(encrypt("same input"));
  });

  it("throws on a payload that is not three colon-separated parts", () => {
    expect(() => decrypt("not-a-valid-payload")).toThrow(/Malformed encrypted payload/);
    expect(() => decrypt("only:two")).toThrow(/Malformed encrypted payload/);
  });

  it("throws when the ciphertext has been tampered with (GCM auth fails)", () => {
    const payload = encrypt("authentic");
    const [iv, tag, ct] = payload.split(":");
    // Flip the last hex nibble of the ciphertext.
    const lastChar = ct.slice(-1);
    const flipped = lastChar === "0" ? "1" : "0";
    const tampered = `${iv}:${tag}:${ct.slice(0, -1)}${flipped}`;
    expect(() => decrypt(tampered)).toThrow();
  });
});
