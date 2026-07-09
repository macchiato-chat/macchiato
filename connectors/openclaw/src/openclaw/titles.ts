/**
 * #94 OpenClaw AI 重命名標題生成。
 *
 * ⚠️ 遵守根 CLAUDE.md 鐵律:連接器**絕不寫死 provider/model**。OpenClaw 的難處:
 *   - 它有內置 LLM 起名(`generateThreadTitle`),但 gateway 不暴露、且是版本哈希路徑下的內部函數
 *     (需 cfg + 解析好的 model 對象),連接器無法穩定 import(升級即斷)——不像 Hermes 有乾淨的
 *     `agent.title_generator.generate_title` 可同 venv 復用。
 *   - 用戶默認 model(如 `openai/gpt-5.5`)連接器自己解析不到 provider;訂閱類更無可直接調的 key。
 * 故此處**安全降級為首句截斷**(零 LLM、零假設、對所有用戶都對)。真正的「用 OpenClaw 自身模型
 * 生成摘要」待 gateway 暴露方法或連接器路由過 agent(見 issue #103)。
 */

/** 首句截斷標題(清洗空白,截 56 字)。 */
export function generateTitle(firstUserText: string): string {
  return firstUserText.replace(/\s+/g, " ").trim().slice(0, 56);
}
