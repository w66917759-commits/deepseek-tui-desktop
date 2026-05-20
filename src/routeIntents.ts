export type RouteIntentId =
  | "frontend_design"
  | "frontend_review"
  | "localization_review"
  | "translation_chat"
  | "agentic_planning"
  | "scheduled_task"
  | "skill_management"
  | "general_review"
  | "interactive_chat";

export interface RouteIntentMatch {
  id: RouteIntentId;
  score: number;
  reason: string;
  signals: string[];
}

const SCHEDULED_PATTERN = /定时|自动任务|提醒|每天|每小时|每周|稍后|明天|后天|schedule|scheduled|recurring|remind|later/i;
const SKILL_MANAGEMENT_PATTERN = /安装\s*skill|下载\s*skill|导入\s*skill|更新\s*skill|install\s+(a\s+)?skill|download\s+(a\s+)?skill|import\s+(a\s+)?skill/i;
const AGENTIC_PATTERN = /计划|方案|规划|拆解|子\s*agent|子代理|多代理|分工|并行|plan|decompose|sub-?agent|delegate|parallel agents?|multi-?agent/i;
const FRONTEND_PATTERN = /(^|[^a-z])ui([^a-z]|$)|(^|[^a-z])ux([^a-z]|$)|界面|布局|视觉|交互|前端|样式|按钮|组件|页面|responsive|mobile|design|frontend|react|vue|svelte/i;
const FRONTEND_ACTION_PATTERN = /设计|优化|构建|实现|调整|完善|改进|重做|重构|布局|样式|动效|按钮|移动端|design|build|implement|improve|refine|layout|style|responsive|mobile/i;
const REVIEW_PATTERN = /检查|审查|评估|验证|测试|是否准备|是否完整|是否合理|review|verify|test|audit|qa/i;
const WORK_REVIEW_PATTERN = /检查|审查|评估|验证|测试|研究|排查|诊断|修复|修改|实现|重构|fix|debug|bug|review|verify|test|diagnose|investigate|implement|refactor/i;
const LOCALIZATION_PATTERN = /翻译|中文|多语言|语言包|本地化|国际化|文案|i18n|l10n|locale|localization|translation|translate/i;
const PROJECT_CONTEXT_PATTERN = /项目|页面|界面|应用|网站|全站|所有|全部|路由|route|app|site|page|screen|project/i;
const DIRECT_TRANSLATION_PATTERN = /把.+翻译|翻译成|翻译为|translate.+to|translate this|translate the/i;
const DIRECT_TEXT_PATTERN = /这段|这句|文本|句子|copy|sentence|paragraph|text/i;

function addIntent(
  intents: RouteIntentMatch[],
  id: RouteIntentId,
  score: number,
  reason: string,
  signals: string[]
) {
  if (score <= 0) return;
  const existing = intents.find((intent) => intent.id === id);
  if (existing) {
    existing.score = Math.max(existing.score, score);
    existing.signals = Array.from(new Set([...existing.signals, ...signals]));
    return;
  }
  intents.push({ id, score, reason, signals });
}

function patternSignals(prompt: string, patterns: Array<[RegExp, string]>) {
  return patterns
    .filter(([pattern]) => pattern.test(prompt))
    .map(([, signal]) => signal);
}

export function classifyRouteIntents(prompt: string): RouteIntentMatch[] {
  const normalized = String(prompt || "").trim();
  const intents: RouteIntentMatch[] = [];
  if (!normalized) {
    return [{
      id: "interactive_chat",
      score: 1,
      reason: "empty prompt falls back to interactive chat",
      signals: ["empty prompt"]
    }];
  }

  const hasLocalization = LOCALIZATION_PATTERN.test(normalized);
  const hasReview = REVIEW_PATTERN.test(normalized);
  const hasWorkReview = WORK_REVIEW_PATTERN.test(normalized);
  const hasFrontend = FRONTEND_PATTERN.test(normalized);
  const hasFrontendAction = FRONTEND_ACTION_PATTERN.test(normalized);
  const hasProjectContext = PROJECT_CONTEXT_PATTERN.test(normalized);
  const hasDirectTranslation = DIRECT_TRANSLATION_PATTERN.test(normalized);
  const hasDirectText = DIRECT_TEXT_PATTERN.test(normalized);

  if (SCHEDULED_PATTERN.test(normalized)) {
    addIntent(intents, "scheduled_task", 90, "prompt asks for scheduled or recurring work", ["schedule"]);
  }

  if (SKILL_MANAGEMENT_PATTERN.test(normalized)) {
    addIntent(intents, "skill_management", 90, "prompt asks to install or manage skills", ["skill management"]);
  }

  if (AGENTIC_PATTERN.test(normalized)) {
    addIntent(intents, "agentic_planning", 78, "prompt asks for planning, decomposition, or multi-agent work", ["planning"]);
  }

  if (hasLocalization && hasReview && hasProjectContext) {
    addIntent(
      intents,
      "localization_review",
      84,
      "prompt asks to review localized UI or translation readiness",
      patternSignals(normalized, [
        [LOCALIZATION_PATTERN, "localization"],
        [REVIEW_PATTERN, "review"],
        [PROJECT_CONTEXT_PATTERN, "project or UI context"]
      ])
    );
  }

  if (hasLocalization && hasDirectTranslation && (!hasProjectContext || hasDirectText) && !hasReview) {
    addIntent(intents, "translation_chat", 74, "prompt asks for direct translation, not project routing", ["direct translation"]);
  }

  if (hasFrontend && hasReview && !hasLocalization) {
    addIntent(intents, "frontend_review", 76, "prompt asks to review frontend UI or UX", ["frontend", "review"]);
  }

  if (hasFrontend && hasFrontendAction && !hasLocalization) {
    addIntent(intents, "frontend_design", 70, "prompt asks to design or refine frontend UI", ["frontend", "design action"]);
  }

  if (hasWorkReview && !SKILL_MANAGEMENT_PATTERN.test(normalized) && !SCHEDULED_PATTERN.test(normalized)) {
    addIntent(intents, "general_review", 52, "prompt asks for review, verification, implementation, or debugging", ["work review"]);
  }

  if (intents.length === 0) {
    addIntent(intents, "interactive_chat", 8, "no specialized routing intent detected", ["fallback"]);
  }

  return intents.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function primaryRouteIntent(intents: RouteIntentMatch[]): RouteIntentId {
  return intents[0]?.id || "interactive_chat";
}
