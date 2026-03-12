const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Telegram Bot API object types (subset used by the adapter)
// ---------------------------------------------------------------------------

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  user?: { id: number; username?: string };
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  message_thread_id?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

interface TelegramApiResult {
  ok: boolean;
  result?: unknown;
  description?: string;
}

const telegramFetch = async (
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramApiResult> => {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as TelegramApiResult;
};

const telegramUpload = async (
  token: string,
  method: string,
  formData: FormData,
): Promise<TelegramApiResult> => {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    body: formData,
  });
  return (await res.json()) as TelegramApiResult;
};

// ---------------------------------------------------------------------------
// Bot info
// ---------------------------------------------------------------------------

export const getMe = async (
  token: string,
): Promise<{ id: number; username: string }> => {
  const result = await telegramFetch(token, "getMe", {});
  if (!result.ok) {
    throw new Error(`Telegram getMe failed: ${result.description}`);
  }
  const user = result.result as TelegramUser;
  return { id: user.id, username: user.username ?? "" };
};

// ---------------------------------------------------------------------------
// File download
// ---------------------------------------------------------------------------

export const getFile = async (
  token: string,
  fileId: string,
): Promise<string> => {
  const result = await telegramFetch(token, "getFile", { file_id: fileId });
  if (!result.ok) {
    throw new Error(`Telegram getFile failed: ${result.description}`);
  }
  const file = result.result as { file_id: string; file_path?: string };
  if (!file.file_path) {
    throw new Error("Telegram getFile: no file_path returned");
  }
  return file.file_path;
};

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
};

const inferMediaType = (filePath: string, header: string | null): string => {
  if (header && header !== "application/octet-stream") return header;
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext && EXTENSION_MEDIA_TYPES[ext]) return EXTENSION_MEDIA_TYPES[ext];
  return header ?? "application/octet-stream";
};

export const downloadFile = async (
  token: string,
  filePath: string,
): Promise<{ data: string; mediaType: string }> => {
  const url = `${TELEGRAM_API}/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram file download failed: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mediaType = inferMediaType(filePath, res.headers.get("content-type"));
  return { data: buffer.toString("base64"), mediaType };
};

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

export const sendMessage = async (
  token: string,
  chatId: number | string,
  text: string,
  opts?: { reply_to_message_id?: number; message_thread_id?: number },
): Promise<void> => {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts?.reply_to_message_id) {
    body.reply_parameters = {
      message_id: opts.reply_to_message_id,
      allow_sending_without_reply: true,
    };
  }
  if (opts?.message_thread_id) {
    body.message_thread_id = opts.message_thread_id;
  }
  const result = await telegramFetch(token, "sendMessage", body);
  if (!result.ok) {
    throw new Error(`Telegram sendMessage failed: ${result.description}`);
  }
};

export const sendPhoto = async (
  token: string,
  chatId: number | string,
  photoData: string,
  opts?: {
    caption?: string;
    reply_to_message_id?: number;
    message_thread_id?: number;
    filename?: string;
  },
): Promise<void> => {
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  const blob = new Blob([Buffer.from(photoData, "base64")]);
  formData.append("photo", blob, opts?.filename ?? "photo.jpg");
  if (opts?.caption) formData.append("caption", opts.caption);
  if (opts?.reply_to_message_id) {
    formData.append(
      "reply_parameters",
      JSON.stringify({
        message_id: opts.reply_to_message_id,
        allow_sending_without_reply: true,
      }),
    );
  }
  if (opts?.message_thread_id) {
    formData.append("message_thread_id", String(opts.message_thread_id));
  }
  const result = await telegramUpload(token, "sendPhoto", formData);
  if (!result.ok) {
    throw new Error(`Telegram sendPhoto failed: ${result.description}`);
  }
};

export const sendDocument = async (
  token: string,
  chatId: number | string,
  docData: string,
  opts?: {
    caption?: string;
    reply_to_message_id?: number;
    message_thread_id?: number;
    filename?: string;
    mediaType?: string;
  },
): Promise<void> => {
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  const blob = new Blob([Buffer.from(docData, "base64")], {
    type: opts?.mediaType,
  });
  formData.append("document", blob, opts?.filename ?? "file");
  if (opts?.caption) formData.append("caption", opts.caption);
  if (opts?.reply_to_message_id) {
    formData.append(
      "reply_parameters",
      JSON.stringify({
        message_id: opts.reply_to_message_id,
        allow_sending_without_reply: true,
      }),
    );
  }
  if (opts?.message_thread_id) {
    formData.append("message_thread_id", String(opts.message_thread_id));
  }
  const result = await telegramUpload(token, "sendDocument", formData);
  if (!result.ok) {
    throw new Error(`Telegram sendDocument failed: ${result.description}`);
  }
};

// ---------------------------------------------------------------------------
// Inline keyboard messages
// ---------------------------------------------------------------------------

export const sendMessageWithKeyboard = async (
  token: string,
  chatId: number | string,
  text: string,
  keyboard: TelegramInlineKeyboardButton[][],
  opts?: { reply_to_message_id?: number; message_thread_id?: number },
): Promise<number> => {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  };
  if (opts?.reply_to_message_id) {
    body.reply_parameters = {
      message_id: opts.reply_to_message_id,
      allow_sending_without_reply: true,
    };
  }
  if (opts?.message_thread_id) {
    body.message_thread_id = opts.message_thread_id;
  }
  const result = await telegramFetch(token, "sendMessage", body);
  if (!result.ok) {
    throw new Error(`Telegram sendMessage (keyboard) failed: ${result.description}`);
  }
  const msg = result.result as { message_id: number };
  return msg.message_id;
};

export const editMessageText = async (
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  opts?: { reply_markup?: { inline_keyboard: TelegramInlineKeyboardButton[][] } },
): Promise<void> => {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };
  if (opts?.reply_markup) {
    body.reply_markup = opts.reply_markup;
  }
  const result = await telegramFetch(token, "editMessageText", body);
  if (!result.ok) {
    throw new Error(`Telegram editMessageText failed: ${result.description}`);
  }
};

export const answerCallbackQuery = async (
  token: string,
  callbackQueryId: string,
  opts?: { text?: string },
): Promise<void> => {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };
  if (opts?.text) body.text = opts.text;
  await telegramFetch(token, "answerCallbackQuery", body);
};

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

export const sendChatAction = async (
  token: string,
  chatId: number | string,
  action: string,
): Promise<void> => {
  await telegramFetch(token, "sendChatAction", {
    chat_id: chatId,
    action,
  });
};

// ---------------------------------------------------------------------------
// Message splitting (same pattern as Slack, adapted for 4096 limit)
// ---------------------------------------------------------------------------

export const splitMessage = (text: string): string[] => {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let cutPoint = remaining.lastIndexOf(
      "\n",
      TELEGRAM_MAX_MESSAGE_LENGTH,
    );
    if (cutPoint <= 0) {
      cutPoint = TELEGRAM_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, cutPoint));
    remaining = remaining.slice(cutPoint).replace(/^\n/, "");
  }

  return chunks;
};

// ---------------------------------------------------------------------------
// Mention detection & stripping
// ---------------------------------------------------------------------------

/**
 * Check whether the bot is mentioned in a message's entities.
 * Works with both `@username` mentions and `text_mention` entities.
 */
export const isBotMentioned = (
  entities: TelegramEntity[] | undefined,
  botUsername: string,
  botId: number,
  text: string,
): boolean => {
  if (!entities || entities.length === 0) return false;
  const lower = botUsername.toLowerCase();

  for (const entity of entities) {
    if (entity.type === "mention") {
      const mentioned = text.slice(entity.offset, entity.offset + entity.length);
      if (mentioned.toLowerCase() === `@${lower}`) return true;
    }
    if (entity.type === "text_mention" && entity.user?.id === botId) {
      return true;
    }
  }

  return false;
};

/**
 * Remove the first bot mention from the message text, using entity
 * offsets for accuracy. Falls back to regex if no entity matches.
 */
export const stripMention = (
  text: string,
  entities: TelegramEntity[] | undefined,
  botUsername: string,
  botId: number,
): string => {
  if (!entities || entities.length === 0) return text.trim();
  const lower = botUsername.toLowerCase();

  for (const entity of entities) {
    let match = false;
    if (entity.type === "mention") {
      const mentioned = text.slice(entity.offset, entity.offset + entity.length);
      if (mentioned.toLowerCase() === `@${lower}`) match = true;
    }
    if (entity.type === "text_mention" && entity.user?.id === botId) {
      match = true;
    }
    if (match) {
      return (
        text.slice(0, entity.offset) +
        text.slice(entity.offset + entity.length)
      ).trim();
    }
  }

  return text.trim();
};
