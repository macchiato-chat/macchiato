/**
 * #313 遠程重登錄:app 內協助完成 ChatGPT/Codex 訂閱 OAuth,免上連接器主機終端。
 *
 * 流程(對 codex-cli 0.144.1 實測):spawn `codex login --device-auth`(device code 流,
 * 普通管道即可、無需 PTY)→ stdout 出授權 URL(https://auth.openai.com/codex/device)+
 * 一次性碼(如 KH16-PSI71,15 分鐘有效)→ 上送 server 中轉給 app → 用戶手機開 URL、
 * 輸碼、授權 → CLI 自輪詢完成、寫 ~/.codex/auth.json。**無需回傳任何東西**(needsCode=false),
 * token 全程只在本機。
 *
 * 單流程互斥:重複 start 先殺舊的;16 分鐘超時收屍(碼 15 分鐘過期)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolveCodexBin } from "./codex-bin";

const LOGIN_TIMEOUT_MS = Number(process.env.MACCHIATO_CODEX_LOGIN_TIMEOUT_MS) || 16 * 60_000;
const URL_RE = /https:\/\/\S*openai\.com\/\S+/;
/** 一次性碼:獨立行的 XXXX-XXXXX 形(實測 KH16-PSI71;寬容位數防上游微調)。 */
const CODE_RE = /^\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\s*$/m;

export interface LoginEvents {
  onUrl(url: string, userCode?: string): void;
  onResult(ok: boolean, error?: string): void;
}

export class LoginFlow {
  private proc: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  get active(): boolean {
    return this.proc !== null && !this.done;
  }

  start(ev: LoginEvents): void {
    this.abort();
    this.done = false;
    const proc = spawn(resolveCodexBin(), ["login", "--device-auth"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;
    let out = "";
    let sent = false;
    const onData = (d: Buffer): void => {
      out += d.toString().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""); // 剝 ANSI 色碼
      if (!sent) {
        const url = out.match(URL_RE)?.[0];
        const code = out.match(CODE_RE)?.[1];
        if (url && code) {
          sent = true;
          ev.onUrl(url, code);
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      if (this.done) return;
      this.done = true;
      this.clearTimer();
      this.proc = null;
      if (code === 0) ev.onResult(true);
      else ev.onResult(false, `login exited ${code}: ${out.slice(-200).trim()}`);
    });
    proc.on("error", (e) => {
      if (this.done) return;
      this.done = true;
      this.clearTimer();
      this.proc = null;
      ev.onResult(false, `spawn failed: ${e.message}`);
    });
    this.timer = setTimeout(() => {
      if (this.done) return;
      this.done = true;
      this.kill();
      ev.onResult(false, "login timed out (16min, device code expired)");
    }, LOGIN_TIMEOUT_MS);
  }

  abort(): void {
    this.done = true;
    this.clearTimer();
    this.kill();
  }

  private kill(): void {
    try {
      this.proc?.kill("SIGKILL");
    } catch {
      /* 已死 */
    }
    this.proc = null;
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
