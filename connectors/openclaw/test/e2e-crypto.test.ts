import { describe, it, expect } from "vitest";
import * as ec from "../src/e2e/crypto";

/**
 * 跨平台向量：由 **Python 連接器** services/hermes-connector/e2e_crypto.py 產出。
 * 前兩個用例證明 Node 加解密與 Python（及已對齊 Python 的 iOS）**逐位一致**——
 * 這是整個多端 E2E 的關鍵：連接器換語言重寫，密文格式不能漂。
 * 重新生成：見 services/hermes-connector/e2e_crypto.py 的 encrypt/wrap_key。
 */
const V = {
  kS: "+/7ttH+WBvFW6Y79lF862W+nfBvL0wBeCxDmGF1yg8c=",
  plaintext: "macchiato↔openclaw E2E 向量 🔒 test",
  ciphertext:
    "AinXp2nAqBpTQYGgSF6UaejYmCqpAsN+LuyxShWUzwQBAU9bywQu6gY4oXGPxI3vH2dZ0FK3b86omgVnIyJ2B3OSbVru",
  devicePriv: "mFWJ6IB2U56W2vK3c8wCfkAV7GKRn1K9ChSDov0REVQ=",
  devicePub: "/omrCMpzdu6yv9ZnQz1EXEhJauACeRONVlICABCRfiU=",
  sealed:
    "REHUYjFCtdopDCMaIT9hVWSOrJVCdk5/VeZDFYj/BwNTgwTN67t058uHj6pkGaCAFK58qiPvC1lRWmlVae9rwdtpy2r+3nP+9kIM9kEDGJ75mIgBORwEL6+hxOo=",
};
const b64 = (s: string): Buffer => Buffer.from(s, "base64");

describe("e2e crypto — Node ↔ Python/iOS 逐位一致（跨平台向量）", () => {
  it("解出 Python 產的密文（內容 AES-GCM 格式一致）", () => {
    expect(ec.decrypt(b64(V.kS), V.ciphertext)).toBe(V.plaintext);
  });

  it("解封 Python 產的 sealed K_S（ECIES/wrap 格式一致）", () => {
    expect(ec.unwrapKey(V.sealed, b64(V.devicePriv)).toString("base64")).toBe(V.kS);
  });
});

describe("e2e crypto — 自洽往返 / 安全性", () => {
  it("內容往返", () => {
    const k = ec.newSessionKey();
    expect(k.length).toBe(32);
    const blob = ec.encrypt(k, "祕密回覆 🔒 multi-語");
    expect(b64(blob).toString("latin1")).not.toContain("祕密"); // 密文不含明文
    expect(ec.decrypt(k, blob)).toBe("祕密回覆 🔒 multi-語");
  });

  it("封裝給設備 → 解封還原同一把 K_S", () => {
    const k = ec.newSessionKey();
    const { priv, pubB64 } = ec.genDeviceKeypair();
    expect(ec.unwrapKey(ec.wrapKey(k, pubB64), priv).equals(k)).toBe(true);
  });

  it("多設備：同一把 K_S 封給兩台，各自解出同一把", () => {
    const k = ec.newSessionKey();
    const a = ec.genDeviceKeypair();
    const b = ec.genDeviceKeypair();
    expect(ec.unwrapKey(ec.wrapKey(k, a.pubB64), a.priv).equals(k)).toBe(true);
    expect(ec.unwrapKey(ec.wrapKey(k, b.pubB64), b.priv).equals(k)).toBe(true);
  });

  it("錯設備解不開", () => {
    const k = ec.newSessionKey();
    const a = ec.genDeviceKeypair();
    const b = ec.genDeviceKeypair();
    const sealed = ec.wrapKey(k, a.pubB64);
    expect(() => ec.unwrapKey(sealed, b.priv)).toThrow();
  });

  it("錯 K_S 解不開內容", () => {
    const blob = ec.encrypt(ec.newSessionKey(), "secret");
    expect(() => ec.decrypt(ec.newSessionKey(), blob)).toThrow();
  });

  it("隨機性：每次密文不同但都能解", () => {
    const k = ec.newSessionKey();
    const b1 = ec.encrypt(k, "x");
    const b2 = ec.encrypt(k, "x");
    expect(b1).not.toBe(b2);
    expect(ec.decrypt(k, b1)).toBe("x");
    expect(ec.decrypt(k, b2)).toBe("x");
  });

  it("格式長度：sealed = e_pub32 ‖ nonce12 ‖ ct32 ‖ tag16", () => {
    const k = ec.newSessionKey();
    const { pubB64 } = ec.genDeviceKeypair();
    expect(b64(ec.wrapKey(k, pubB64)).length).toBe(32 + 12 + 32 + 16);
  });
});
