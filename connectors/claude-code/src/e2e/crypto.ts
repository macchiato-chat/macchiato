/**
 * §19 per-session E2E 密碼原語（OpenClaw 連接器, Node 版）。
 *
 * 逐位對齊 docs/e2e.md §2 與 Python 連接器 services/hermes-connector/e2e_crypto.py、
 * iOS CryptoKit：**X25519 ECDH + HKDF-SHA256 + AES-256-GCM**。
 *
 * 格式（base64 為協議邊界）：
 *   wrapKey →  sealed = b64( e_pub[32] ‖ nonce[12] ‖ AES-256-GCM_ct(K_S, 含 16B tag) )
 *   encrypt →  blob   = b64( nonce[12] ‖ AES-256-GCM_ct )
 *   HKDF: info="macchiato-e2e-wrap-v1"、salt = e_pub‖recipient_pub、length=32；AES-GCM 無 aad。
 *
 * 由 test/e2e-crypto.test.ts 用 Python 連接器產出的固定向量驗逐位一致。
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const WRAP_INFO = Buffer.from("macchiato-e2e-wrap-v1");
// X25519 的固定 DER 前綴（OID 1.3.101.110）——用於 raw 32B ↔ KeyObject 互轉。
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // 公鑰 SPKI 前綴（12B）
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex"); // 私鑰 PKCS8 前綴（16B）

const b64e = (b: Buffer): string => b.toString("base64");
const b64d = (s: string): Buffer => Buffer.from(s, "base64");

function rawToPublic(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}
function rawToPrivate(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}
function publicRaw(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(SPKI_PREFIX.length);
}
function privateRaw(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "der", type: "pkcs8" })).subarray(PKCS8_PREFIX.length);
}
function hkdf(shared: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, salt, WRAP_INFO, 32));
}

/** 生成一把 AES-256 會話密鑰 K_S（32 bytes）。 */
export function newSessionKey(): Buffer {
  return randomBytes(32);
}

/** 把 K_S 用收件設備的 X25519 公鑰封裝（ECIES）。server 中轉但解不開。 */
export function wrapKey(kS: Buffer, recipientPubB64: string): string {
  const P = b64d(recipientPubB64);
  const eph = generateKeyPairSync("x25519");
  const ePub = publicRaw(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: rawToPublic(P) });
  const wk = hkdf(shared, Buffer.concat([ePub, P]));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wk, nonce);
  const ct = Buffer.concat([cipher.update(kS), cipher.final()]);
  return b64e(Buffer.concat([ePub, nonce, ct, cipher.getAuthTag()]));
}

/** 設備側用自己 X25519 私鑰解出 K_S。 */
export function unwrapKey(sealedB64: string, recipientPrivRaw: Buffer): Buffer {
  const blob = b64d(sealedB64);
  const ePub = blob.subarray(0, 32);
  const nonce = blob.subarray(32, 44);
  const ctTag = blob.subarray(44);
  const ct = ctTag.subarray(0, ctTag.length - 16);
  const tag = ctTag.subarray(ctTag.length - 16);
  const priv = rawToPrivate(recipientPrivRaw);
  const ownPub = publicRaw(createPublicKey(priv)); // 設備自己的公鑰（HKDF salt 用）
  const shared = diffieHellman({ privateKey: priv, publicKey: rawToPublic(ePub) });
  const wk = hkdf(shared, Buffer.concat([ePub, ownPub]));
  const dec = createDecipheriv("aes-256-gcm", wk, nonce);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

/** 用 K_S 加密內容（UTF-8 字符串）。 */
export function encrypt(kS: Buffer, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kS, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return b64e(Buffer.concat([nonce, ct, cipher.getAuthTag()]));
}

/** 用 K_S 解密內容。 */
export function decrypt(kS: Buffer, blobB64: string): string {
  const blob = b64d(blobB64);
  const nonce = blob.subarray(0, 12);
  const ctTag = blob.subarray(12);
  const ct = ctTag.subarray(0, ctTag.length - 16);
  const tag = ctTag.subarray(ctTag.length - 16);
  const dec = createDecipheriv("aes-256-gcm", kS, nonce);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
}

/** 測試用：生成 X25519 設備密鑰對（真設備在 iOS Secure Enclave 生成）。返回 raw priv + pub(base64)。 */
export function genDeviceKeypair(): { priv: Buffer; pubB64: string } {
  const kp = generateKeyPairSync("x25519");
  return { priv: privateRaw(kp.privateKey), pubB64: b64e(publicRaw(kp.publicKey)) };
}
