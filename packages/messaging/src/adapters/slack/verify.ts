import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_DRIFT_SECONDS = 300; // 5 minutes

/**
 * Verify a Slack request signature per
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export const verifySlackSignature = (
  signingSecret: string,
  headers: {
    signature: string | undefined;
    timestamp: string | undefined;
  },
  rawBody: string,
): boolean => {
  const { signature, timestamp } = headers;
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return false;

  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (drift > MAX_TIMESTAMP_DRIFT_SECONDS) return false;

  const basestring = `v0:${timestamp}:${rawBody}`;
  const computed = `v0=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;

  if (computed.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
};
