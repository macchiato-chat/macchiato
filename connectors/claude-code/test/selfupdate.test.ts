import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  assertSelfUpdateAllowed,
  buildInstallerEnv,
  parseStrictSemver,
  semverLt,
  verifyManifest,
} from "../src/selfupdate";

/** 一次性測試密鑰對(與生產公鑰無關)。 */
function testKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKey, pubHex: raw.toString("hex") };
}
const manifestOf = (version: string, files: Record<string, string>) =>
  Buffer.from(
    JSON.stringify(
      {
        version,
        bootstrapVersion: 1,
        bootstrapSha256: "ab".repeat(32),
        files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
      },
      null,
      2,
    ).replace(/\n {4}/g, "\n  ") + "\n",
  );

describe("#1 self_update 供應鏈驗證", () => {
  it("正確簽名 → 解析;篡改一個字節 → 拒絕;錯公鑰 → 拒絕", () => {
    const { privateKey, pubHex } = testKeys();
    const m = manifestOf("1.3.1", { "install.sh": createHash("sha256").update("x").digest("hex") });
    const sig = sign(null, m, privateKey).toString("base64");
    expect(verifyManifest(m, sig, pubHex).version).toBe("1.3.1");
    const tampered = Buffer.from(m);
    tampered[tampered.length - 3] ^= 1;
    expect(() => verifyManifest(tampered, sig, pubHex)).toThrow(/簽名/);
    const { pubHex: otherPub } = testKeys();
    expect(() => verifyManifest(m, sig, otherPub)).toThrow(/簽名/);
  });

  it("semverLt:降級判定正確(1.3.1<1.10.0;同版不算降級)", () => {
    expect(semverLt("1.2.9", "1.3.0")).toBe(true);
    expect(semverLt("1.3.1", "1.10.0")).toBe(true); // 數字段比,非字典序
    expect(semverLt("1.3.0", "1.3.0")).toBe(false);
    expect(semverLt("1.4.0", "1.3.0")).toBe(false);
  });

  it("只接受安全範圍內、無前導零的完整 X.Y.Z", () => {
    expect(parseStrictSemver("0.0.0")).toEqual([0, 0, 0]);
    expect(parseStrictSemver("1.10.999")).toEqual([1, 10, 999]);
    for (const bad of [
      "1.2",
      "1.2.3.4",
      "v1.2.3",
      "1.2.x",
      "1..3",
      "01.2.3",
      "-1.2.3",
      "1.2.9007199254740992",
    ]) {
      expect(() => parseStrictSemver(bad), bad).toThrow(/版本/);
    }
  });

  it("執行前要求 bootstrap v1 + sha256，並只放行嚴格升版", () => {
    const bridge = {
      version: "1.5.9",
      bootstrapVersion: 1,
      bootstrapSha256: "ab".repeat(32),
      files: {},
    };
    expect(() => assertSelfUpdateAllowed(bridge, "1.5.8")).not.toThrow();
    expect(() => assertSelfUpdateAllowed({ ...bridge, bootstrapVersion: 2 }, "1.5.8")).toThrow(/bootstrap/);
    expect(() => assertSelfUpdateAllowed({ ...bridge, bootstrapSha256: "ab" }, "1.5.8")).toThrow(/bootstrap/);
    expect(() => assertSelfUpdateAllowed({ version: "1.5.9", files: {} }, "1.5.8")).toThrow(/bootstrap/);
    expect(() => assertSelfUpdateAllowed({ ...bridge, version: "1.5.8" }, "1.5.8")).toThrow(/非升級/);
    expect(() => assertSelfUpdateAllowed({ ...bridge, version: "1.5.7" }, "1.5.8")).toThrow(/非升級/);
    expect(() => assertSelfUpdateAllowed({ ...bridge, version: "1.5" }, "1.4.9")).toThrow(/版本/);
    expect(() => assertSelfUpdateAllowed(bridge, "1.5")).toThrow(/版本/);
  });

  it("installer 子進程只繼承最小環境，清掉 trust/runtime 注入鉤子", () => {
    const env = buildInstallerEnv(
      {
        HOME: "/home/agent",
        PATH: "/usr/bin:/bin",
        HTTPS_PROXY: "https://proxy.example",
        LC_ALL: "C",
        MACCHIATO_HERMES_PROFILE: "coder",
        MACCHIATO_MANIFEST: "/tmp/fake",
        MACCHIATO_VERIFIED_ROOT: "/tmp/evil",
        MACCHIATO_BOOTSTRAP_TESTING: "1",
        MACCHIATO_BOOTSTRAP_TEST_PUBKEY_HEX: "attacker",
        BASH_ENV: "/tmp/bash-hook",
        LD_PRELOAD: "/tmp/preload.so",
        DYLD_INSERT_LIBRARIES: "/tmp/dylib",
        NODE_OPTIONS: "--require=/tmp/node-hook",
        PYTHONPATH: "/tmp/python-hook",
        TAR_OPTIONS: "--checkpoint-action=exec=sh",
        SECRET_CANARY: "must-not-leak",
      },
      "claude-code",
      "/private/update/release.json",
    );
    expect(env).toMatchObject({
      HOME: "/home/agent",
      PATH: "/usr/bin:/bin",
      HTTPS_PROXY: "https://proxy.example",
      LC_ALL: "C",
      MACCHIATO_HERMES_PROFILE: "coder",
      MACCHIATO_ONLY: "claude-code",
      MACCHIATO_MANIFEST: "/private/update/release.json",
    });
    for (const key of [
      "MACCHIATO_VERIFIED_ROOT",
      "MACCHIATO_BOOTSTRAP_TESTING",
      "MACCHIATO_BOOTSTRAP_TEST_PUBKEY_HEX",
      "BASH_ENV",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "TAR_OPTIONS",
      "SECRET_CANARY",
    ]) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it("結構壞的清單 → 拒絕", () => {
    const { privateKey, pubHex } = testKeys();
    const bad = Buffer.from(JSON.stringify({ nope: 1 }));
    const sig = sign(null, bad, privateKey).toString("base64");
    expect(() => verifyManifest(bad, sig, pubHex)).toThrow(/結構/);
  });

  it("签名正确也拒绝重复/未知字段、非法 digest 与签名尾随垃圾", () => {
    const { privateKey, pubHex } = testKeys();
    const digest = createHash("sha256").update("x").digest("hex");
    const valid = manifestOf("1.3.1", { "install.sh": digest });
    const validSig = sign(null, valid, privateKey).toString("base64");
    expect(() => verifyManifest(valid, `${validSig}x`, pubHex)).toThrow(/編碼/);
    for (const bytes of [
      Buffer.from(valid.toString("utf8").replace('{\n', '{\n  "version": "1.3.1",\n')),
      Buffer.from(valid.toString("utf8").replace('  "files":', '  "unknown": 1,\n  "files":')),
      manifestOf("1.3.1", { "install.sh": "AB".repeat(32) }),
    ]) {
      const sig = sign(null, bytes, privateKey).toString("base64");
      expect(() => verifyManifest(bytes, sig, pubHex)).toThrow(/結構/);
    }
  });
});
