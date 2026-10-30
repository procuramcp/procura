import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { TenantId } from "@cairnmcp/core";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalKeyWrapper } from "./key-wrapper.ts";
import { InMemoryVaultStore } from "./store.ts";
import { Vault } from "./vault.ts";

const A = TenantId.parse("tenant-a");
const B = TenantId.parse("tenant-b");
const SECRET = "sk_live_correct-horse-battery-staple";

let store: InMemoryVaultStore;
let wrapper: LocalKeyWrapper;
let vault: Vault;

beforeEach(() => {
  store = new InMemoryVaultStore();
  wrapper = new LocalKeyWrapper(randomBytes(32));
  vault = new Vault({ store, keyWrapper: wrapper });
});

const putKey = (tenantId = A) =>
  vault.putCredential({ tenantId, sourceId: "intervals-icu", schemeId: "APIKey", credential: { kind: "basic", password: SECRET } });

describe("Vault", () => {
  it("stores and returns a credential with the secret wrapped", async () => {
    const { id } = await putKey();
    const cred = await vault.getCredential(A, id);
    expect(cred?.kind).toBe("basic");
    if (cred?.kind !== "basic") throw new Error();
    expect(cred.password.reveal()).toBe(SECRET);
    expect(JSON.stringify(cred)).not.toContain(SECRET);
    expect(inspect(cred)).not.toContain(SECRET);
  });

  it("never stores the plaintext", async () => {
    await putKey();
    const dump = JSON.stringify([await store.listCredentials(A), await store.getDataKey(A)]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(Buffer.from(SECRET).toString("base64"));
  });

  it("returns credentials for a source keyed by scheme", async () => {
    await putKey();
    await vault.putCredential({ tenantId: A, sourceId: "other", schemeId: "Bearer", credential: { kind: "bearer", token: "t" } });
    const creds = await vault.credentialsForSource(A, "intervals-icu");
    expect([...creds.keys()]).toEqual(["APIKey"]);
  });

  it("lists metadata without decrypting", async () => {
    const { id } = await putKey();
    expect(await vault.listCredentials(A)).toEqual([{ id, sourceId: "intervals-icu", schemeId: "APIKey", kind: "basic" }]);
  });

  it("validates credential input and tenant ids", async () => {
    await expect(
      vault.putCredential({ tenantId: A, sourceId: "s", schemeId: "x", credential: { kind: "basic", password: "" } as never }),
    ).rejects.toThrow();
    await expect(
      vault.putCredential({ tenantId: "../etc" as TenantId, sourceId: "s", schemeId: "x", credential: { kind: "bearer", token: "t" } }),
    ).rejects.toThrow();
  });

  it("gives each tenant its own data key", async () => {
    await putKey(A);
    await putKey(B);
    expect((await store.getDataKey(A))?.ciphertext).not.toBe((await store.getDataKey(B))?.ciphertext);
  });

  describe("tamper and cross-tenant resistance", () => {
    it("a ciphertext copied into another tenant does not decrypt", async () => {
      const { id } = await putKey(A);
      await putKey(B); // B has its own data key
      const record = (await store.getCredential(A, id))!;
      await store.putCredential({ ...record, tenantId: B });
      await expect(vault.getCredential(B, id)).rejects.toThrow("decryption failed");
    });

    it("even if the attacker also copies the wrapped data key", async () => {
      const { id } = await putKey(A);
      const record = (await store.getCredential(A, id))!;
      await store.putDataKeyIfAbsent(B, (await store.getDataKey(A))!);
      await store.putCredential({ ...record, tenantId: B });
      await expect(vault.getCredential(B, id)).rejects.toThrow("decryption failed");
    });

    it.each([
      ["source", { sourceId: "evil" }],
      ["scheme", { schemeId: "AccessToken" }],
      ["kind", { kind: "bearer" as const }],
    ])("changing the row's %s breaks decryption", async (_name, patch) => {
      const { id } = await putKey();
      await store.putCredential({ ...(await store.getCredential(A, id))!, ...patch });
      await expect(vault.getCredential(A, id)).rejects.toThrow("decryption failed");
    });

    it("a flipped ciphertext bit is detected", async () => {
      const { id } = await putKey();
      const record = (await store.getCredential(A, id))!;
      const bytes = Buffer.from(record.sealed.ciphertext, "base64");
      bytes[0] = bytes[0]! ^ 1;
      await store.putCredential({ ...record, sealed: { ...record.sealed, ciphertext: bytes.toString("base64") } });
      await expect(vault.getCredential(A, id)).rejects.toThrow("decryption failed");
    });

    it("a different master key cannot read anything", async () => {
      const { id } = await putKey();
      const other = new Vault({ store, keyWrapper: new LocalKeyWrapper(randomBytes(32)) });
      await expect(other.getCredential(A, id)).rejects.toThrow(/no key wrapper/);
    });
  });

  describe("master key rotation", () => {
    it("re-wraps data keys so the old master key can be retired", async () => {
      const { id } = await putKey();
      const next = new LocalKeyWrapper(randomBytes(32));
      const rotating = new Vault({ store, keyWrapper: next, previousKeyWrappers: [wrapper] });
      await rotating.rotateTenantKey(A);
      expect((await store.getDataKey(A))?.keyId).toBe(next.keyId);

      const retired = new Vault({ store, keyWrapper: next });
      const cred = await retired.getCredential(A, id);
      expect(cred?.kind === "basic" && cred.password.reveal()).toBe(SECRET);
    });
  });
});
