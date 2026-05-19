export type SkillRoutingMode = "auto" | "manual" | "all";

export interface SkillTemplateLike {
  id: string;
  name?: string;
  description?: string;
  content?: string;
}

export interface SkillRouteMatch {
  skillId: string;
  reason: string;
  source: "manual" | "trigger" | "mode";
}

export interface SkillRouteDecision {
  mode: SkillRoutingMode;
  sanitizedPrompt: string;
  activeSkillIds: string[];
  matches: SkillRouteMatch[];
}

const SPECIALIZED_SKILL_TRIGGERS: Record<string, Array<{ pattern: RegExp; reason: string }>> = {
  "scheduled-task-agent": [
    { pattern: /定时|自动任务|提醒|每天|每小时|每周|稍后|明天|后天|schedule|scheduled|recurring|remind|later/i, reason: "prompt asks for scheduled or recurring work" }
  ],
  "cron-scheduler": [
    { pattern: /crontab|cron\s+file|raw\s+cron|五字段\s*cron/i, reason: "prompt asks for raw cron handling" }
  ],
  "skill-downloader": [
    { pattern: /安装\s*skill|下载\s*skill|导入\s*skill|更新\s*skill|install\s+(a\s+)?skill|download\s+(a\s+)?skill|import\s+(a\s+)?skill/i, reason: "prompt asks to install or import a skill" }
  ],
  "ui-ux-pro-max": [
    { pattern: /ui|ux|界面|布局|视觉|交互|前端|样式|css|responsive|mobile|design|frontend|react|vue|svelte/i, reason: "prompt is about UI or frontend design" }
  ]
};

const SUPERPOWERS_TRIGGERS = [
  { pattern: /计划|方案|实现|修改|修复|重构|检查|审查|测试|研究|排查|诊断|评估|拆解|子\s*agent|子代理|多代理|分工|并行|多步骤|长任务|性能|瓶颈|卡顿|延迟|实际体验|体验不好|debug|bug|plan|implement|refactor|review|verify|test|fix|diagnose|investigate|decompose|sub-?agent|delegate|parallel agents?|multi-?agent|performance|latency|bottleneck/i, reason: "prompt asks for agentic coding workflow" }
];

const GENERIC_TEMPLATE_WORDS = new Set([
  "agent",
  "agents",
  "skill",
  "skills",
  "task",
  "tasks",
  "prompt",
  "user",
  "users",
  "use",
  "uses",
  "using",
  "when",
  "with",
  "workflow",
  "workflows"
]);

function enabledSkillSet(settings: Partial<DesktopSettings>) {
  return new Set(Array.isArray(settings.enabledSkills) ? settings.enabledSkills : []);
}

function parseSkillFrontmatterList(content: string, key: string) {
  const match = String(content || "").match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
  if (!match) return [];
  return match[1]
    .split(/[,，]/)
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function manualSkillIds(prompt: string, knownSkillIds: Set<string>) {
  const ids: string[] = [];
  const directive = /(^|\s)\/([a-z0-9][a-z0-9-]{1,80})(?=\s|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = directive.exec(prompt)) !== null) {
    const id = match[2].toLowerCase();
    if (knownSkillIds.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function stripManualDirectives(prompt: string, ids: string[]) {
  let next = prompt;
  for (const id of ids) {
    next = next.replace(new RegExp(`(^|\\s)\\/${id}(?=\\s|$)`, "gi"), "$1");
  }
  return next.replace(/[ \t]{2,}/g, " ").trim();
}

function addMatch(matches: SkillRouteMatch[], match: SkillRouteMatch) {
  if (matches.some((candidate) => candidate.skillId === match.skillId)) return;
  matches.push(match);
}

function templateTriggeredSkill(template: SkillTemplateLike, prompt: string) {
  const haystack = [
    template.id,
    template.name || "",
    template.description || "",
    parseSkillFrontmatterList(template.content || "", "tags").join(" "),
    parseSkillFrontmatterList(template.content || "", "triggers").join(" ")
  ].join(" ").toLowerCase();
  if (!haystack.trim()) return "";
  const words = prompt.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((word) => word.length >= 3);
  return words.find((word) => !GENERIC_TEMPLATE_WORDS.has(word) && haystack.includes(word)) || "";
}

export function routeSkillsForPrompt(options: {
  prompt: string;
  workspacePath?: string;
  settings: Partial<DesktopSettings>;
  skillTemplates?: Record<string, SkillTemplateLike>;
}): SkillRouteDecision {
  const mode = (options.settings.skillRoutingMode || "auto") as SkillRoutingMode;
  const enabled = enabledSkillSet(options.settings);
  const templates = options.skillTemplates || {};
  const knownSkillIds = new Set([...enabled, ...Object.keys(templates)]);
  const manualIds = manualSkillIds(options.prompt, knownSkillIds).filter((id) => enabled.has(id));
  const sanitizedPrompt = stripManualDirectives(options.prompt, manualIds);

  if (options.settings.skillsEnabled === false) {
    return { mode, sanitizedPrompt, activeSkillIds: [], matches: [] };
  }

  const matches: SkillRouteMatch[] = [];
  for (const id of manualIds) {
    addMatch(matches, { skillId: id, reason: "manual /skill directive", source: "manual" });
  }

  if (mode === "all") {
    return {
      mode,
      sanitizedPrompt,
      activeSkillIds: Array.from(enabled),
      matches: Array.from(enabled).map((skillId) => ({ skillId, reason: "all mode keeps every selected skill active", source: "mode" }))
    };
  }

  if (mode === "manual") {
    return { mode, sanitizedPrompt, activeSkillIds: matches.map((match) => match.skillId), matches };
  }

  const prompt = sanitizedPrompt || options.prompt;
  let specializedMatched = false;
  for (const [skillId, triggers] of Object.entries(SPECIALIZED_SKILL_TRIGGERS)) {
    if (!enabled.has(skillId)) continue;
    const trigger = triggers.find((candidate) => candidate.pattern.test(prompt));
    if (!trigger) continue;
    specializedMatched = true;
    addMatch(matches, { skillId, reason: trigger.reason, source: "trigger" });
  }

  for (const [skillId, template] of Object.entries(templates)) {
    if (!enabled.has(skillId) || matches.some((match) => match.skillId === skillId)) continue;
    const keyword = templateTriggeredSkill(template, prompt);
    if (keyword) {
      specializedMatched = true;
      addMatch(matches, { skillId, reason: `prompt overlaps skill metadata: ${keyword}`, source: "trigger" });
    }
  }

  const superpowersTrigger = SUPERPOWERS_TRIGGERS.find((candidate) => candidate.pattern.test(prompt));
  if (
    enabled.has("superpowers")
    && superpowersTrigger
    && (!specializedMatched || /计划|方案|研究|排查|诊断|评估|拆解|子\s*agent|子代理|多代理|分工|并行|多步骤|长任务|性能|瓶颈|卡顿|延迟|实际体验|体验不好|plan|review|审查|diagnose|investigate|decompose|sub-?agent|delegate|parallel agents?|multi-?agent|performance|latency|bottleneck/i.test(prompt))
  ) {
    addMatch(matches, { skillId: "superpowers", reason: superpowersTrigger.reason, source: "trigger" });
  }

  return {
    mode,
    sanitizedPrompt,
    activeSkillIds: matches.map((match) => match.skillId),
    matches
  };
}
