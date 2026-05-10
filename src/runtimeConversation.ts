export interface RuntimeConversationMessage {
  id: string;
  role: "assistant" | "user";
  title?: string;
  content: string;
}

export interface RuntimeConversationTurn {
  item_ids?: string[];
  status?: string;
}

export interface RuntimeConversationItem {
  id: string;
  kind: string;
  [key: string]: unknown;
}

export interface RuntimeConversationDetail {
  thread?: {
    id?: string;
    [key: string]: unknown;
  };
  turns?: RuntimeConversationTurn[];
  items?: RuntimeConversationItem[];
  latest_seq?: number;
}

export interface RuntimeContextHealthSummary {
  layeredContextEnabled: boolean;
  latestSeq: number;
  latestTurnStatus: string;
  latestUserPrompt: string;
  seamCount: number;
  compactionCount: number;
  pendingApprovals: number;
  pendingUserInputs: number;
  recallAvailable: boolean;
}

export function orderedRuntimeConversationItems(detail: RuntimeConversationDetail | null | undefined) {
  if (!detail) return [] as RuntimeConversationItem[];
  const items = Array.isArray(detail.items) ? detail.items : [];
  const turns = Array.isArray(detail.turns) ? detail.turns : [];
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const ordered: RuntimeConversationItem[] = [];
  const seen = new Set<string>();

  for (const turn of turns) {
    for (const itemId of turn.item_ids || []) {
      const item = itemMap.get(itemId);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      ordered.push(item);
    }
  }

  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    ordered.push(item);
  }

  return ordered;
}

export function shouldRenderRuntimeConversation(detail: RuntimeConversationDetail | null | undefined) {
  return orderedRuntimeConversationItems(detail).length > 0;
}

export function appendRuntimePromptMessages(
  messages: RuntimeConversationMessage[],
  prompt: string,
  language: "zh" | "en",
  createId: () => string
) {
  const text = prompt.trim();
  if (!text) return messages.slice();
  return [
    ...messages,
    {
      id: createId(),
      role: "user",
      content: text
    },
    {
      id: createId(),
      role: "assistant",
      title: language === "zh" ? "运行时" : "Runtime",
      content: language === "zh" ? "正在等待运行时回复…" : "Waiting for runtime response..."
    }
  ];
}

export function conversationMessagesFromRuntimeDetail(detail: RuntimeConversationDetail | null | undefined) {
  return orderedRuntimeConversationItems(detail)
    .filter((item) => item.kind === "user_message" || item.kind === "agent_message")
    .map((item) => ({
      id: item.id,
      role: item.kind === "user_message" ? "user" : "assistant",
      content: String(item.detail || item.summary || "")
    })) as RuntimeConversationMessage[];
}

function itemText(item: RuntimeConversationItem) {
  return String(item.detail || item.summary || "").trim();
}

function isSeamItem(item: RuntimeConversationItem) {
  const text = itemText(item);
  return /<archived_context\b/i.test(text) || /\bL[123]\s+seam\b/i.test(text);
}

export function summarizeRuntimeContextHealth(
  detail: RuntimeConversationDetail | null | undefined,
  layeredContextEnabled: boolean
): RuntimeContextHealthSummary {
  const orderedItems = orderedRuntimeConversationItems(detail);
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  const latestTurn = turns.at(-1);
  const latestUserPrompt = [...orderedItems]
    .reverse()
    .find((item) => item.kind === "user_message");

  const seamCount = orderedItems.filter((item) => isSeamItem(item)).length;
  const compactionCount = orderedItems.filter((item) => item.kind === "context_compaction").length;
  const pendingApprovals = orderedItems.filter((item) => item.kind === "approval_request" && item.status === "in_progress").length;
  const pendingUserInputs = orderedItems.filter((item) => item.kind === "user_input_request" && item.status === "in_progress").length;

  return {
    layeredContextEnabled,
    latestSeq: Number(detail?.latest_seq || 0),
    latestTurnStatus: String(latestTurn?.status || ""),
    latestUserPrompt: latestUserPrompt ? itemText(latestUserPrompt) : "",
    seamCount,
    compactionCount,
    pendingApprovals,
    pendingUserInputs,
    recallAvailable: seamCount > 0 || compactionCount > 0 || Number(detail?.latest_seq || 0) > 0
  };
}

export function buildRecallArchivePrompt(topic: string, language: "zh" | "en") {
  const trimmed = topic.trim();
  if (language === "zh") {
    return [
      "请优先使用 `recall_archive` 工具，从当前任务之前归档的长上下文里找回与下面主题最相关的信息。",
      "重点提取：已确认决策、约束、修改过的文件、失败过的尝试，以及下一步应延续的方向。",
      "不要凭猜测补全；如果归档中没有足够信息，请明确说明缺失点。",
      "",
      `主题：${trimmed || "当前任务"}`
    ].join("\n");
  }
  return [
    "Use the `recall_archive` tool first and recover the archived context most relevant to the topic below.",
    "Focus on decisions, constraints, files, and failed approaches that the current task should continue from.",
    "Do not guess beyond the archive. If the archive does not contain enough detail, say what is missing.",
    "",
    `Topic: ${trimmed || "current task"}`
  ].join("\n");
}
