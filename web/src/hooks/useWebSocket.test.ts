// @ts-ignore - bun:test is provided by Bun at runtime in this package.
import { describe, expect, test } from "bun:test";
import { getReconnectDelayMs } from "./useWebSocket";

describe("getReconnectDelayMs", () => {
  test("starts at the initial delay and doubles per failed attempt", () => {
    expect(getReconnectDelayMs(0)).toBe(1500);
    expect(getReconnectDelayMs(1)).toBe(3000);
    expect(getReconnectDelayMs(2)).toBe(6000);
    expect(getReconnectDelayMs(3)).toBe(12000);
  });

  test("caps at the max delay instead of growing forever", () => {
    expect(getReconnectDelayMs(4)).toBe(24000);
    expect(getReconnectDelayMs(5)).toBe(30000);
    expect(getReconnectDelayMs(50)).toBe(30000);
    expect(getReconnectDelayMs(1000)).toBe(30000);
  });

  test("treats negative attempt counts as the first attempt", () => {
    expect(getReconnectDelayMs(-1)).toBe(1500);
  });
});
