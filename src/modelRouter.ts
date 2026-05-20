import type { RouteIntentMatch } from "./routeIntents";

export type ModelProfileId = "interactive" | "planner" | "reviewer" | "long-horizon" | "fallback" | "custom";
export type ModelRoutingMode = "auto" | "manual";

export interface ModelProfile {
  id: ModelProfileId;
  label: string;
  provider: ProviderMode;
  model: string;
  reason: string;
}

export interface ModelRouteDecision {
  mode: ModelRoutingMode;
  profile: ModelProfile;
  model: string;
  apiModel: string;
  provider: ProviderMode;
  reason: string;
}

export const modelProfiles: Record<ModelProfileId, ModelProfile> = {
  interactive: {
    id: "interactive",
    label: "Interactive",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reason: "short interactive turns prefer V4 Flash"
  },
  planner: {
    id: "planner",
    label: "Planner",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reason: "planning and decomposition prefer V4 Pro"
  },
  reviewer: {
    id: "reviewer",
    label: "Reviewer",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reason: "review and verification prefer V4 Pro"
  },
  "long-horizon": {
    id: "long-horizon",
    label: "Long Horizon",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reason: "long or complex agentic work prefers V4 Pro"
  },
  fallback: {
    id: "fallback",
    label: "Fallback",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reason: "fallback stays on the default DeepSeek provider"
  },
  custom: {
    id: "custom",
    label: "Custom",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reason: "custom provider is only used when explicitly selected"
  }
};

function apiModelForDeepSeek(model: string) {
  if (model === "deepseek-v4-flash" || model === "deepseek-v4-flash-1m" || model === "deepseek-chat" || model === "deepseek-reasoner") {
    return "deepseek-v4-flash";
  }
  if (model === "deepseek-v4-pro" || model === "deepseek-v4-pro-1m") {
    return "deepseek-v4-pro";
  }
  return model || "deepseek-v4-pro";
}

function manualProfile(settings: Partial<DesktopSettings>): ModelProfile {
  return {
    id: settings.provider === "deepseek" ? "custom" : "fallback",
    label: settings.provider === "deepseek" ? "Selected DeepSeek model" : "Selected provider model",
    provider: settings.provider || "deepseek",
    model: settings.model || "deepseek-v4-pro",
    reason: "manual model routing keeps the selected model"
  };
}

function routeIntentIds(routeIntents: RouteIntentMatch[] | undefined) {
  return new Set((routeIntents || []).map((intent) => intent.id));
}

function autoProfile(prompt: string, permissionMode: string | undefined, activeSkillIds: string[], routeIntents?: RouteIntentMatch[]) {
  const intents = routeIntentIds(routeIntents);
  if (
    activeSkillIds.includes("scheduled-task-agent")
    || activeSkillIds.includes("cron-scheduler")
    || activeSkillIds.includes("skill-downloader")
    || intents.has("scheduled_task")
    || intents.has("skill_management")
  ) {
    return modelProfiles.interactive;
  }
  if (intents.has("translation_chat") && activeSkillIds.length === 0) return modelProfiles.interactive;
  if (permissionMode === "plan" || intents.has("agentic_planning") || /计划|方案|规划|拆解|子\s*agent|子代理|多代理|分工|并行|plan|decompose|sub-?agent|delegate|parallel agents?|multi-?agent/i.test(prompt)) return modelProfiles.planner;
  if (intents.has("localization_review") || intents.has("frontend_review")) return modelProfiles.reviewer;
  if (
    prompt.length > 600
    || /复杂|长期|长任务|多步骤|重构|架构|全量|多代理|分工|并行|性能|瓶颈|卡顿|延迟|实际体验|体验不好|用户交互|交互流程|end.?to.?end|architecture|refactor|migration|parallel agents?|multi-?agent|performance|latency|bottleneck/i.test(prompt)
    || activeSkillIds.includes("superpowers")
  ) {
    return modelProfiles["long-horizon"];
  }
  if (
    intents.has("general_review")
    || /review|审查|代码审查|检查|verify|验证|测试|test/i.test(prompt)
  ) return modelProfiles.reviewer;
  return modelProfiles.interactive;
}

export function routeModelForPrompt(options: {
  prompt: string;
  permissionMode?: string;
  settings: Partial<DesktopSettings>;
  activeSkillIds?: string[];
  routeIntents?: RouteIntentMatch[];
}): ModelRouteDecision {
  const mode = (options.settings.modelRoutingMode || "auto") as ModelRoutingMode;
  const selectedProvider = options.settings.provider || "deepseek";
  const profile = mode === "manual" || selectedProvider !== "deepseek"
    ? manualProfile(options.settings)
    : autoProfile(options.prompt, options.permissionMode, options.activeSkillIds || [], options.routeIntents);
  const provider = selectedProvider === "deepseek" ? profile.provider : selectedProvider;
  const model = provider === "deepseek" ? profile.model : options.settings.model || profile.model;
  const apiModel = provider === "deepseek" ? apiModelForDeepSeek(model) : model;
  return {
    mode,
    profile,
    model,
    apiModel,
    provider,
    reason: profile.reason
  };
}
