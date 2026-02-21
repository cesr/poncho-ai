const SLACK_MAX_MESSAGE_LENGTH = 4000;
const MENTION_PATTERN = /^\s*<@[A-Z0-9]+>\s*/i;

/** Strip the leading `<@BOT_ID>` mention from a Slack message. */
export const stripMention = (text: string): string =>
  text.replace(MENTION_PATTERN, "").trim();

/**
 * Split a long message into chunks that fit within Slack's character limit.
 * Attempts to split on newlines, falling back to hard cuts.
 */
export const splitMessage = (text: string): string[] => {
  if (text.length <= SLACK_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let cutPoint = remaining.lastIndexOf(
      "\n",
      SLACK_MAX_MESSAGE_LENGTH,
    );
    if (cutPoint <= 0) {
      cutPoint = SLACK_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, cutPoint));
    remaining = remaining.slice(cutPoint).replace(/^\n/, "");
  }

  return chunks;
};

// ---------------------------------------------------------------------------
// Minimal Slack Web API helpers (avoids @slack/web-api dependency)
// ---------------------------------------------------------------------------

const SLACK_API = "https://slack.com/api";

const slackFetch = async (
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> => {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; error?: string };
};

export const postMessage = async (
  token: string,
  channel: string,
  text: string,
  threadTs: string,
): Promise<void> => {
  const result = await slackFetch("chat.postMessage", token, {
    channel,
    text,
    thread_ts: threadTs,
  });
  if (!result.ok) {
    throw new Error(`Slack chat.postMessage failed: ${result.error}`);
  }
};

export const addReaction = async (
  token: string,
  channel: string,
  timestamp: string,
  reaction: string,
): Promise<void> => {
  const result = await slackFetch("reactions.add", token, {
    channel,
    timestamp,
    name: reaction,
  });
  if (!result.ok && result.error !== "already_reacted") {
    throw new Error(`Slack reactions.add failed: ${result.error}`);
  }
};

export const removeReaction = async (
  token: string,
  channel: string,
  timestamp: string,
  reaction: string,
): Promise<void> => {
  const result = await slackFetch("reactions.remove", token, {
    channel,
    timestamp,
    name: reaction,
  });
  if (!result.ok && result.error !== "no_reaction") {
    throw new Error(`Slack reactions.remove failed: ${result.error}`);
  }
};
