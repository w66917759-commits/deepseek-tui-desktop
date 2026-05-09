export const deepSeekThinkingModes = ["max", "high", "off"] as const;

interface RuntimeStreamEventLike {
  type?: string;
  event?: string;
  delta?: string;
  message?: string;
  detail?: string;
}

export function normalizeDeepSeekThinkingMode(value: unknown): DeepSeekThinkingMode {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "high" || mode === "off" || mode === "max" ? mode : "max";
}

export function formatProcessStreamOutput(output: string) {
  return String(output || "");
}

export function runtimeTurnOutputChunk(event: RuntimeStreamEventLike) {
  const eventType = event.event || event.type || "";
  if (eventType === "response_delta") {
    return typeof event.delta === "string" ? event.delta : typeof event.detail === "string" ? event.detail : "";
  }
  if (eventType === "runtime_stderr") {
    return typeof event.message === "string" ? event.message : typeof event.detail === "string" ? event.detail : "";
  }
  return "";
}
