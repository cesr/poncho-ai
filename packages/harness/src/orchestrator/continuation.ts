import type { Conversation } from "../state.js";

export const TOOL_RESULT_ARCHIVE_PARAM = "__toolResultArchive";

export const withToolResultArchiveParam = (
  parameters: Record<string, unknown> | undefined,
  conversation: Conversation,
): Record<string, unknown> => ({
  ...(parameters ?? {}),
  [TOOL_RESULT_ARCHIVE_PARAM]: conversation._toolResultArchive ?? {},
});

export const MAX_CONTINUATION_COUNT = 20;
