import { timingSafeEqual } from "node:crypto";

/**
 * Verify the Telegram webhook secret token.
 *
 * When registering the webhook via `setWebhook`, a `secret_token` can be
 * provided. Telegram then sends it in the `X-Telegram-Bot-Api-Secret-Token`
 * header on every update. This function compares the expected and received
 * values using timing-safe equality.
 */
export const verifyTelegramSecret = (
  expected: string,
  received: string | undefined,
): boolean => {
  if (!received) return false;
  if (expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
};
