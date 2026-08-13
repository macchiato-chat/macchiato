/**
 * #832 終端 QR：純庫渲染（不依賴系統 `qrencode`）。
 *
 * 歷史上 #388 用 `spawnSync("qrencode")`，本機沒裝就靜默跳過——多數安裝場景永遠看不到
 * QR，只能手輸配對碼。改為內建 `qrcode` 庫，行為對齊 clawdbot / WhatsApp 類 CLI：
 * 裝完即打出可掃的終端碼。
 *
 * 輸出是**附加**視覺信息；配對碼 `>>> digits <<<` 與 secret 行保持可複製單行不變。
 */
import QRCode from "qrcode";

/** 把文本編碼成小尺寸 ANSI 終端 QR（半高塊字符）。失敗返回 null。 */
export function renderQrTerminal(text: string): string | null {
  if (!text) return null;
  try {
    // small:true → 半高 Unicode 塊，約一半行數，終端更省、更像 clawdbot 的樣式。
    const out = QRCode.create(text, { errorCorrectionLevel: "M" });
    // BitMatrix.get 回 0|1 number，不是 boolean
    return matrixToTerminal(out.modules.size, (row, col) => out.modules.get(row, col) === 1);
  } catch {
    return null;
  }
}

// ⚠️ 顏色在這裡**不是裝飾，是碼本身**：塊字符用前景色畫暗模組、用背景色畫亮模組，不顯式
// 指定就跟着終端主題走——深色終端上整張碼是**反相**的，而 iOS 端用的
// AVCaptureMetadataOutput 讀不了反相 QR，等於這個功能對用深色終端的人根本不存在。
// 舊實現 `qrencode -t ANSIUTF8` 一直是顯式吐白底黑碼的，換成純庫渲染不能把這條丟了。
const ANSI_QR = "\u001b[30;107m"; // 黑前景（暗模組）+ 亮白背景（亮模組）
const ANSI_RESET = "\u001b[0m";

/**
 * 半高塊渲染：兩行 modules 合成一行（▀/▄/█/空格），每行自帶黑白配色。
 * 外圈留 2 模組 quiet zone，方便攝像頭對焦（對齊舊 `qrencode -m 2`）。
 */
function matrixToTerminal(
  size: number,
  dark: (row: number, col: number) => boolean,
): string {
  const quiet = 2;
  const n = size + quiet * 2;
  const at = (r: number, c: number): boolean => {
    const rr = r - quiet;
    const cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return false;
    return dark(rr, cc);
  };
  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    for (let c = 0; c < n; c += 1) {
      const top = at(r, c);
      const bot = r + 1 < n ? at(r + 1, c) : false;
      if (top && bot) line += "█";
      else if (top) line += "▀";
      else if (bot) line += "▄";
      else line += " ";
    }
    lines.push(`${ANSI_QR}${line}${ANSI_RESET}`);
  }
  return lines.join("\n");
}

/** 打印終端 QR + 掃碼提示；渲染失敗則靜默（碼與 secret 行已在上方）。 */
export function printQrTerminal(text: string, hint = "scan with the Macchiato iOS app"): void {
  const qr = renderQrTerminal(text);
  if (!qr) return;
  console.log(`\n${qr}`);
  console.log(`  (${hint})`);
}
