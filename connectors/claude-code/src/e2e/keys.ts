/**
 * §19 per-session E2E 密鑰管理（OpenClaw 連接器側, 對應 Python e2e_keys.py）。
 * K_S 存 ~/.macchiato/claude-code-e2e.json（0600, 原子寫；與 Hermes 的 e2e.json 分開）。
 * **某 hermesSessionId 在 store 里 = 該會話已開 E2E。** 鍵 = server 的 hermesSessionId（原始大小寫）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as ec from "./crypto";

export function e2eStorePath(): string {
  return process.env.MACCHIATO_CLAUDE_CODE_E2E_STORE || join(homedir(), ".macchiato/claude-code-e2e.json");
}

export interface DevicePub {
  deviceId: string;
  pubKey: string;
}

export class E2EKeyStore {
  private keys = new Map<string, Buffer>(); // hermesSessionId → K_S(32B)

  constructor(private readonly path: string = e2eStorePath()) {
    this.load();
  }

  private load(): void {
    try {
      const d = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
      this.keys = new Map(Object.entries(d).map(([sid, b64]) => [sid, Buffer.from(b64, "base64")]));
    } catch {
      this.keys = new Map();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries([...this.keys].map(([sid, k]) => [sid, k.toString("base64")]))));
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path); // 原子替換
  }

  isE2E(sid: string): boolean {
    return this.keys.has(sid);
  }

  /** 關閉 E2E：刪該會話 K_S（會話回明文路徑；server 側密封包由 server 清）。無則 no-op。 */
  remove(sid: string): void {
    if (this.keys.delete(sid)) this.save();
  }

  /** 返回該會話 K_S；首次（開啟 E2E）即生成並持久化。 */
  getOrCreateKey(sid: string): Buffer {
    let k = this.keys.get(sid);
    if (!k) {
      k = ec.newSessionKey();
      this.keys.set(sid, k);
      this.save();
    }
    return k;
  }

  /** 把 K_S 封裝給每台設備公鑰 → [{deviceId, sealed}]。壞公鑰跳過。 */
  wrapForDevices(sid: string, devices: DevicePub[]): { deviceId: string; sealed: string }[] {
    const k = this.getOrCreateKey(sid);
    const out: { deviceId: string; sealed: string }[] = [];
    for (const d of devices ?? []) {
      if (!d?.deviceId || !d?.pubKey) continue;
      try {
        out.push({ deviceId: d.deviceId, sealed: ec.wrapKey(k, d.pubKey) });
      } catch {
        /* 公鑰格式壞 → 跳過該設備 */
      }
    }
    return out;
  }

  /** 內容對象（{text,reasoning,tools}）→ 密文塊。 */
  encryptContent(sid: string, obj: unknown): string {
    return ec.encrypt(this.getOrCreateKey(sid), JSON.stringify(obj));
  }

  decryptContent(sid: string, blobB64: string): unknown {
    const k = this.keys.get(sid);
    if (!k) throw new Error(`no E2E key for session ${sid}`);
    return JSON.parse(ec.decrypt(k, blobB64));
  }

  encryptText(sid: string, text: string): string {
    return ec.encrypt(this.getOrCreateKey(sid), text);
  }

  decryptText(sid: string, blobB64: string): string {
    const k = this.keys.get(sid);
    if (!k) throw new Error(`no E2E key for session ${sid}`);
    return ec.decrypt(k, blobB64);
  }
}
