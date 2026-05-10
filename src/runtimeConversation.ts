export interface RuntimeConversationMessage {
  id: string;
  role: "assistant" | "user";
  title?: string;
  content: string;
}

export interface RuntimeConversationTurn {
  item_ids?: string[];
}

export interface RuntimeConversationItem {
  id: string;
  kind: string;
  [key: string]: unknown;
}

export interface RuntimeConversationDetail {
  turns?: RuntimeConversationTurn[];
  items?: RuntimeConversationItem[];
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
