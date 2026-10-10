import type { ProviderErrorKind } from "./types.js";

export function classifyProviderError(message: string): ProviderErrorKind {
  const m = message ?? "";

  if (/Unknown LLM_PROVIDER|requires (both )?LLM_|no API key found/i.test(m)) return "config_error";

  const http = /HTTP (\d{3})/i.exec(m);
  if (http) {
    const status = Number(http[1]);
    if (status === 429) {
      return /tokens per day|\bTPD\b|insufficient_quota|quota|billing/i.test(m) ? "quota_exhausted" : "rate_limited";
    }
    if (status === 401 || status === 403) return "auth";
    return "provider_http_error";
  }

  if (/timed? ?out|ETIMEDOUT|AbortError/i.test(m)) return "timeout";
  if (/fetch failed|network request failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|AggregateError/i.test(m)) {
    return "network";
  }
  if (
    /invalid JSON response|missing choices|missing output\.message|missing a string 'action'|is not one of|Unexpected token|JSON/i.test(m)
  ) {
    return "malformed_response";
  }
  return "unknown";
}

export const PROVIDER_ERROR_LABELS: Record<ProviderErrorKind, string> = {
  network: "Network / DNS failure",
  timeout: "Timeout",
  rate_limited: "HTTP 429 rate limit",
  quota_exhausted: "HTTP 429 quota exhausted",
  auth: "Authentication / key",
  provider_http_error: "Provider HTTP error",
  malformed_response: "Malformed provider response",
  config_error: "Configuration error",
  unknown: "Unclassified error",
};
