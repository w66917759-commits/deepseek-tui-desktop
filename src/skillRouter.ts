import { classifyRouteIntents, primaryRouteIntent, type RouteIntentId, type RouteIntentMatch } from "./routeIntents";
import { getSkillCapabilitySpec, skillRegistryEntries, type SkillCapabilitySpec } from "./skillRegistry";

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
  source: "manual" | "trigger" | "mode" | "registry" | "template";
  intent?: RouteIntentId;
  score?: number;
}

export interface SkillRouteCandidate {
  skillId: string;
  score: number;
  intents: RouteIntentId[];
  reasons: string[];
  rejectedReasons: string[];
  selected: boolean;
}

export interface RejectedSkillRoute {
  skillId: string;
  reason: string;
  score: number;
  intents: RouteIntentId[];
}

export interface SkillRouteDebug {
  primaryIntent: RouteIntentId;
  summary: string;
  manualOverride: boolean;
  candidateCount: number;
  selectedCount: number;
  rejectedCount: number;
  notes: string[];
}

export interface SkillRouteDecision {
  mode: SkillRoutingMode;
  sanitizedPrompt: string;
  activeSkillIds: string[];
  matches: SkillRouteMatch[];
  intents: RouteIntentMatch[];
  candidates: SkillRouteCandidate[];
  rejectedSkills: RejectedSkillRoute[];
  routeDebug: SkillRouteDebug;
}

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

const SELECTION_THRESHOLD = 28;
const TEMPLATE_OVERLAP_SCORE = 18;

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

function patternMatches(patterns: RegExp[], prompt: string) {
  return patterns.filter((pattern) => pattern.test(prompt)).length;
}

function scoreRegistryCandidate(spec: SkillCapabilitySpec, prompt: string, intents: RouteIntentMatch[]) {
  const supportedIntentMatches = intents.filter((intent) => spec.supportedIntents.includes(intent.id));
  const positiveCount = patternMatches(spec.positivePatterns, prompt);
  const negativeCount = patternMatches(spec.negativePatterns, prompt);
  const score = spec.priority
    + supportedIntentMatches.reduce((total, intent) => total + intent.score, 0)
    + positiveCount * 16
    - negativeCount * 40;
  const reasons = [
    ...supportedIntentMatches.map((intent) => `${intent.id} intent +${intent.score}`),
    ...(positiveCount ? [`${positiveCount} positive trigger(s)`] : [])
  ];
  const rejectedReasons = negativeCount ? [`${negativeCount} negative trigger(s)`] : [];
  return {
    skillId: spec.id,
    score,
    intents: supportedIntentMatches.map((intent) => intent.id),
    reasons,
    rejectedReasons,
    selected: false
  } satisfies SkillRouteCandidate;
}

function templateCandidate(skillId: string, template: SkillTemplateLike, prompt: string): SkillRouteCandidate | null {
  const keyword = templateTriggeredSkill(template, prompt);
  if (!keyword) return null;
  return {
    skillId,
    score: TEMPLATE_OVERLAP_SCORE,
    intents: [],
    reasons: [`prompt overlaps skill metadata: ${keyword}`],
    rejectedReasons: [],
    selected: false
  };
}

function localizationOverridesUi(candidate: SkillRouteCandidate, intents: RouteIntentMatch[]) {
  if (candidate.skillId !== "ui-ux-pro-max") return false;
  const intentIds = new Set(intents.map((intent) => intent.id));
  return intentIds.has("localization_review") || intentIds.has("translation_chat");
}

function buildDebug(
  mode: SkillRoutingMode,
  intents: RouteIntentMatch[],
  candidates: SkillRouteCandidate[],
  manualIds: string[],
  notes: string[]
): SkillRouteDebug {
  const selectedCount = candidates.filter((candidate) => candidate.selected).length;
  const rejectedCount = candidates.filter((candidate) => candidate.rejectedReasons.length > 0).length;
  const primaryIntent = primaryRouteIntent(intents);
  return {
    primaryIntent,
    summary: `${primaryIntent}; selected ${selectedCount}/${candidates.length} skill candidate(s)`,
    manualOverride: mode === "manual" && manualIds.length > 0,
    candidateCount: candidates.length,
    selectedCount,
    rejectedCount,
    notes
  };
}

function emptyDecision(mode: SkillRoutingMode, sanitizedPrompt: string, intents: RouteIntentMatch[]): SkillRouteDecision {
  const candidates: SkillRouteCandidate[] = [];
  return {
    mode,
    sanitizedPrompt,
    activeSkillIds: [],
    matches: [],
    intents,
    candidates,
    rejectedSkills: [],
    routeDebug: buildDebug(mode, intents, candidates, [], ["skills disabled"])
  };
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
  const registryIds = skillRegistryEntries().map((spec) => spec.id);
  const knownSkillIds = new Set([...enabled, ...Object.keys(templates), ...registryIds]);
  const manualIds = manualSkillIds(options.prompt, knownSkillIds).filter((id) => enabled.has(id));
  const sanitizedPrompt = stripManualDirectives(options.prompt, manualIds);
  const prompt = sanitizedPrompt || options.prompt;
  const intents = classifyRouteIntents(prompt);

  if (options.settings.skillsEnabled === false) {
    return emptyDecision(mode, sanitizedPrompt, intents);
  }

  const matches: SkillRouteMatch[] = [];
  for (const id of manualIds) {
    addMatch(matches, {
      skillId: id,
      reason: "manual /skill directive",
      source: "manual",
      score: Number.POSITIVE_INFINITY
    });
  }

  const notes: string[] = [];
  const candidates = Array.from(enabled).map((skillId) => {
    const spec = getSkillCapabilitySpec(skillId);
    const registryCandidate = spec ? scoreRegistryCandidate(spec, prompt, intents) : null;
    const metadataCandidate = templates[skillId] ? templateCandidate(skillId, templates[skillId], prompt) : null;
    const candidate = registryCandidate || metadataCandidate || {
      skillId,
      score: 0,
      intents: [],
      reasons: [],
      rejectedReasons: [],
      selected: false
    };
    if (registryCandidate && metadataCandidate) {
      candidate.score += metadataCandidate.score;
      candidate.reasons.push(...metadataCandidate.reasons);
    }
    if (localizationOverridesUi(candidate, intents) && !manualIds.includes(candidate.skillId)) {
      candidate.rejectedReasons.push("translation/localization intent overrides generic UI keyword");
      notes.push("translation/localization intent suppressed ui-ux-pro-max");
    }
    if (manualIds.includes(candidate.skillId) && candidate.rejectedReasons.length > 0) {
      candidate.reasons.push(`manual override ignored rejection: ${candidate.rejectedReasons.join("; ")}`);
      candidate.rejectedReasons = [];
      notes.push(`manual override kept ${candidate.skillId}`);
    }
    return candidate;
  });

  if (mode === "all") {
    for (const candidate of candidates) candidate.selected = true;
    return {
      mode,
      sanitizedPrompt,
      activeSkillIds: Array.from(enabled),
      matches: Array.from(enabled).map((skillId) => ({
        skillId,
        reason: "all mode keeps every selected skill active",
        source: "mode",
        score: candidates.find((candidate) => candidate.skillId === skillId)?.score
      })),
      intents,
      candidates,
      rejectedSkills: candidates
        .filter((candidate) => candidate.rejectedReasons.length > 0)
        .map((candidate) => ({
          skillId: candidate.skillId,
          reason: candidate.rejectedReasons.join("; "),
          score: candidate.score,
          intents: candidate.intents
        })),
      routeDebug: buildDebug(mode, intents, candidates, manualIds, notes)
    };
  }

  if (mode === "manual") {
    for (const candidate of candidates) {
      candidate.selected = manualIds.includes(candidate.skillId);
      if (candidate.selected) candidate.reasons.push("manual override");
    }
    return {
      mode,
      sanitizedPrompt,
      activeSkillIds: matches.map((match) => match.skillId),
      matches,
      intents,
      candidates,
      rejectedSkills: candidates
        .filter((candidate) => candidate.rejectedReasons.length > 0)
        .map((candidate) => ({
          skillId: candidate.skillId,
          reason: candidate.rejectedReasons.join("; "),
          score: candidate.score,
          intents: candidate.intents
        })),
      routeDebug: buildDebug(mode, intents, candidates, manualIds, notes)
    };
  }

  for (const candidate of candidates) {
    candidate.selected = manualIds.includes(candidate.skillId)
      || (candidate.score >= SELECTION_THRESHOLD && candidate.rejectedReasons.length === 0);
    if (!candidate.selected) continue;
    addMatch(matches, {
      skillId: candidate.skillId,
      reason: candidate.reasons.join("; ") || "selected by route registry",
      source: manualIds.includes(candidate.skillId) ? "manual" : "registry",
      intent: candidate.intents[0],
      score: candidate.score
    });
  }

  const rejectedSkills = candidates
    .filter((candidate) => candidate.rejectedReasons.length > 0)
    .map((candidate) => ({
      skillId: candidate.skillId,
      reason: candidate.rejectedReasons.join("; "),
      score: candidate.score,
      intents: candidate.intents
    }));

  return {
    mode,
    sanitizedPrompt,
    activeSkillIds: matches.map((match) => match.skillId),
    matches,
    intents,
    candidates,
    rejectedSkills,
    routeDebug: buildDebug(mode, intents, candidates, manualIds, notes)
  };
}
