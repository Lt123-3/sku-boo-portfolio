import { describe, it, expect } from "vitest";
import {
  validateRole,
  validateSkuStatus,
  validateProblems,
} from "./validate.server.js";

describe("validateRole", () => {
  it("returns the value for each valid role", () => {
    expect(validateRole("viewer")).toBe("viewer");
    expect(validateRole("operator")).toBe("operator");
    expect(validateRole("admin")).toBe("admin");
  });

  it("throws on an unknown role", () => {
    expect(() => validateRole("superuser")).toThrow(/Invalid role: "superuser"/);
  });

  it("throws on empty / missing input", () => {
    expect(() => validateRole("")).toThrow(/Invalid role/);
    expect(() => validateRole(undefined)).toThrow(/Invalid role/);
  });

  it("is case-sensitive", () => {
    expect(() => validateRole("Admin")).toThrow(/Invalid role/);
  });

  it("lists the allowed roles in the error message", () => {
    expect(() => validateRole("nope")).toThrow(/viewer, operator, admin/);
  });
});

describe("validateSkuStatus", () => {
  it("returns the value for each valid status", () => {
    for (const status of ["free", "active", "reserved", "problem", "deleted"]) {
      expect(validateSkuStatus(status)).toBe(status);
    }
  });

  it("throws on an unknown status", () => {
    expect(() => validateSkuStatus("archived")).toThrow(
      /Invalid SKU status: "archived"/,
    );
  });

  it("throws on empty input", () => {
    expect(() => validateSkuStatus("")).toThrow(/Invalid SKU status/);
  });
});

describe("validateProblems", () => {
  it("returns an empty array unchanged", () => {
    expect(validateProblems([])).toEqual([]);
  });

  it("returns a valid list unchanged", () => {
    const problems = ["no_sku", "no_pic", "no_title_body"];
    expect(validateProblems(problems)).toBe(problems);
  });

  it("accepts every known problem tag", () => {
    const all = [
      "no_sku",
      "no_title",
      "no_title_sku",
      "no_title_body",
      "no_pic",
      "no_prep",
    ];
    expect(validateProblems(all)).toEqual(all);
  });

  it("throws when any entry is not a known tag", () => {
    expect(() => validateProblems(["no_sku", "bogus"])).toThrow(
      /Invalid problem tag: "bogus"/,
    );
  });
});
