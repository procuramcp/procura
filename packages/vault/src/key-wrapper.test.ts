import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalKeyWrapper, parseMasterKey } from "./key-wrapper.ts";

describe("parseMasterKey", () => {
  it("accepts 32 base64 bytes", () => {
    const key = randomBytes(32);
    expect(parseMasterKey(key.toString("base64")).equals(key)).toBe(true);
  });

  it.each([
    [undefined, "is not set"],
    ["", "is not set"],
    ["not base64!!", "must be base64"],
    [randomBytes(16).toString("base64"), "must decode to 32 bytes, got 16"],
  ])("rejects %s", (value, message) => {
    expect(() => parseMasterKey(value)).toThrow(message);
  });

  it("never puts the value in the error", () => {
    const bad = Buffer.from("a".repeat(20)).toString("base64");
    expect(() => parseMasterKey(bad)).toThrow(expect.objectContaining({ message: expect.not.stringContaining(bad) }));
  });
});

describe("LocalKeyWrapper", () => {
  const wrapper = new LocalKeyWrapper(randomBytes(32));

  it("round-trips a data key for the same context", async () => {
    const dek = randomBytes(32);
    const wrapped = await wrapper.wrap(dek, "tenant-a");
    expect((await wrapper.unwrap(wrapped, "tenant-a")).equals(dek)).toBe(true);
  });

  it("refuses a different context", async () => {
    const wrapped = await wrapper.wrap(randomBytes(32), "tenant-a");
    await expect(wrapper.unwrap(wrapped, "tenant-b")).rejects.toThrow("decryption failed");
  });

  it("has a stable id that does not reveal the key", () => {
    const key = randomBytes(32);
    const a = new LocalKeyWrapper(key);
    expect(a.keyId).toBe(new LocalKeyWrapper(key).keyId);
    expect(a.keyId).not.toContain(key.toString("hex").slice(0, 8));
  });
});
