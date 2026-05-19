import {
  orderedRuntimeConversationItems,
  type RuntimeConversationDetail,
  type RuntimeConversationItem
} from "./runtimeConversation";

export type RuntimeTimelineKind =
  | "user"
  | "finalAnswer"
  | "action"
  | "toolCall"
  | "question"
  | "approval"
  | "error"
  | "raw";

export interface RuntimeTimelineEntry {
  id: string;
  kind: RuntimeTimelineKind;
  sourceKind: string;
  status: string;
  title: string;
  text: string;
  item: RuntimeConversationItem;
}

export interface RuntimeTimeline {
  finalAnswer: RuntimeTimelineEntry[];
  actions: RuntimeTimelineEntry[];
  toolCalls: RuntimeTimelineEntry[];
  questions: RuntimeTimelineEntry[];
  approvals: RuntimeTimelineEntry[];
  errors: RuntimeTimelineEntry[];
  rawStream: RuntimeTimelineEntry[];
  mainEntries: RuntimeTimelineEntry[];
}

function itemText(item: RuntimeConversationItem) {
  return String(item.detail || item.summary || "").trim();
}

function itemStatus(item: RuntimeConversationItem) {
  return String(item.status || "");
}

function timelineTitle(item: RuntimeConversationItem, kind: RuntimeTimelineKind) {
  if (kind === "finalAnswer") return "Answer";
  if (kind === "action") return "Action";
  if (kind === "toolCall") return "Tool";
  if (kind === "question") return "Question";
  if (kind === "approval") return "Approval";
  if (kind === "error") return "Error";
  if (kind === "user") return "User";
  return "Raw";
}

function timelineKindForItem(item: RuntimeConversationItem): RuntimeTimelineKind {
  if (item.kind === "user_message") return "user";
  if (item.kind === "agent_message") return "finalAnswer";
  if (item.kind === "tool_call") return "toolCall";
  if (item.kind === "approval_request") return "approval";
  if (item.kind === "user_input_request") return "question";
  if (item.kind === "error") return "error";
  if (item.kind === "file_change" || item.kind === "command_execution" || item.kind === "status") {
    return "action";
  }
  return "raw";
}

function makeEntry(item: RuntimeConversationItem): RuntimeTimelineEntry {
  const kind = timelineKindForItem(item);
  return {
    id: item.id,
    kind,
    sourceKind: item.kind,
    status: itemStatus(item),
    title: timelineTitle(item, kind),
    text: itemText(item),
    item
  };
}

export function buildRuntimeTimeline(detail: RuntimeConversationDetail | null | undefined): RuntimeTimeline {
  const entries = orderedRuntimeConversationItems(detail).map(makeEntry);
  const finalAnswer = entries.filter((entry) => entry.kind === "finalAnswer" && entry.text);
  const actions = entries.filter((entry) => entry.kind === "action" && entry.text);
  const toolCalls = entries.filter((entry) => entry.kind === "toolCall");
  const questions = entries.filter((entry) => entry.kind === "question");
  const approvals = entries.filter((entry) => entry.kind === "approval");
  const errors = entries.filter((entry) => entry.kind === "error");
  const rawStream = entries.filter((entry) => entry.kind === "raw" || entry.kind === "toolCall" || entry.kind === "action");
  const visibleInteractive = entries.filter((entry) => (
    entry.kind === "user"
    || entry.kind === "finalAnswer"
    || entry.kind === "question"
    || entry.kind === "approval"
    || entry.kind === "error"
  ));

  return {
    finalAnswer,
    actions,
    toolCalls,
    questions,
    approvals,
    errors,
    rawStream,
    mainEntries: visibleInteractive
  };
}
