/**
 * #313 遠程重登錄:app 內協助完成 Claude 訂閱 OAuth,免上連接器主機終端。
 *
 * 流程(對 claude 2.1.212 實測):spawn `claude auth login`(要 PTY——非 TTY 下輸出不 flush、
 * 流程分支不同,用系統 `script` 包一層,零依賴)→ stdout 出「visit: https://claude.com/...
 * (URL 自帶 PKCE S256 code_challenge)」→ 上送 server 中轉給 app → 用戶手機上授權,授權頁
 * 給一次性 code → app 回傳 → 餵給 CLI stdin(「Paste code here if prompted >」)→ CLI 用
 * 本機 code_verifier 換 token 寫 ~/.claude。**verifier/token 永不離開本機**;經 server 中轉的
 * 只有 URL(下行)與一次性 code(上行),code 無 verifier 換不出 token。
 *
 * 單流程互斥:同時只允許一個登錄流(重複 start 先殺舊的);10 分鐘超時收屍。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolveClaudeBin } from "./claude-bin";

const LOGIN_TIMEOUT_MS = Number(process.env.MACCHIATO_CC_LOGIN_TIMEOUT_MS) || 10 * 60_000;
const URL_RE = /https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com)\/\S+/;

export interface LoginEvents {
  onUrl(url: string): void;
  onResult(ok: boolean, error?: string): void;
}

export class LoginFlow {
  private proc: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  get active(): boolean {
    return this.proc !== null && !this.done;
  }

  /** 起登錄流(已有活躍流 → 先殺,冪等重來)。 */
  start(ev: LoginEvents): void {
    this.abort();
    this.done = false;
    const bin = resolveClaudeBin();
    // PTY via `script`(Linux: -qec "cmd";macOS: -q /dev/null cmd...)。claude 是既有可執行檔,
    // 引號防路徑帶空格。
    const proc =
      process.platform === "darwin"
        ? spawn("script", ["-q", "/dev/null", bin, "auth", "login"], { env: process.env })
        : spawn("script", ["-qec", `"${bin}" auth login`, "/dev/null"], { env: process.env });
    this.proc = proc;
    let out = "";
    let urlSent = false;
    const onData = (d: Buffer): void => {
      // 剝 ANSI(PTY 輸出帶控制序列;URL 提取要乾淨文本)
      out += d.toString().replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
      if (!urlSent) {
        const m = out.match(URL_RE);
        if (m) {
          urlSent = true;
          ev.onUrl(m[0]);
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
      // exit 0 = CLI 完成換 token 寫盤;非 0 = 用戶取消/碼錯/網絡。尾部輸出當錯誤線索(截短防洩)。
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
      ev.onResult(false, "login timed out (10min)");
    }, LOGIN_TIMEOUT_MS);
  }

  /** claude 流:授權頁給的一次性 code 餵給 CLI stdin。 */
  submitCode(code: string): void {
    this.proc?.stdin?.write(code.trim() + "\n");
  }

  /** 殺掉進行中的流(不觸發 onResult——調用方自己決定語義)。 */
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
