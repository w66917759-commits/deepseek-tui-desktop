export interface ContextAnchorRecord {
  id: string;
  text: string;
  createdAt: string;
}

interface RuntimeUserInputQuestionLike {
  id?: string;
  header?: string;
  question?: string;
}

interface RuntimeUserInputAnswerLike {
  id?: string;
  label?: string;
  value?: string;
}

interface RuntimeItemLike {
  kind?: string;
  status?: string;
  metadata?: {
    request?: {
      questions?: RuntimeUserInputQuestionLike[];
    };
    response?: {
      answers?: RuntimeUserInputAnswerLike[];
    } | null;
  } | null;
}

interface MergeDerivedContextAnchorsOptions {
  createId: () => string;
  createdAt?: string;
}

function normalizeAnchorText(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeContextAnchors(
  anchors: ContextAnchorRecord[] | null | undefined,
  maxAnchors = 8
) {
  const items = Array.isArray(anchors) ? anchors : [];
  const deduped = new Map<string, ContextAnchorRecord>();

  for (const anchor of items) {
    const text = normalizeAnchorText(anchor?.text || "");
    if (!text) continue;
    deduped.set(text.toLowerCase(), {
      id: String(anchor?.id || ""),
      text,
      createdAt: String(anchor?.createdAt || "")
    });
  }

  return Array.from(deduped.values()).slice(-Math.max(1, maxAnchors));
}

export function buildAnchoredRuntimePrompt(
  prompt: string,
  anchors: ContextAnchorRecord[] | null | undefined,
  language: "zh" | "en"
) {
  const rawPrompt = normalizeAnchorText(prompt);
  const normalizedAnchors = normalizeContextAnchors(anchors);
  if (!normalizedAnchors.length) return rawPrompt;

  if (language === "zh") {
    return [
      "<desktop_context_anchors>",
      "下面这些是当前任务已经确认、后续不能丢的锚点：",
      ...normalizedAnchors.map((anchor) => `- ${anchor.text}`),
      "</desktop_context_anchors>",
      "",
      rawPrompt
    ].join("\n");
  }

  return [
    "<desktop_context_anchors>",
    "These are pinned context anchors that must remain stable for the current task:",
    ...normalizedAnchors.map((anchor) => `- ${anchor.text}`),
    "</desktop_context_anchors>",
    "",
    rawPrompt
  ].join("\n");
}

export function selectContextAnchorDraft(
  composerText: string,
  latestUserPrompt: string,
  _language: "zh" | "en"
) {
  return normalizeAnchorText(composerText) || normalizeAnchorText(latestUserPrompt) || "";
}

export function deriveContextAnchorTextsFromRuntimeItem(
  item: RuntimeItemLike | null | undefined,
  language: "zh" | "en"
) {
  if (!item || item.kind !== "user_input_request" || item.status !== "completed") {
    return [] as string[];
  }

  const questions = Array.isArray(item.metadata?.request?.questions)
    ? item.metadata?.request?.questions || []
    : [];
  const answers = Array.isArray(item.metadata?.response?.answers)
    ? item.metadata?.response?.answers || []
    : [];
  if (!answers.length) return [] as string[];

  const questionById = new Map<string, RuntimeUserInputQuestionLike>();
  for (const question of questions) {
    const id = String(question?.id || "").trim();
    if (!id) continue;
    questionById.set(id, question);
  }

  return answers
    .map((answer) => {
      const value = normalizeAnchorText(String(answer?.label || answer?.value || ""));
      if (!value) return "";
      const question = questionById.get(String(answer?.id || "").trim());
      const subject = normalizeAnchorText(String(question?.header || question?.question || answer?.id || ""));
      if (language === "zh") {
        return subject ? `已确认：${subject} = ${value}` : `已确认：${value}`;
      }
      return subject ? `Confirmed: ${subject} = ${value}` : `Confirmed: ${value}`;
    })
    .filter(Boolean);
}

export function mergeDerivedContextAnchors(
  anchors: ContextAnchorRecord[] | null | undefined,
  derivedTexts: string[] | null | undefined,
  options: MergeDerivedContextAnchorsOptions
) {
  const existing = normalizeContextAnchors(anchors);
  const knownTexts = new Set(existing.map((anchor) => anchor.text.toLowerCase()));
  const additions = (Array.isArray(derivedTexts) ? derivedTexts : [])
    .map((value) => normalizeAnchorText(value))
    .filter((value) => value && !knownTexts.has(value.toLowerCase()))
    .map((text) => {
      knownTexts.add(text.toLowerCase());
      return {
        id: options.createId(),
        text,
        createdAt: String(options.createdAt || new Date().toISOString())
      };
    });

  if (!additions.length) return existing;
  return normalizeContextAnchors([...existing, ...additions]);
}

export function deriveContextAnchorTextsFromRuntimeItems(
  items: RuntimeItemLike[] | null | undefined,
  language: "zh" | "en"
) {
  return (Array.isArray(items) ? items : [])
    .flatMap((item) => deriveContextAnchorTextsFromRuntimeItem(item, language))
    .filter(Boolean);
}
