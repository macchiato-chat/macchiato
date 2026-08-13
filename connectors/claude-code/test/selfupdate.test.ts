import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSelfUpdateHandoff,
  assertSelfUpdateAllowed,
  buildInstallerEnv,
  handleInstallerExit,
  isSelfUpdateHandedOff,
  parseStrictSemver,
  resetSelfUpdateState,
  runVerifiedSelfUpdate,
  selfUpdateFailureNotice,
  selfUpdatePendingRestartNotice,
  semverLt,
  verifyManifest,
} from "../src/_core/selfupdate";

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
        // #767 外部托管：漏了它 self_update 拉起的 installer 就会去装 user unit，
        // 更新写进磁盘、真正在跑的进程纹丝不动，用户点 Update 永远失败。
        MACCHIATO_SKIP_UNIT: "1",
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
      "connector-core",
      "/private/update/release.json",
    );
    expect(env).toMatchObject({
      HOME: "/home/agent",
      PATH: "/usr/bin:/bin",
      HTTPS_PROXY: "https://proxy.example",
      LC_ALL: "C",
      MACCHIATO_HERMES_PROFILE: "coder",
      MACCHIATO_SKIP_UNIT: "1",
      MACCHIATO_ONLY: "connector-core",
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

/**
 * #773 生產真機:installer 裝成功、退出 0,而真正在跑的進程沒被替換(system unit 托管 /
 * MACCHIATO_SKIP_UNIT / 手動跑)——交棒閂只在退出非 0 時才清,於是永久置位,之後每次點
 * 「更新」都只打印 `[self_update ignored]`,連下載都不做,用戶永遠爬不出來。
 */
describe("#773 裝完沒重啟:更新閂不許永久鎖死", () => {
  beforeEach(() => resetSelfUpdateState());

  it("installer 退非 0(裝失敗)→ 立刻放閂 + 掛失敗原因,且不掛「等重啟」通知", () => {
    expect(acquireSelfUpdateHandoff()).toBe(true); // 正控:閂真的被拿住了
    expect(acquireSelfUpdateHandoff()).toBe(false); // 正控:守衛真的在擋
    handleInstallerExit(1, "1.5.70", 10_000);
    expect(isSelfUpdateHandedOff()).toBe(false);
    expect(selfUpdatePendingRestartNotice()).toBeNull();
    expect(selfUpdateFailureNotice()).toMatch(/安裝失敗|退出碼/);
    expect(acquireSelfUpdateHandoff()).toBe(true); // 下一次更新能真的再裝
  });

  it("installer 退 0 且本進程活過寬限期 → 放閂 + 一句「已下載,重啟後生效」(絕不是失敗)", async () => {
    expect(acquireSelfUpdateHandoff()).toBe(true);
    handleInstallerExit(0, "1.5.70", 20);
    // 到點之前不許放閂:真重啟正在進行時放閂 = 同時跑兩個 installer,比本 bug 更糟。
    expect(isSelfUpdateHandedOff()).toBe(true);
    // #791:裝成功當下就掛「等待重啟」,client 不必乾等到 grace。
    expect(selfUpdatePendingRestartNotice()).toMatch(/1\.5\.70/);
    expect(selfUpdatePendingRestartNotice()).toMatch(/等待|重啟|重启/);
    expect(selfUpdatePendingRestartNotice()).not.toMatch(/失敗|失败|fail/i);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(isSelfUpdateHandedOff()).toBe(false);
    const notice = selfUpdatePendingRestartNotice();
    expect(notice).toContain("1.5.70"); // 裝的是哪版,話裡帶着
    expect(notice).toMatch(/重啟/); // 給下一步,不是死胡同
    expect(notice).toMatch(/生效/); // grace 後終態
    expect(notice).not.toMatch(/失敗|失败|fail/i); // 🚨 手動跑不重啟是正常的,說成失敗就是撒謊
  });

  it("寬限期內再來一次 self_update 仍被拒(防並發安裝這條不許被本次改動破壞)", async () => {
    expect(acquireSelfUpdateHandoff()).toBe(true);
    handleInstallerExit(0, "1.5.70", 10_000); // 整個用例都落在計時期內
    await expect(runVerifiedSelfUpdate("connector-core", "1.0.0")).rejects.toThrow(
      /已在本进程启动/,
    );
    expect(isSelfUpdateHandedOff()).toBe(true);
  });
});

/**
 * #888 **installer 的退出碼不是憑據,磁盤才是。**
 *
 * 實踩:install.sh 的信任橋在 macOS 的 /bin/bash 3.2 上因空數組展開半路死掉,而它的
 * EXIT trap 把退出碼洗成 0。於是「退 0 ＝ 裝好了」整整三週都在說謊——五台 Mac 卡在
 * 1.5.69,app 卻顯示「更新已安裝，等待重啟」,重啟毫無作用;而那條假 mark 文件一旦寫下
 * 就**永不失效**(readDiskConnectorVersion 優先讀它),用戶只能手工刪文件才能脫困。
 */
describe("#888 退 0 但安裝樹沒動 = 失敗,而且絕不留下假標記", () => {
  const KIND = "codex";
  let stateDir: string;
  let appRoot: string;

  /** 寫一棵最小安裝樹(佈局同 install.sh:`<root>/src/linkb/proto.ts`)。 */
  const writeAppTree = (version: string) => {
    mkdirSync(join(appRoot, "src", "linkb"), { recursive: true });
    writeFileSync(
      join(appRoot, "src", "linkb", "proto.ts"),
      `export const CONNECTOR_VERSION = "${version}";\n`,
    );
  };
  const markPath = () => join(stateDir, `installed-version-${KIND}`);

  beforeEach(() => {
    resetSelfUpdateState();
    stateDir = mkdtempSync(join(tmpdir(), "selfupdate-state-"));
    appRoot = mkdtempSync(join(tmpdir(), "selfupdate-tree-"));
    // installedVersionMarkPath() 落在 stateDir() 下;隔離到臨時目錄,別碰開發機真狀態。
    process.env.MACCHIATO_STATE_DIR = stateDir;
  });
  afterEach(() => {
    delete process.env.MACCHIATO_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(appRoot, { recursive: true, force: true });
  });

  it("退 0 但樹還是舊版 → 當失敗:放閂 + 人話原因 + 不寫 mark(不留永久假「等重啟」)", () => {
    writeAppTree("1.5.69"); // installer 一個文件都沒換
    expect(acquireSelfUpdateHandoff()).toBe(true);
    handleInstallerExit(0, "1.5.72", 10_000, KIND, appRoot);

    // 說人話,且帶上兩個版本——用戶/我們都能一眼看出「沒裝上」而不是「等重啟」。
    // ⚠️ 先讀再重試:acquireSelfUpdateHandoff() 會清掉上一輪的失敗文案(新一輪開始)。
    const failure = selfUpdateFailureNotice();
    expect(failure).toMatch(/沒有真正安裝|没有真正安装/);
    expect(failure).toContain("1.5.69");
    expect(failure).toContain("1.5.72");
    // 🚨 絕不能同時掛「等重啟」——那正是 app 上那句永久假話。
    expect(selfUpdatePendingRestartNotice()).toBeNull();
    // 🚨 更關鍵:mark 文件永不失效,寫錯一次就要用戶手工刪文件才能脫困。
    expect(existsSync(markPath())).toBe(false);
    // 放閂:用戶點「重試」必須能真的再裝一次(1.5.69 上正是這裡永久鎖死的)。
    expect(isSelfUpdateHandedOff()).toBe(false);
    expect(acquireSelfUpdateHandoff()).toBe(true);
  });

  it("退 0 且樹真的換代了 → 照舊走「等重啟」並寫 mark(#768/#773 行為不許被本次改動破壞)", () => {
    writeAppTree("1.5.72");
    expect(acquireSelfUpdateHandoff()).toBe(true);
    handleInstallerExit(0, "1.5.72", 10_000, KIND, appRoot);

    expect(selfUpdateFailureNotice()).toBeNull();
    expect(selfUpdatePendingRestartNotice()).toMatch(/1\.5\.72/);
    expect(existsSync(markPath())).toBe(true);
    expect(readFileSync(markPath(), "utf8").trim()).toBe("1.5.72");
    expect(isSelfUpdateHandedOff()).toBe(true); // 等重啟期間仍不許放閂
  });

  it("讀不到安裝樹(開發 monorepo / 非標準佈局)→ 不判失敗,但也不寫 mark(拿不準時不留卡死狀態)", () => {
    // 不寫任何 proto.ts:readAppTreeConnectorVersion 回 null。
    expect(acquireSelfUpdateHandoff()).toBe(true);
    handleInstallerExit(0, "1.5.72", 10_000, KIND, appRoot);

    expect(selfUpdateFailureNotice()).toBeNull();
    expect(selfUpdatePendingRestartNotice()).toMatch(/1\.5\.72/); // #773/#791 既有行為
    expect(existsSync(markPath())).toBe(false); // 唯一會卡死的副作用,不知道就不留
  });
});
