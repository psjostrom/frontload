import { describe, expect, it } from "vitest";
import { parsePositiveInteger } from "../../src/cli/options.js";

describe("CLI option parsing", () => {
  it("accepts positive integers", () => {
    expect(parsePositiveInteger("12")).toBe(12);
  });

  it("rejects non-numeric, fractional, zero, and negative values", () => {
    for (const value of ["nope", "1.5", "0", "-2"]) {
      expect(() => parsePositiveInteger(value)).toThrow("Expected a positive integer");
    }
  });
});
