/**
 * #383 附件落盤硬化:權限 0700/0600、Content-Length 早拒、配額拒絕、失敗 unlink partial、
 * 並發上限、GC lstat 不跟隨 symlink / 清 .part 殘留。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOWNLOAD_MAX,
  _resetAttachInflightForTest,
  _setAttachInflightForTest,
  attachInflightCount,
  gcAttachments,
  materializeAttachment,
} from "../src/cc/attachments";


const LOCAL_ENV_KEYS = [
  "MACCHIATO_ATTACH_ALLOW_LOCALHOST",
  "MACCHIATO_ATTACH_LOCAL_PORT",
  "MACCHIATO_ATTACH_LOCAL_PATH_PREFIX",
] as const;

function clearLocalAttachEnv() {
  for (const k of LOCAL_ENV_KEYS) delete process.env[k];
}

/** #379+#383:本机 http 测试服需显式 dev 开关 + 动态 port + 空 path 前缀. */
function allowLocalPort(port: number) {
  process.env.MACCHIATO_ATTACH_ALLOW_LOCALHOST = "1";
  process.env.MACCHIATO_ATTACH_LOCAL_PORT = String(port);
  process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX = "";
}


const skipPerm = process.platform === "win32";

function modeOf(p: string): number {
  return lstatSync(p).mode & 0o777;
}

function listen(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createServer(handler);
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({
        port,
        close: () =>
          new Promise((r, j) => {
            srv.close((e) => (e ? j(e) : r()));
          }),
      });
    });
  });
}

afterEach(() => {
  _resetAttachInflightForTest();
  delete process.env.MACCHIATO_CC_ATTACH_QUOTA_BYTES;
  delete process.env.MACCHIATO_CC_ATTACH_MAX_INFLIGHT;
});

afterEach(() => {
  clearLocalAttachEnv();
});

describe("#383 CC attachments hardening", () => {
  it("落盤目錄 0700、文件 0600(非 Windows)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-att-perm-"));
    process.env.MACCHIATO_CC_ATTACH_DIR = dir;
    const payload = Buffer.from("hello-perm");
    const { port, close } = await listen((_q, res) => {
      res.setHeader("content-length", String(payload.length));
      res.end(payload);
    });
    allowLocalPort(port);
    try {
      const p = await materializeAttachment({ id: "p1", name: "a.bin", url: `http://127.0.0.1:${port}/a.bin` });
      expect(readFileSync(p)).toEqual(payload);
      if (!skipPerm) {
        expect(modeOf(dir)).toBe(0o700);
        expect(modeOf(join(dir, "p1"))).toBe(0o700);
        expect(modeOf(p)).toBe(0o600);
      }
    } finally {
      await close();
    }
  });

  it("Content-Length 超 DOWNLOAD_MAX → 早拒且不留 partial", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-att-cl-"));
    process.env.MACCHIATO_CC_ATTACH_DIR = dir;
    const { port, close } = await listen((_q, res) => {
      res.setHeader("content-length", String(DOWNLOAD_MAX + 1));
      res.end(Buffer.alloc(16, 1)); // 體可小,只測早拒
    });
    allowLocalPort(port);
    try {
      await expect(
        materializeAttachment({ id: "cl1", name: "big.bin", url: `http://127.0.0.1:${port}/big.bin` }),
      ).rejects.toThrow(/Content-Length/);
      // 不應留下任何 .part 或成品
      const sub = join(dir, "cl1");
      if (existsSync(sub)) {
        const left = readdirSync(sub);
        expect(left.filter((f) => f.endsWith(".part") || f === "big.bin")).toEqual([]);
      }
    } finally {
      await close();
    }
  });

  it("流式超限(無 Content-Length)失敗 → unlink partial", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-att-stream-"));
    process.env.MACCHIATO_CC_ATTACH_DIR = dir;
    // 不帶 CL, body 超過 DOWNLOAD_MAX
    const { port, close } = await listen((_q, res) => {
      // 分塊寫出超過上限
      const chunk = Buffer.alloc(1024 * 1024, 0xab); // 1MB
      const n = Math.floor(DOWNLOAD_MAX / chunk.length) + 2;
      res.writeHead(200);
      let i = 0;
      const pump = () => {
        while (i < n) {
          i += 1;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    allowLocalPort(port);
    try {
      await expect(
        materializeAttachment({ id: "ov1", name: "huge.bin", url: `http://127.0.0.1:${port}/huge.bin` }),
      ).rejects.toThrow(/超過上限/);
      const sub = join(dir, "ov1");
      if (existsSync(sub)) {
        const left = readdirSync(sub);
        expect(left.filter((f) => f.endsWith(".part") || f === "huge.bin")).toEqual([]);
      }
      expect(attachInflightCount()).toBe(0);
    } finally {
      await close();
    }
  }, 60_000);

  it("全局配額已滿 → 拒絕且不寫盤", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-att-quota-"));
    process.env.MACCHIATO_CC_ATTACH_DIR = dir;
    process.env.MACCHIATO_CC_ATTACH_QUOTA_BYTES = "100";
    // 先塞滿
    const filled = join(dir, "old");
    mkdirSync(filled, { recursive: true });
    writeFileSync(join(filled, "fill.bin"), Buffer.alloc(100));
    const { port, close } = await listen((_q, res) => res.end("x"));
    allowLocalPort(port);
    try {
      await expect(
        materializeAttachment({ id: "q1", name: "n.bin", url: `http://127.0.0.1:${port}/n.bin` }),
      ).rejects.toThrow(/配額/);
      expect(existsSync(join(dir, "q1", "n.bin"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("並發達上限 → 拒絕", async () => {
    process.env.MACCHIATO_CC_ATTACH_MAX_INFLIGHT = "1";
    _setAttachInflightForTest(1);
    try {
      await expect(
        materializeAttachment({ id: "i2", name: "b.bin", url: (allowLocalPort(9), "http://127.0.0.1:9/b.bin") }),
      ).rejects.toThrow(/並發/);
      // 被拒時不得洩漏 slot(仍為佔位的 1,不是 2)
      expect(attachInflightCount()).toBe(1);
    } finally {
      _resetAttachInflightForTest();
    }
  });

  it("GC:lstat 不跟隨 symlink;清過期 .part;新文件保留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-att-gc2-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "cc-att-out-"));
    process.env.MACCHIATO_CC_ATTACH_DIR = dir;
    const sub = join(dir, "g1");
    mkdirSync(sub, { recursive: true });
    const keep = join(sub, "keep.bin");
    writeFileSync(keep, "k");
    const part = join(sub, ".crash.bin.deadbeef.part");
    writeFileSync(part, "partial");
    // 讓 .part 足夠舊(>15min)
    const past = (Date.now() - 20 * 60_000) / 1000;
    utimesSync(part, past, past);
    // 目標在 attach root **外**——GC 應 unlink symlink 本身,不碰目標
    const outside = join(outsideDir, "secret.bin");
    writeFileSync(outside, "secret");
    const link = join(sub, "evil.link");
    symlinkSync(outside, link);

    const removed = gcAttachments(Date.now() + 11 * 60_000);
    expect(removed).toBeGreaterThanOrEqual(2); // part + symlink
    expect(existsSync(part)).toBe(false);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(outside)).toBe(true); // 未跟隨刪目標
    expect(existsSync(keep)).toBe(true);
  });
});
