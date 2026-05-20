import type { ModelProfileId } from "./modelRouter";
import type { RouteIntentId } from "./routeIntents";

export interface SkillCapabilitySpec {
  id: string;
  summary: string;
  aliases: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  supportedIntents: RouteIntentId[];
  priority: number;
  defaultModelProfile: ModelProfileId;
  positivePatterns: RegExp[];
  negativePatterns: RegExp[];
}

export const builtinSkillRegistry: Record<string, SkillCapabilitySpec> = {
  "scheduled-task-agent": {
    id: "scheduled-task-agent",
    summary: "Create reminders, recurring work, and scheduled follow-up tasks.",
    aliases: ["schedule", "reminder", "recurring"],
    positiveExamples: ["每天 9 点提醒我跑 npm test", "remind me tomorrow to check the build"],
    negativeExamples: ["write a raw cron file", "review this code"],
    supportedIntents: ["scheduled_task"],
    priority: 12,
    defaultModelProfile: "interactive",
    positivePatterns: [/定时|自动任务|提醒|每天|每小时|每周|稍后|明天|后天|schedule|scheduled|recurring|remind|later/i],
    negativePatterns: [/crontab|raw\s+cron|五字段\s*cron/i]
  },
  "cron-scheduler": {
    id: "cron-scheduler",
    summary: "Handle raw cron syntax or crontab file work.",
    aliases: ["cron", "crontab"],
    positiveExamples: ["写一个五字段 cron", "update this raw cron file"],
    negativeExamples: ["明天提醒我", "每天帮我检查一次"],
    supportedIntents: [],
    priority: 10,
    defaultModelProfile: "interactive",
    positivePatterns: [/crontab|cron\s+file|raw\s+cron|五字段\s*cron/i],
    negativePatterns: []
  },
  "skill-downloader": {
    id: "skill-downloader",
    summary: "Install, import, download, or update local skills.",
    aliases: ["skill install", "skill import"],
    positiveExamples: ["帮我安装 skill https://example.com/SKILL.md", "import this skill directory"],
    negativeExamples: ["use a skill for this prompt", "review skill routing"],
    supportedIntents: ["skill_management"],
    priority: 12,
    defaultModelProfile: "interactive",
    positivePatterns: [/安装\s*skill|下载\s*skill|导入\s*skill|更新\s*skill|install\s+(a\s+)?skill|download\s+(a\s+)?skill|import\s+(a\s+)?skill/i],
    negativePatterns: []
  },
  "ui-ux-pro-max": {
    id: "ui-ux-pro-max",
    summary: "Design, build, refine, or review frontend UI/UX.",
    aliases: ["ui", "ux", "frontend", "design"],
    positiveExamples: ["优化移动端布局和按钮样式", "检查这个页面 UI/UX 是否合理"],
    negativeExamples: ["检查中文界面翻译是否准备", "把这段英文翻译成中文"],
    supportedIntents: ["frontend_design", "frontend_review"],
    priority: 9,
    defaultModelProfile: "reviewer",
    positivePatterns: [/ui|ux|界面|布局|视觉|交互|前端|样式|css|responsive|mobile|design|frontend|react|vue|svelte/i],
    negativePatterns: [/翻译|多语言|语言包|本地化|国际化|i18n|l10n|locale|localization|translation|translate/i]
  },
  superpowers: {
    id: "superpowers",
    summary: "Plan, review, debug, verify, decompose, and manage agentic coding work.",
    aliases: ["plan", "review", "debug", "verify", "subagent"],
    positiveExamples: ["修复这个 TypeScript 编译错误", "请拆解成多个子 Agent 并行执行", "检查项目翻译是否准备"],
    negativeExamples: ["把这段话翻译成中文", "明天提醒我"],
    supportedIntents: ["agentic_planning", "localization_review", "frontend_review", "general_review"],
    priority: 7,
    defaultModelProfile: "long-horizon",
    positivePatterns: [/计划|方案|实现|修改|修复|重构|检查|审查|测试|研究|排查|诊断|评估|拆解|子\s*agent|子代理|多代理|分工|并行|多步骤|长任务|性能|瓶颈|卡顿|延迟|实际体验|体验不好|debug|bug|plan|implement|refactor|review|verify|test|fix|diagnose|investigate|decompose|sub-?agent|delegate|parallel agents?|multi-?agent|performance|latency|bottleneck/i],
    negativePatterns: [/^把.+翻译|^translate this/i]
  }
};

export function skillRegistryEntries() {
  return Object.values(builtinSkillRegistry);
}

export function getSkillCapabilitySpec(skillId: string) {
  return builtinSkillRegistry[skillId];
}
