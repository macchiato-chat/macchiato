/**
 * #731 E2E 設備授權信任根（方案 A）。
 *
 * 配對時 connector 生成高熵 secret（server 只中轉配對碼、看不到 secret），經現有
 * 配對碼/QR 通道交給 iOS。enable/wrap 時設備用 HMAC 證明持有 secret + 該公鑰指紋；
 * connector 驗過才封 K_S。惡意 server 無法偽造未知 fingerprint 的 proof。
 *
 * 舊配對無 secret → 優雅降級（照舊 wrap + 警告日誌），不硬斷存量用戶。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** HMAC info / domain separation。 */
export const DEVICE_AUTH_MAC_INFO = "macchiato-e2e-device-auth-v1";
/** 配對碼與 secret 之間的分隔符：`{code}.{secretB64url}`。 */
export const PAIRING_TOKEN_SEP = ".";
/** secret 原始字節數（256-bit）。 */
export const DEVICE_AUTH_SECRET_BYTES = 32;

const SECRET_B64URL_RE = /^[A-Za-z0-9_-]{40,64}$/;
/** 顯示/掃碼用完整 token：12 位（或 8 位舊）配對碼 + secret。 */
const PAIRING_TOKEN_RE = /^(\d{8,12})\.([A-Za-z0-9_-]{40,64})$/;

/**
 * 🚨 **生成的 secret 一個數字都不許有**——這不是潔癖，是兼容性硬要求。
 *
 * App Store 在架的老 iOS（≤1.8.0）配對輸入框是 `v.filter(\.isNumber)`：用戶粘貼完整
 * token `123456789012.<secret>` 時，它會把 **secret 裡的數字一起拼進配對碼** → 配對直接
 * 失敗，且錯得毫無提示。老包不可回滾、也不知道 `.` 的存在，只能由**我們這側**讓它繼續成立：
 * secret 不含數字 ⇒ 老 iOS 濾出來的正好就是純數字配對碼 ⇒ 手輸/粘貼照常工作
 * （掃碼老包本來就 OK：它的 `\b\d{8,12}\b` 在 `.` 處有詞邊界）。
 *
 * 實現上仍是**規範 base64url 字符串、解碼後恰好 32 字節**——HMAC 密鑰推導、三端 known-answer
 * 向量、`isCanonicalDeviceAuthSecret` 全部不變，只是把字母表縮到 base64url 的無數字子集。
 * 熵：42×log2(54) + log2(13) ≈ **245 bit**（遠超需要的 128）。
 *
 * 解析側**照舊接受含數字的 secret**（本機早期配對可能已落盤過），只約束生成。
 */
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** base64url 字母表裡不含數字的 54 個符號。 */
const DIGIT_FREE_B64URL = B64URL_ALPHABET.replace(/[0-9]/g, "");
/**
 * 43 字符的 base64url 恰好編碼 32 字節（256 bit），末位只用到高 4 bit——低 2 bit 必須為 0
 * 才是**規範**編碼（否則 `Buffer.from(s).toString("base64url") !== s`，跨端嚴格解碼會分歧）。
 * 故末位從「6-bit 值 ≡ 0 (mod 4)」的字符裡取，且同樣不含數字。
 */
const DIGIT_FREE_B64URL_TAIL = [...DIGIT_FREE_B64URL].filter(
  (c) => B64URL_ALPHABET.indexOf(c) % 4 === 0,
).join("");
/** 32 字節 → 43 個 base64url 字符。 */
const SECRET_CHARS = Math.ceil((DEVICE_AUTH_SECRET_BYTES * 8) / 6);

/** 從字母表裡均勻取一個字符（拒絕採樣，避免 `% n` 的模偏差）。 */
function pickChar(alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  for (;;) {
    const b = randomBytes(1)[0]!;
    if (b < limit) return alphabet[b % alphabet.length]!;
  }
}

export function generateDeviceAuthSecret(): string {
  let out = "";
  for (let i = 0; i < SECRET_CHARS - 1; i += 1) out += pickChar(DIGIT_FREE_B64URL);
  return out + pickChar(DIGIT_FREE_B64URL_TAIL);
}

/** 把 server 配對碼與 connector 本地 secret 合成用戶可見/可掃的 token。 */
export function formatPairingToken(code: string, secret: string): string {
  if (!/^\d{8,12}$/.test(code)) {
    throw new Error("pairing code must be 8–12 digits");
  }
  if (!SECRET_B64URL_RE.test(secret)) {
    throw new Error("device auth secret is not canonical base64url");
  }
  return `${code}${PAIRING_TOKEN_SEP}${secret}`;
}

export interface ParsedPairingToken {
  /** 交給 server claim 的數字碼。 */
  code: string;
  /** 僅設備持有；缺省 = 舊碼/無設備授權。 */
  e2eAuth?: string;
}

/**
 * 解析掃碼/手輸內容：完整 token、JSON `{code,e2eAuth}`、或裸數字碼。
 * 裸碼不帶 secret（舊連接器 / 僅 web 配對）。
 */
export function parsePairingToken(raw: string): ParsedPairingToken | null {
  const text = raw.trim();
  if (!text) return null;

  // JSON 載荷（PairingQrPayload 擴展）。
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text) as { code?: unknown; e2eAuth?: unknown };
      if (typeof obj.code === "string" && /^\d{8,12}$/.test(obj.code)) {
        const e2eAuth =
          typeof obj.e2eAuth === "string" && SECRET_B64URL_RE.test(obj.e2eAuth)
            ? obj.e2eAuth
            : undefined;
        return { code: obj.code, e2eAuth };
      }
    } catch {
      /* fall through */
    }
  }

  const token = text.match(PAIRING_TOKEN_RE);
  if (token) return { code: token[1]!, e2eAuth: token[2]! };

  const bare = text.match(/\b(\d{8,12})\b/);
  if (bare) return { code: bare[1]! };

  return null;
}

function macInput(agentLinkId: string, deviceId: string, keyFingerprint: string): Buffer {
  // 固定域分隔，避免字段粘連歧義。
  return Buffer.from(
    `${DEVICE_AUTH_MAC_INFO}\0${agentLinkId}\0${deviceId}\0${keyFingerprint}`,
    "utf8",
  );
}

/** 設備側：持 secret 對 (agentLink, device, fingerprint) 簽 proof。 */
export function makeDeviceAuthProof(
  secretB64url: string,
  agentLinkId: string,
  deviceId: string,
  keyFingerprint: string,
): string {
  if (!SECRET_B64URL_RE.test(secretB64url)) {
    throw new Error("device auth secret is not canonical base64url");
  }
  if (!agentLinkId || !deviceId || !keyFingerprint) {
    throw new Error("device auth proof fields must be non-empty");
  }
  const key = Buffer.from(secretB64url, "base64url");
  if (key.length !== DEVICE_AUTH_SECRET_BYTES) {
    throw new Error("device auth secret must decode to 32 bytes");
  }
  return createHmac("sha256", key)
    .update(macInput(agentLinkId, deviceId, keyFingerprint))
    .digest("base64url");
}

/** 連接器側：驗 proof；長度不一致時也走 constant-time 失敗路徑。 */
export function verifyDeviceAuthProof(
  secretB64url: string,
  agentLinkId: string,
  deviceId: string,
  keyFingerprint: string,
  proofB64url: string | undefined | null,
): boolean {
  if (!proofB64url || typeof proofB64url !== "string") return false;
  let expected: string;
  try {
    expected = makeDeviceAuthProof(secretB64url, agentLinkId, deviceId, keyFingerprint);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(proofB64url, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function isCanonicalDeviceAuthSecret(value: unknown): value is string {
  if (typeof value !== "string" || !SECRET_B64URL_RE.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").length === DEVICE_AUTH_SECRET_BYTES;
  } catch {
    return false;
  }
}

/** 注入 E2EKeyStore.configureDeviceAuth 的配置（與 keys.ts 同形）。 */
export interface DeviceAuthConfig {
  secret: string;
  agentLinkId: string;
  authorizedDevices?: Record<string, string>;
  persistAuthorized?: (authorized: Record<string, string>) => void;
}

/** 從配對憑證拼出 configureDeviceAuth 參數；無 secret → null（降級）。 */
export function deviceAuthConfigFromCreds(creds: {
  agentLinkId: string;
  deviceAuthSecret?: string;
  authorizedDevices?: Record<string, string>;
  /** 持久化授權表時寫回（通常 saveCreds）。 */
  persist?: (authorized: Record<string, string>) => void;
}): DeviceAuthConfig | null {
  if (!isCanonicalDeviceAuthSecret(creds.deviceAuthSecret)) return null;
  return {
    secret: creds.deviceAuthSecret,
    agentLinkId: creds.agentLinkId,
    authorizedDevices: creds.authorizedDevices,
    persistAuthorized: creds.persist,
  };
}
