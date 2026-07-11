/**
 * #74 E2E 路徑運行時驗證:模擬 iOS 設備(真 X25519 密鑰對),走連接器完整 E2E 鏈路,驗證
 * 設備能用 K_S 解出明文。之前 E2E 只有 crypto 單測,這裡驗**連接器編排**(wrap→鏡像加密→
 * 驅動加密回合→D2 回灌 enable/disable)端到端對得上。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EKeyStore } from "../src/e2e/keys";
import { decrypt, genDeviceKeypair, unwrapKey } from "../src/e2e/crypto";

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function freshStore(): E2EKeyStore {
  return new E2EKeyStore(join(mkdtempSync(join(tmpdir(), "cc-e2e-")), "e2e.json"));
}

/** 模擬設備:拿到 sealed K_S → 解封 → 用 K_S 解 blob。 */
function device() {
  const kp = genDeviceKeypair();
  return {
    deviceId: "dev-1",
    pubKey: kp.pubB64,
    open: (sealed: string, blob: string) => decrypt(unwrapKey(sealed, kp.priv), blob),
  };
}

describe("#74 E2E 連接器編排端到端", () => {
  it("wrap → 設備解封 K_S → 解 encryptContent/encryptText 明文一致", () => {
    const e2e = freshStore();
    const dev = device();
    const [w] = e2e.wrapForDevices(SID, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    expect(w).toBeTruthy();
    // 內容塊
    const enc = e2e.encryptContent(SID, { text: "secret hi", reasoning: "think", tools: [] });
    expect(JSON.parse(dev.open(w!.sealed, enc))).toMatchObject({ text: "secret hi", reasoning: "think" });
    // 標題
    const encT = e2e.encryptText(SID, "私密標題");
    expect(dev.open(w!.sealed, encT)).toBe("私密標題");
    expect(e2e.isE2E(SID)).toBe(true);
  });

  it("鏡像加密批(Mirror.entry E2E 分支):title+每條 enc 設備可解,srcId 明文保留", async () => {
    const e2e = freshStore();
    const dev = device();
    const [w] = e2e.wrapForDevices(SID, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    // 直接調 Mirror 的私有 entry(E2E 分支)
    const { Mirror } = await import("../src/cc/mirror");
    const m = new Mirror({ agentLinkId: "AL", isReady: true, send: () => {}, onFrame: () => () => {} } as any, e2e);
    const entry = (m as any).entry(SID, "T", [
      { role: "user", text: "u-msg", srcId: "s1", createdAt: 1 },
      { role: "agent", text: "a-msg", reasoning: "r", srcId: "s2", createdAt: 2 },
    ]);
    expect(entry.e2e).toBe(true);
    expect(dev.open(w!.sealed, entry.title)).toBe("T");
    expect(entry.messages[0].srcId).toBe("s1"); // srcId 是元數據,明文保留(去重用)
    expect(JSON.parse(dev.open(w!.sealed, entry.messages[0].enc))).toMatchObject({ text: "u-msg" });
    expect(JSON.parse(dev.open(w!.sealed, entry.messages[1].enc))).toMatchObject({ text: "a-msg", reasoning: "r" });
    // enc 存在時不應洩漏明文 text 字段
    expect(entry.messages[0].text).toBeUndefined();
  });

  it("D2 回灌 enable:全歷史重加密設備可解;disable:回明文 + 刪 K_S", async () => {
    const e2e = freshStore();
    const dev = device();
    e2e.wrapForDevices(SID, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    const [w] = e2e.wrapForDevices(SID, [{ deviceId: dev.deviceId, pubKey: dev.pubKey }]);
    // 造一個 transcript 讓 backfillE2E 讀
    const cfg = mkdtempSync(join(tmpdir(), "cc-e2e-cfg-"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(cfg, "projects", "-x"), { recursive: true });
    const f = join(cfg, "projects", "-x", `${SID}.jsonl`);
    writeFileSync(
      f,
      JSON.stringify({ type: "user", uuid: "u1", sessionId: SID, timestamp: "2026-07-06T00:00:00Z", message: { role: "user", content: "hist question" } }) +
        "\n" +
        JSON.stringify({ type: "assistant", uuid: "a1", sessionId: SID, timestamp: "2026-07-06T00:00:01Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hist answer" }] } }) +
        "\n",
    );
    const { Mirror } = await import("../src/cc/mirror");
    const sent: any[] = [];
    const m = new Mirror({ agentLinkId: "AL", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any, e2e);

    await m.backfillE2E(SID, "enable");
    const enBatch = sent.at(-1);
    expect(enBatch.t).toBe("e2e_backfill");
    expect(enBatch.found).toBe(true);
    expect(enBatch.mode).toBe("enable");
    // 設備解回灌內容
    const decoded = enBatch.messages.map((x: any) => JSON.parse(dev.open(w!.sealed, x.enc)));
    expect(decoded.map((d: any) => d.text)).toEqual(["hist question", "hist answer"]);

    await m.backfillE2E(SID, "disable");
    const disBatch = sent.at(-1);
    expect(disBatch.mode).toBe("disable");
    expect(disBatch.messages[0].text).toBe("hist question"); // 明文回灌
    expect(disBatch.messages[0].enc).toBeUndefined();
    expect(e2e.isE2E(SID)).toBe(false); // K_S 已刪
  });

  it("found:false — 無此會話 transcript 時回灌不編造內容", async () => {
    const e2e = freshStore();
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cc-e2e-empty-"));
    const { Mirror } = await import("../src/cc/mirror");
    const sent: any[] = [];
    const m = new Mirror({ agentLinkId: "AL", isReady: true, send: (x: any) => sent.push(x), onFrame: () => () => {} } as any, e2e);
    await m.backfillE2E("no-such-sid", "enable");
    expect(sent.at(-1)).toMatchObject({ t: "e2e_backfill", found: false });
  });
});
