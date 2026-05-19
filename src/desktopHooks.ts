export type DesktopHookName =
  | "beforePromptRoute"
  | "afterSkillRoute"
  | "afterTurnComplete"
  | "afterAgentStateChange";

export interface DesktopHookEvent {
  id: string;
  name: DesktopHookName;
  at: string;
  summary: string;
  payload: Record<string, unknown>;
}

export function createDesktopHookEvent(
  name: DesktopHookName,
  summary: string,
  payload: Record<string, unknown> = {}
): DesktopHookEvent {
  return {
    id: `hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    at: new Date().toISOString(),
    summary,
    payload
  };
}

export function appendDesktopHookEvent(
  events: DesktopHookEvent[],
  name: DesktopHookName,
  summary: string,
  payload: Record<string, unknown> = {},
  maxEvents = 40
) {
  return [...events, createDesktopHookEvent(name, summary, payload)].slice(-maxEvents);
}
