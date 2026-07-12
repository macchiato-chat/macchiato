import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { semverLt, verifyManifest } from "../src/selfupdate";

/** 一次性測試密鑰對(與生產公鑰無關)。 */
function testKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKey, pubHex: raw.toString("hex") };
}
const manifestOf = (version: string, files: Record<string, string>) =>
  Buffer.from(JSON.stringify({ version, files }, null, 2) + "\n");

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

  it("結構壞的清單 → 拒絕", () => {
    const { privateKey, pubHex } = testKeys();
    const bad = Buffer.from(JSON.stringify({ nope: 1 }));
    const sig = sign(null, bad, privateKey).toString("base64");
    expect(() => verifyManifest(bad, sig, pubHex)).toThrow(/結構/);
  });
});
