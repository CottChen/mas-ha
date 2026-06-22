import type { ConversationTurn } from "../types.js";

const USER_REQUEST_MARKER = "[User Request]";
const ASSISTANT_RULES_BLOCK = /\[Assistant Rules[^\]]*\][\s\S]*?\[\/Assistant Rules\]/gi;

export function cleanIncomingUserPrompt(content: string): string {
  const original = normalizeTextBlock(content);
  const markerIndex = original.lastIndexOf(USER_REQUEST_MARKER);
  const withoutMarker = markerIndex >= 0 ? original.slice(markerIndex + USER_REQUEST_MARKER.length) : original;
  const withoutRules = withoutMarker.replace(ASSISTANT_RULES_BLOCK, "").trim();
  if (withoutRules) return withoutRules;
  if (markerIndex >= 0 || /\[Assistant Rules[^\]]*\]/i.test(original)) return "";
  return original;
}

export function sanitizeConversationTurnForPrompt(turn: ConversationTurn): ConversationTurn | undefined {
  const content = turn.role === "user" ? cleanIncomingUserPrompt(turn.content) : normalizeTextBlock(turn.content);
  if (!content.trim()) return undefined;
  return { role: turn.role, content };
}

function normalizeTextBlock(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
