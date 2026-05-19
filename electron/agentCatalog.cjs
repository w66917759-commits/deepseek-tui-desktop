const AGENT_TYPE_DEFINITIONS = [
  {
    type: "planner",
    label: "Planner",
    patterns: [/planner/i, /planning/i, /architect/i, /方案|计划|架构/]
  },
  {
    type: "explorer",
    label: "Explorer",
    patterns: [/explorer/i, /research/i, /inspect/i, /调查|检索|探索|分析/]
  },
  {
    type: "worker",
    label: "Worker",
    patterns: [/worker/i, /implement/i, /builder/i, /generator/i, /实现|开发|修改/]
  },
  {
    type: "reviewer",
    label: "Reviewer",
    patterns: [/reviewer/i, /review/i, /code[- ]?review/i, /审查|复核/]
  },
  {
    type: "build-fixer",
    label: "Build Fixer",
    patterns: [/build[- ]?(fixer|resolver)/i, /type[- ]?error/i, /compiler/i, /编译|构建|类型错误/]
  },
  {
    type: "tester",
    label: "Tester",
    patterns: [/tester/i, /test[- ]?runner/i, /e2e/i, /verification/i, /测试|验证/]
  }
];

function stableAgentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return AGENT_TYPE_DEFINITIONS.some((definition) => definition.type === normalized) ? normalized : "custom";
}

function classifyAgentType(candidate = {}) {
  const explicit = stableAgentType(candidate.type || candidate.agentType || candidate.role || "");
  if (explicit !== "custom") return explicit;
  const haystack = [
    candidate.id,
    candidate.name,
    candidate.summary,
    candidate.detail,
    candidate.message
  ].map((value) => String(value || "")).join(" ");
  for (const definition of AGENT_TYPE_DEFINITIONS) {
    if (definition.patterns.some((pattern) => pattern.test(haystack))) {
      return definition.type;
    }
  }
  return "custom";
}

function agentTypeLabel(type) {
  const definition = AGENT_TYPE_DEFINITIONS.find((candidate) => candidate.type === type);
  return definition ? definition.label : "Custom";
}

function normalizeAgentCatalogRecord(candidate = {}, source = "runtime-api") {
  const type = classifyAgentType(candidate);
  return {
    ...candidate,
    type,
    typeLabel: agentTypeLabel(type),
    classificationSource: source === "runtime-api" ? "confirmed" : "observed"
  };
}

module.exports = {
  AGENT_TYPE_DEFINITIONS,
  agentTypeLabel,
  classifyAgentType,
  normalizeAgentCatalogRecord
};
