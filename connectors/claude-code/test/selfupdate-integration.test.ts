/**
 * #540 檔 1:`runVerifiedSelfUpdate` 的集成層——把「下載 → 驗簽 → 版本閘 → install.sh
 * sha256 校驗 → 交棒」整條鏈真的跑一遍。此前只有純函數層單測(selfupdate.test.ts),
 * 每一環單獨對,但**串起來**的順序、fail-closed 位置、以及「拒絕時到底走沒走到下一環」
 * 從未被斷言過——而自更新壞掉的代價是老版本用戶再也更新不上來(#536/#538 的姊妹缺口)。
 *
 * 三個「看起來繞遠、實際是硬約束」的設計:
 *
 * 1. **必須真起本地 HTTPS**:`fetchBytes` 硬拒非 https(selfupdate.ts:182),http 服務器
 *    連第一步都到不了。自簽證書的信任只能靠 `NODE_EXTRA_CA_CERTS`。
 *
 * 2. **測試主體必須在子進程裡**:`RAW_BASE` 是模塊加載時求值的 const(selfupdate.ts:18),
 *    `NODE_EXTRA_CA_CERTS` 更是進程啟動時才讀——兩者都不可能在 vitest 進程內事後改。
 *    故每個場景 spawn 一個 tsx 子進程(帶 `MACCHIATO_RELEASE_BASE` + `NODE_EXTRA_CA_CERTS`),
 *    在子進程裡 import 並調用,結果以 JSON 打回 stdout。副作用是每個場景拿到乾淨的
 *    `selfUpdateHandedOff` 閂,互不污染。
 *
 * 3. **絕不能讓 install.sh 真的執行**:真跑會把連接器裝到跑測試的機器上。做法是本地
 *    server 對 `/install.sh` 返回一段**與清單 sha256 對不上**的無害佔位內容——正路徑
 *    因此恰好停在鏈條的最後一關(哈希),既證明前面全過,又永遠到不了 spawn。
 *    「真的沒交棒」不靠推理:每個場景都斷言 TMPDIR 下沒有 `macchiato-update-*`
 *    臨時目錄(那是 spawn 前一步才創建的,見 selfupdate.ts:227)。
 *
 * 清單只能用**真實已發布**的那一份:公鑰 `RELEASE_PUBKEY_HEX` 硬編碼、不可注入,
 * 自己造的簽名一律驗不過。fixtures/release.json{,.sig} 取自公開 repo main
 * (v1.5.58),不進簽名 artifact(sign-manifest 只收 src、package.json、lockfile、tsconfig)。
 * ⚠️ 維護:fixture **不隨版本 bump 過期**(斷言全用相對版本,不寫死 1.5.58);但
 * 公鑰輪換後這份簽名就驗不過了——屆時重新抓一份公開 repo 的 release.json{,.sig} 即可,
 * 下面第一條「fixture 對得上硬編碼公鑰」就是專門讓那天的失敗一眼看懂的。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:https";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyManifest } from "../src/_core/selfupdate";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const REAL_MANIFEST = readFileSync(join(FIXTURES, "release.json"));
const REAL_SIG = readFileSync(join(FIXTURES, "release.json.sig"));
const FIXTURE_VERSION: string = JSON.parse(REAL_MANIFEST.toString("utf8")).version;

/** 故意與清單 sha256 對不上;即便某天真被執行也什麼都不做。 */
const DECOY_INSTALL_SH = Buffer.from(
  "#!/usr/bin/env bash\n# #540 測試佔位:內容與清單哈希不符,自更新必須在此中止。\nexit 90\n",
);

const TSX = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
// #572 起實現搬到 packages/connector-core;子進程用 tsx 直接按文件 URL 加載(該模塊只依賴
// node 內建,不需要走包解析),故這裡指真實文件而非 "../src/_core/selfupdate"。
const SELFUPDATE_MODULE = new URL(
  "../src/_core/selfupdate.ts",
  import.meta.url,
).href;

/** 自簽 localhost 證書(抄 scripts/release/bootstrap-e2e.mjs 的已驗證寫法)。 */
function makeCertificate(work: string) {
  const config = join(work, "openssl.cnf");
  const key = join(work, "tls.key");
  const cert = join(work, "tls.crt");
  writeFileSync(
    config,
    `[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = localhost
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
`,
  );
  const result = spawnSync(
    "openssl",
    [
      "req", "-x509", "-nodes", "-newkey", "rsa:2048",
      "-keyout", key, "-out", cert, "-days", "1",
      "-config", config, "-extensions", "v3_req",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`openssl 測試證書生成失敗:\n${result.stderr}`);
  return { key, cert };
}

/** 本輪要餵給連接器的字節;每個場景按需改。 */
type ServePlan = {
  manifest: Buffer;
  sig: Buffer;
  installSh: Buffer;
  /** 這些路徑改回 302(驗 `redirect: "error"`)。 */
  redirect: Set<string>;
};

let server: Server;
let port = 0;
let base = "";
let work = "";
let certPath = "";
let hits: string[] = [];
let plan: ServePlan;

const freshPlan = (): ServePlan => ({
  manifest: REAL_MANIFEST,
  sig: REAL_SIG,
  installSh: DECOY_INSTALL_SH,
  redirect: new Set(),
});

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "selfupdate-it-"));
  const { key, cert } = makeCertificate(work);
  certPath = cert;
  plan = freshPlan();
  server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (request, response) => {
      const path = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
      hits.push(path);
      if (plan.redirect.has(path)) {
        // 供應鏈場景:CDN/repo 被改成 302 指向攻擊者主機。fetchBytes 用 redirect:"error"。
        response.writeHead(302, { Location: "https://evil.example/release.json" });
        response.end();
        return;
      }
      const body: Buffer | undefined = {
        "/release.json": plan.manifest,
        "/release.json.sig": plan.sig,
        "/install.sh": plan.installSh,
      }[path];
      if (!body) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
      });
      response.end(body);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      base = `https://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Attempt = { ok: boolean; message?: string };

/**
 * 在子進程裡跑 `runVerifiedSelfUpdate`,回傳每次調用的結果。
 * 每次調用前重置本輪要餵的字節與命中記錄;`times > 1` 用來驗「失敗後閂會鬆開、可安全重試」。
 */
async function runSelfUpdate(options: {
  currentVersion: string;
  releaseBase?: string;
  times?: number;
  /** 在起子進程前改本輪要餵的字節(篡改/轉向場景)。 */
  serve?: (plan: ServePlan) => void;
}): Promise<Attempt[]> {
  hits = [];
  plan = freshPlan();
  options.serve?.(plan);
  const times = options.times ?? 1;
  // `tsx --eval` 按 CJS 編譯,不支持頂層 await → 包一層 async main。
  const script = [
    `import { runVerifiedSelfUpdate } from ${JSON.stringify(SELFUPDATE_MODULE)};`,
    `async function main() {`,
    `  const attempts = [];`,
    `  for (let i = 0; i < ${times}; i++) {`,
    `    try {`,
    `      await runVerifiedSelfUpdate("claude-code", ${JSON.stringify(options.currentVersion)});`,
    `      attempts.push({ ok: true });`,
    `    } catch (error) {`,
    `      attempts.push({ ok: false, message: String(error?.message ?? error) });`,
    `    }`,
    `  }`,
    `  process.stdout.write("<<@" + JSON.stringify(attempts) + "@>>");`,
    `}`,
    `main().catch((error) => { process.stderr.write(String(error)); process.exit(1); });`,
  ].join("\n");
  const child = spawn(TSX, ["--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MACCHIATO_RELEASE_BASE: options.releaseBase ?? base,
      NODE_EXTRA_CA_CERTS: certPath,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const framed = /<<@(.*)@>>/s.exec(stdout);
  if (code !== 0 || !framed) {
    throw new Error(`self_update 子進程異常(code=${code}):\n${stdout}\n${stderr}`);
  }
  return JSON.parse(framed[1]!) as Attempt[];
}

/** spawn 前一步才創建的臨時目錄;存在即代表真的走到了交棒。 */
function handoffDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("macchiato-update-"));
}

/** 每個場景都必須成立:什麼都沒交棒出去。 */
function expectNoHandoff() {
  expect(handoffDirs()).toEqual([]);
}

/** 單次調用的簡寫。 */
async function attempt(options: Parameters<typeof runSelfUpdate>[0]): Promise<Attempt> {
  const [only] = await runSelfUpdate(options);
  return only!;
}

// 起子進程 + tsx 轉譯,單條 ~1s;給足餘量,免得 CI 機器慢就抖。
const TIMEOUT = 60_000;

/**
 * 本套需要 `openssl` 二進制生成自簽證書(selfupdate 硬要求 https,見上)。openssl CLI 在絕大多數
 * Linux/macOS 都在,但**不保證**(精簡鏡像可能只裝 libssl 不裝 CLI)。缺它就響亮跳過而非弄紅——
 * 本套是新增測試,不該讓沒裝 CLI 的既有機器(如夜跑機,非本倉維護者的機器)因此變紅。
 * 有 openssl 的環境(CI / 狗糧機容器 / 開發機)照跑,覆蓋不打折。
 */
const HAS_OPENSSL = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;
if (!HAS_OPENSSL) console.warn("⚠️ [#540 集成測試] 本機無 openssl CLI → 整套跳過(自簽證書生成不了);裝 openssl 即可恢復覆蓋");

describe.skipIf(!HAS_OPENSSL)("#540 self_update 集成鏈路(真 HTTPS + 真簽名清單)", () => {
  it("fixture 是真發布物:對得上硬編碼的生產公鑰(驗不過 = 公鑰輪換了,重抓一份即可)", () => {
    const parsed = verifyManifest(REAL_MANIFEST, REAL_SIG.toString("utf8"));
    expect(parsed.version).toBe(FIXTURE_VERSION);
    expect(parsed.files["install.sh"]).toMatch(/^[0-9a-f]{64}$/);
    // 佔位 install.sh 必須與清單對不上——正路徑「停在哈希關」的前提。
    expect(createHash("sha256").update(DECOY_INSTALL_SH).digest("hex")).not.toBe(
      parsed.files["install.sh"],
    );
  });

  it(
    "低版本 → 驗簽過、版本閘過、抓到 install.sh,恰好停在哈希關(證明前面全過,且永不交棒)",
    async () => {
      const result = await attempt({ currentVersion: "1.0.0" });
      expect(result.ok).toBe(false);
      // 停在鏈條最後一關:哈希不符。反向斷言排除「其實是前面某關先掛了」。
      expect(result.message).toMatch(/install\.sh sha256 不符/);
      expect(result.message).not.toMatch(/簽名/);
      expect(result.message).not.toMatch(/非升級/);
      expect(result.message).not.toMatch(/結構/);
      // 三個文件都真抓了(清單與簽名並發,順序不定;install.sh 必在其後)。
      expect(hits).toHaveLength(3);
      expect(hits.slice(0, 2).sort()).toEqual(["/release.json", "/release.json.sig"]);
      expect(hits[2]).toBe("/install.sh");
      expectNoHandoff();
    },
    TIMEOUT,
  );

  it("同版清單 → 拒絕重放,且根本不去抓 install.sh", async () => {
    const result = await attempt({ currentVersion: FIXTURE_VERSION });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      `拒絕非升級清單:清單 v${FIXTURE_VERSION} = 本機 v${FIXTURE_VERSION}`,
    );
    expect(hits).not.toContain("/install.sh");
    expectNoHandoff();
  }, TIMEOUT);

  it("本機版本更高 → 拒絕降級,同樣不抓 install.sh", async () => {
    const result = await attempt({ currentVersion: "9.9.9" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`拒絕非升級清單:清單 v${FIXTURE_VERSION} < 本機 v9.9.9`);
    expect(hits).not.toContain("/install.sh");
    expectNoHandoff();
  }, TIMEOUT);

  it("清單被改一個字節 → 簽名驗證失敗,鏈路在第一關就斷", async () => {
    const result = await attempt({
      currentVersion: "1.0.0",
      serve: (p) => {
        const tampered = Buffer.from(REAL_MANIFEST);
        tampered[Math.floor(tampered.length / 2)]! ^= 0x01;
        p.manifest = tampered;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/release\.json 簽名驗證失敗/);
    expect(hits).not.toContain("/install.sh");
    expectNoHandoff();
  }, TIMEOUT);

  it("簽名被換一個 base64 字符 → 走到 ed25519 驗簽才拒(不是編碼檢查兜的底)", async () => {
    const result = await attempt({
      currentVersion: "1.0.0",
      serve: (p) => {
        // 換成另一個合法 base64 字符,好讓它過得了編碼正則、真正走到 ed25519 驗簽。
        const text = REAL_SIG.toString("utf8");
        p.sig = Buffer.from((text[0] === "A" ? "B" : "A") + text.slice(1));
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/release\.json 簽名驗證失敗/);
    expect(result.message).not.toMatch(/編碼/);
    expect(hits).not.toContain("/install.sh");
    expectNoHandoff();
  }, TIMEOUT);

  it("清單被 302 轉走 → 直接失敗,絕不跟着跳去別的主機", async () => {
    const result = await attempt({
      currentVersion: "1.0.0",
      serve: (p) => p.redirect.add("/release.json"),
    });
    expect(result.ok).toBe(false);
    // undici 對 redirect:"error" 只給通用 TypeError("fetch failed"),沒有更細的文案可斷言;
    // 真正的斷言在下面兩條:沒接受任何字節、也沒往下走。
    expect(result.message).toBe("fetch failed");
    expect(result.message).not.toMatch(/簽名|結構|非升級/);
    expect(hits).not.toContain("/install.sh");
    expectNoHandoff();
  }, TIMEOUT);

  it("MACCHIATO_RELEASE_BASE 指向 http → 一個字節都不下載", async () => {
    const result = await attempt({
      currentVersion: "1.0.0",
      releaseBase: `http://127.0.0.1:${port}`,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/拒絕非 https/);
    expect(hits).toEqual([]);
    expectNoHandoff();
  }, TIMEOUT);

  it("下載/驗證失敗後閂會鬆開:第二次仍走完整鏈路,而不是被當成重放", async () => {
    const attempts = await runSelfUpdate({ currentVersion: "1.0.0", times: 2 });
    expect(attempts).toHaveLength(2);
    for (const one of attempts) {
      expect(one.ok).toBe(false);
      expect(one.message).toMatch(/install\.sh sha256 不符/);
      expect(one.message).not.toMatch(/已在本进程启动/);
    }
    expect(hits).toHaveLength(6); // 兩輪都真的重抓了三個文件
    expectNoHandoff();
  }, TIMEOUT);
});
