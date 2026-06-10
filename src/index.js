const DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";
const DEFAULT_TIMEZONE = "Asia/Singapore";
const DEFAULT_STALE_SECONDS = 900;
const CACHE_KEY = "usage:latest";
const ERROR_KEY = "usage:last_error";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/usage") {
        return await handleUsageRequest(env, ctx);
      }

      if (url.pathname === "/api/refresh" && request.method === "POST") {
        return await handleRefreshRequest(request, env);
      }

      if (url.pathname !== "/" && url.pathname !== "/index.html") {
        return jsonResponse({ error: "Not found" }, 404);
      }

      return new Response(renderHtml(), {
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": "no-store"
        }
      });
    } catch (error) {
      if (url.pathname.startsWith("/api/")) {
        return jsonResponse(
          {
            error: "Worker request failed.",
            details: getErrorMessage(error),
            debug: getErrorDebug(error)
          },
          500
        );
      }

      return new Response(renderHtml(), {
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": "no-store"
        }
      });
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshUsage(env, "scheduled"));
  }
};

async function handleUsageRequest(env, ctx) {
  assertRequiredEnv(env);
  const cache = getCacheBinding(env);

  const cached = await readJson(cache, CACHE_KEY);
  const lastError = await readJson(cache, ERROR_KEY);

  if (!cached) {
    try {
      const snapshot = await refreshUsage(env, "cache-miss");
      return jsonResponse(buildUsagePayload(snapshot, null, false, env), 200);
    } catch (error) {
      return jsonResponse(
        {
          error: "No cached snapshot available yet.",
          details: error.message,
          debug: getErrorDebug(error),
          suggestion: "Wait for the scheduled job or trigger POST /api/refresh with a valid refresh token."
        },
        503
      );
    }
  }

  const staleAfterSeconds = parsePositiveInt(env.CACHE_STALE_AFTER_SECONDS, DEFAULT_STALE_SECONDS);
  const refreshedAtMs = Date.parse(cached.refreshed_at);
  const ageSeconds = Number.isNaN(refreshedAtMs)
    ? staleAfterSeconds + 1
    : Math.max(0, Math.floor((Date.now() - refreshedAtMs) / 1000));
  const isStale = ageSeconds > staleAfterSeconds;

  if (isStale) {
    ctx.waitUntil(refreshUsage(env, "stale-read").catch(() => undefined));
  }

  return jsonResponse(buildUsagePayload(cached, lastError, isStale, env), 200);
}

async function handleRefreshRequest(request, env) {
  assertRequiredEnv(env);

  const refreshToken = env.REFRESH_TOKEN;
  if (!refreshToken) {
    return jsonResponse(
      { error: "Manual refresh is disabled. Configure REFRESH_TOKEN to enable it." },
      403
    );
  }

  const authHeader = request.headers.get("authorization") || "";
  if (authHeader !== `Bearer ${refreshToken}`) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    const snapshot = await refreshUsage(env, "manual");
    return jsonResponse(buildUsagePayload(snapshot, null, false, env), 200);
  } catch (error) {
    return jsonResponse(
      {
        error: "Manual refresh failed.",
        details: error.message,
        debug: getErrorDebug(error)
      },
      502
    );
  }
}

async function refreshUsage(env, source) {
  assertRequiredEnv(env);

  const cache = getCacheBinding(env);
  const config = getConfig(env);
  const authToken = getAuthToken(env);
  const queryParams = buildTimeRangeQuery(config.timeZone);
  const upstreamRequests = [
    {
      label: "model_usage",
      url: `${config.baseDomain}/api/monitor/usage/model-usage`
    },
    {
      label: "tool_usage",
      url: `${config.baseDomain}/api/monitor/usage/tool-usage`
    },
    {
      label: "quota_limit",
      url: `${config.baseDomain}/api/monitor/usage/quota/limit`,
      queryParams: "",
      postProcessor: processQuotaLimit
    }
  ];

  try {
    const results = await Promise.allSettled(
      upstreamRequests.map((request) =>
        queryUsage(
          request.url,
          authToken,
          request.queryParams ?? queryParams,
          request.postProcessor,
          request.label
        )
      )
    );
    const [modelResult, toolResult, quotaResult] = results;
    const requiredFailures = [modelResult, toolResult].filter((result) => result.status === "rejected");

    if (requiredFailures.length > 0) {
      const errorMessage = requiredFailures.map((result) => result.reason.message).join(" | ");
      const debugEntries = requiredFailures
        .map((result) => getErrorDebug(result.reason))
        .filter(Boolean);

      throw createDebugError(
        errorMessage,
        debugEntries.length <= 1 ? debugEntries[0] || null : { failures: debugEntries }
      );
    }

    const modelUsage = modelResult.value;
    const toolUsage = toolResult.value;
    const partialFailures = {};

    let quotaLimit = null;
    if (quotaResult.status === "fulfilled") {
      quotaLimit = quotaResult.value;
    } else {
      partialFailures.quota_limit = {
        message: quotaResult.reason.message,
        debug: getErrorDebug(quotaResult.reason)
      };
    }

    const snapshot = {
      source,
      platform: config.platform,
      query_time: formatDateTime(new Date(), config.timeZone),
      time_range: queryParams.range,
      refreshed_at: new Date().toISOString(),
      model_usage: modelUsage,
      tool_usage: toolUsage,
      quota_limit: quotaLimit,
      partial_failures: Object.keys(partialFailures).length > 0 ? partialFailures : null
    };

    await cache.put(CACHE_KEY, JSON.stringify(snapshot));
    await cache.delete(ERROR_KEY);

    return snapshot;
  } catch (error) {
    const errorSnapshot = {
      message: error.message,
      happened_at: new Date().toISOString(),
      source,
      debug: getErrorDebug(error)
    };
    await cache.put(ERROR_KEY, JSON.stringify(errorSnapshot));
    throw error;
  }
}

function getConfig(env) {
  const baseUrl = env.ZAI_BASE_URL || DEFAULT_BASE_URL;
  const parsed = new URL(baseUrl);
  const baseDomain = `${parsed.protocol}//${parsed.host}`;

  let platform = "ZAI";
  if (baseUrl.includes("open.bigmodel.cn") || baseUrl.includes("dev.bigmodel.cn")) {
    platform = "ZHIPU";
  } else if (!baseUrl.includes("api.z.ai")) {
    throw new Error(`Unsupported ZAI_BASE_URL: ${baseUrl}`);
  }

  return {
    platform,
    baseDomain,
    timeZone: env.ZAI_TIMEZONE || DEFAULT_TIMEZONE
  };
}

function buildTimeRangeQuery(timeZone) {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const startParts = getDateTimeParts(start, timeZone);
  const endParts = getDateTimeParts(end, timeZone);
  const range = {
    start: `${startParts.year}-${startParts.month}-${startParts.day} ${startParts.hour}:00:00`,
    end: `${endParts.year}-${endParts.month}-${endParts.day} ${endParts.hour}:59:59`
  };

  return {
    search: `?startTime=${encodeURIComponent(range.start)}&endTime=${encodeURIComponent(range.end)}`,
    range
  };
}

async function queryUsage(url, token, queryParams, postProcessor, label = "upstream") {
  const querySuffix = typeof queryParams === "string"
    ? queryParams
    : typeof queryParams?.search === "string"
      ? queryParams.search
      : "";
  const requestUrl = `${url}${querySuffix}`;
  const requestProfiles = buildRequestProfiles(token, label);
  let lastError = null;
  const attempts = [];

  for (let index = 0; index < requestProfiles.length; index += 1) {
    const profile = requestProfiles[index];
    const response = await fetch(requestUrl, {
      headers: profile.headers,
      method: "GET",
      cache: "no-store"
    });

    const body = await response.text();
    const statusText = response.statusText || "Unknown status";
    const responseHeaders = summarizeUpstreamHeaders(response);
    const attempt = {
      label,
      profile: profile.name,
      request_url: requestUrl,
      request_headers: summarizeRequestHeaders(profile.headers),
      response_status: response.status,
      response_status_text: statusText,
      response_headers: responseHeaders,
      response_body: truncateBody(body)
    };
    attempts.push(attempt);
    const upstreamDetails = summarizeUpstreamDetails(responseHeaders);

    if (!response.ok) {
      lastError = createDebugError(
        `[${label}] Upstream request failed: ${response.status} ${statusText} [profile=${profile.name}]${upstreamDetails} ${summarizeBody(body)}`,
        {
          label,
          request_url: requestUrl,
          attempts: attempts.slice()
        }
      );
      if (shouldRetryRequest(label, response.status, index, requestProfiles.length)) {
        continue;
      }
      throw lastError;
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw createDebugError(
        `[${label}] Upstream API did not return JSON: ${summarizeBody(body)}`,
        {
          label,
          request_url: requestUrl,
          attempts: attempts.slice()
        }
      );
    }

    if (json?.code && json.code !== 200) {
      lastError = createDebugError(
        `[${label}] Upstream API error: ${json.code} ${json.msg || summarizeBody(body)} [profile=${profile.name}]${upstreamDetails}`,
        {
          label,
          request_url: requestUrl,
          attempts: attempts.slice(),
          upstream_payload: json
        }
      );
      if (shouldRetryRequest(label, 400, index, requestProfiles.length)) {
        continue;
      }
      throw lastError;
    }
    if (json?.success === false) {
      lastError = createDebugError(
        `[${label}] Upstream API error: ${json.msg || summarizeBody(body)} [profile=${profile.name}]${upstreamDetails}`,
        {
          label,
          request_url: requestUrl,
          attempts: attempts.slice(),
          upstream_payload: json
        }
      );
      if (shouldRetryRequest(label, 400, index, requestProfiles.length)) {
        continue;
      }
      throw lastError;
    }

    const data = json.data || json;
    return postProcessor ? postProcessor(data) : data;
  }

  throw lastError || new Error(`[${label}] Upstream request failed after retries.`);
}

function processQuotaLimit(data) {
  if (!data || !Array.isArray(data.limits)) {
    return data;
  }

  return {
    ...data,
    limits: data.limits.map((item) => {
      if (item.type === "TOKENS_LIMIT") {
        return {
          type: "Token usage (5 Hour)",
          percentage: item.percentage,
          currentValue: item.currentValue,
          limit: item.limit
        };
      }

      if (item.type === "TIME_LIMIT") {
        return {
          type: "MCP usage (1 Month)",
          percentage: item.percentage,
          currentUsage: item.currentValue,
          total: item.usage,
          usageDetails: item.usageDetails
        };
      }

      return item;
    })
  };
}

async function readJson(kv, key) {
  const value = await kv.get(key);
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildUsagePayload(snapshot, lastError, isStale, env) {
  const refreshedAtMs = Date.parse(snapshot.refreshed_at);
  const ageSeconds = Number.isNaN(refreshedAtMs)
    ? null
    : Math.max(0, Math.floor((Date.now() - refreshedAtMs) / 1000));
  const hasPartialFailures = Boolean(snapshot.partial_failures && Object.keys(snapshot.partial_failures).length > 0);

  return {
    status: isStale ? "stale" : hasPartialFailures ? "partial" : "fresh",
    cache: {
      key: CACHE_KEY,
      refreshed_at: snapshot.refreshed_at,
      age_seconds: ageSeconds,
      stale_after_seconds: parsePositiveInt(env.CACHE_STALE_AFTER_SECONDS, DEFAULT_STALE_SECONDS)
    },
    last_error: lastError,
    partial_failures: snapshot.partial_failures || null,
    data: snapshot
  };
}

function getCacheBinding(env) {
  return env.USAGE_CACHE || env.whosyourdaddy_cache_key || env.KV_BINDING || null;
}

function assertRequiredEnv(env) {
  if (!getCacheBinding(env)) {
    throw new Error("KV binding is required. Expected one of: USAGE_CACHE, whosyourdaddy_cache_key, KV_BINDING.");
  }
  getAuthToken(env);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDateTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function formatDateTime(date, timeZone) {
  const parts = getDateTimeParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getErrorDebug(error) {
  return error && typeof error === "object" && "debug" in error ? error.debug : null;
}

function createDebugError(message, debug) {
  const error = new Error(message);
  error.debug = debug;
  return error;
}

function getAuthToken(env) {
  const rawToken = (env.ZAI_PLAN_TOKEN || env.Z_AI_PLAN_TOKEN || "").trim();
  if (!rawToken) {
    throw new Error("Secret ZAI_PLAN_TOKEN is required. Alias Z_AI_PLAN_TOKEN is also supported.");
  }

  return rawToken.replace(/^Bearer\s+/i, "").trim();
}

function summarizeBody(body) {
  const normalized = (body || "").replace(/\s+/g, " ").trim();
  return normalized || "empty response body";
}

function truncateBody(body, maxLength = 2000) {
  if (!body) {
    return "";
  }

  return body.length > maxLength ? `${body.slice(0, maxLength)}…` : body;
}

function buildRequestProfiles(token, label) {
  const standardHeaders = {
    Authorization: `Bearer ${token}`,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json"
  };

  if (label !== "quota_limit") {
    return [{ name: "standard", headers: standardHeaders }];
  }

  return [
    { name: "standard", headers: standardHeaders },
    {
      name: "no-content-type",
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    },
    {
      name: "auth-only",
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  ];
}

function shouldRetryRequest(label, status, index, totalProfiles) {
  return label === "quota_limit" && status === 400 && index < totalProfiles - 1;
}

function summarizeRequestHeaders(headers) {
  const summary = {};

  if (headers.Authorization) {
    summary.Authorization = "Bearer <redacted>";
  }
  if (headers.Accept) {
    summary.Accept = headers.Accept;
  }
  if (headers["Accept-Language"]) {
    summary["Accept-Language"] = headers["Accept-Language"];
  }
  if (headers["Content-Type"]) {
    summary["Content-Type"] = headers["Content-Type"];
  }

  return summary;
}

function summarizeUpstreamHeaders(response) {
  const headers = {};

  if (response.headers.get("x-log-id")) {
    headers["x-log-id"] = response.headers.get("x-log-id");
  }
  if (response.headers.get("content-type")) {
    headers["content-type"] = response.headers.get("content-type");
  }

  return headers;
}

function summarizeUpstreamDetails(responseHeaders) {
  const details = [
    responseHeaders["x-log-id"] ? `x-log-id=${responseHeaders["x-log-id"]}` : null,
    responseHeaders["content-type"] ? `content-type=${responseHeaders["content-type"]}` : null
  ].filter(Boolean);

  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>whosyourdaddy</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7ead2;
        --paper: rgba(255, 249, 237, 0.94);
        --paper-strong: #fffaf0;
        --ink: #26150f;
        --muted: #7e5d42;
        --line: rgba(122, 78, 38, 0.2);
        --gold: #c79a3b;
        --gold-deep: #8b6222;
        --scarlet: #8f1d1d;
        --accent: #ae1f24;
        --warn: #b16800;
        --danger: #8b0f12;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Baskerville", "Times New Roman", "Songti SC", "STSong", serif;
        background:
          radial-gradient(circle at top, rgba(255, 235, 184, 0.55), transparent 32%),
          linear-gradient(180deg, #7f1718 0%, #b3382f 16%, #edd7ab 16.1%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        max-width: 1080px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      .hero, .panel {
        background: var(--paper);
        border: 1px solid var(--line);
        border-radius: 22px;
        box-shadow:
          0 22px 48px rgba(71, 28, 18, 0.12),
          inset 0 0 0 1px rgba(255, 255, 255, 0.45);
        backdrop-filter: blur(8px);
      }
      .hero {
        position: relative;
        overflow: hidden;
        padding: 30px 30px 28px;
        margin-bottom: 20px;
      }
      .hero::before {
        content: "";
        position: absolute;
        inset: 10px;
        border: 1px solid rgba(199, 154, 59, 0.38);
        border-radius: 16px;
        pointer-events: none;
      }
      .hero-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 12px;
      }
      .eyebrow {
        margin: 0;
        font-size: 0.86rem;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: var(--gold-deep);
      }
      .seal {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 52px;
        border-radius: 999px;
        background:
          radial-gradient(circle at 30% 30%, #db4a40 0%, var(--scarlet) 70%);
        color: #fff5ea;
        font-size: 1.25rem;
        font-weight: 700;
        box-shadow: inset 0 0 0 2px rgba(255, 214, 170, 0.28);
      }
      .hero h1 {
        margin: 0 0 10px;
        font-size: clamp(2.3rem, 5vw, 4.5rem);
        line-height: 0.95;
        letter-spacing: 0.02em;
      }
      .hero p {
        margin: 0;
        color: var(--muted);
        max-width: 720px;
        font-size: 1rem;
        line-height: 1.7;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 16px;
        margin-bottom: 20px;
      }
      .panel {
        padding: 20px 18px;
      }
      .kicker {
        margin: 0 0 10px;
        font-size: 0.8rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .big {
        font-size: 1.95rem;
        margin: 0;
        line-height: 1.2;
      }
      .meta {
        color: var(--muted);
        font-size: 0.95rem;
        line-height: 1.45;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 10px 0;
        border-bottom: 1px solid rgba(122, 78, 38, 0.18);
        font-size: 0.95rem;
      }
      th {
        color: var(--muted);
        font-weight: 600;
      }
      .status-fresh { color: var(--accent); }
      .status-stale { color: var(--warn); }
      .status-partial { color: var(--warn); }
      .status-error { color: var(--danger); }
      .note {
        margin-top: 20px;
        padding: 16px 18px;
        border-radius: 18px;
        background: linear-gradient(135deg, rgba(143, 29, 29, 0.08), rgba(199, 154, 59, 0.14));
        border: 1px solid rgba(143, 29, 29, 0.12);
        color: #6e402b;
        font-size: 0.95rem;
        line-height: 1.6;
      }
      .debug-panel {
        margin-top: 20px;
      }
      .debug-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .debug-meta {
        color: var(--muted);
        font-size: 0.9rem;
      }
      .debug-pre {
        margin: 0;
        padding: 14px;
        border-radius: 16px;
        background: rgba(38, 21, 15, 0.92);
        color: #f8ead0;
        border: 1px solid rgba(199, 154, 59, 0.22);
        font-size: 0.84rem;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-x: auto;
      }
      @media (max-width: 680px) {
        main {
          padding: 20px 14px 38px;
        }
        .hero {
          padding: 22px 18px;
        }
        .hero-top {
          align-items: flex-start;
        }
        .seal {
          width: 44px;
          height: 44px;
          font-size: 1.05rem;
        }
        .big {
          font-size: 1.75rem;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="hero-top">
          <p class="eyebrow">御前赏册</p>
          <span class="seal">敕</span>
        </div>
        <h1>MAKE BI GREATE AGAIN</h1>
        <p>皇恩既下，百臣分赏。此卷只读天家库藏，每五分钟重录一次封赏用量，不使群臣频频惊扰上游。承熙六年钦此。</p>
      </section>

      <section class="grid">
        <article class="panel">
          <p class="kicker">圣眷状态</p>
          <p class="big" id="status">Loading...</p>
          <p class="meta" id="status-meta"></p>
        </article>
        <article class="panel">
          <p class="kicker">御前平台</p>
          <p class="big" id="platform">-</p>
          <p class="meta" id="query-time"></p>
        </article>
        <article class="panel">
          <p class="kicker">册封时辰</p>
          <p class="big" id="window">-</p>
          <p class="meta" id="window-meta"></p>
        </article>
      </section>

      <section class="panel" style="margin-bottom: 20px;">
        <p class="kicker">恩赏额度</p>
        <table>
          <thead>
            <tr><th>Type</th><th>Usage</th><th>Percent</th></tr>
          </thead>
          <tbody id="quota-body"></tbody>
        </table>
      </section>

      <section class="grid">
        <article class="panel">
          <p class="kicker">受赏模型</p>
          <table>
            <thead>
              <tr><th>Model</th><th>Calls</th><th>Tokens</th></tr>
            </thead>
            <tbody id="models-body"></tbody>
          </table>
        </article>
        <article class="panel">
          <p class="kicker">奉旨器具</p>
          <table>
            <thead>
              <tr><th>Tool</th><th>Calls</th><th>MCP</th></tr>
            </thead>
            <tbody id="tools-body"></tbody>
          </table>
        </article>
      </section>

      <section class="note">
        此页只呈缓存抄本。若卷宗稍旧，Worker 会在后台续写新诏，前台仍先奉上最近一次可读的赏册。
      </section>

      <section class="panel debug-panel" id="debug-panel" hidden>
        <div class="debug-head">
          <p class="kicker" style="margin: 0;">诊断卷宗</p>
          <span class="debug-meta" id="debug-meta">未启封</span>
        </div>
        <pre class="debug-pre" id="debug-pre"></pre>
      </section>
    </main>

    <script>
      const byId = (id) => document.getElementById(id);

      function toChineseEraYear(year) {
        const eraMap = {
          2021: '承熙元年', 2022: '承熙二年', 2023: '承熙三年',
          2024: '承熙四年', 2025: '承熙五年', 2026: '承熙六年',
          2027: '承熙七年', 2028: '承熙八年', 2029: '承熙九年',
          2030: '承熙十年'
        };
        return eraMap[year] || year + '年';
      }

      function toChineseEraKe(hour, minute) {
        var shiNames = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
        var shiIdx = Math.floor(((hour + 1) % 24) / 2);
        var offsetMin = ((hour - (shiIdx * 2 - 1 + 24) % 24 + 24) % 24) * 60 + minute;
        var keIdx = Math.floor(offsetMin / 15);
        var ban = keIdx < 4 ? '初' : '正';
        var ke = keIdx % 4;
        var keNames = ['初刻','一刻','二刻','三刻'];
        return shiNames[shiIdx] + '时' + ban + keNames[ke];
      }

      function toChineseEraDate(isoOrTimestamp) {
        var d = new Date(isoOrTimestamp);
        if (isNaN(d.getTime())) return isoOrTimestamp || '-';
        var y = d.getFullYear();
        var m = d.getMonth() + 1;
        var day = d.getDate();
        var monthNames = ['', '正月','二月','三月','四月','五月','六月','七月','八月','九月','十月','冬月','腊月'];
        return toChineseEraYear(y) + monthNames[m] + day + '日 ' + toChineseEraKe(d.getHours(), d.getMinutes());
      }

      function toChineseEraDatetime(s) {
        if (!s) return '-';
        var m = s.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
        if (!m) return s;
        var year = parseInt(m[1], 10);
        var mon = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var hour = parseInt(m[4], 10);
        var min = parseInt(m[5], 10);
        var monthNames = ['', '正月','二月','三月','四月','五月','六月','七月','八月','九月','十月','冬月','腊月'];
        return toChineseEraYear(year) + (monthNames[mon] || m[2] + '月') + day + '日 ' + toChineseEraKe(hour, min);
      }

      const renderRows = (target, rows, columns) => {
        target.innerHTML = rows.length
          ? rows.map((row) => "<tr>" + columns.map((column) => "<td>" + (row[column] ?? "-") + "</td>").join("") + "</tr>").join("")
          : "<tr><td colspan='" + columns.length + "'>No data</td></tr>";
      };

      async function load() {
        let rawText = "";

        try {
          const response = await fetch("/api/usage", { cache: "no-store" });
          rawText = await response.text();
          let payload;

          try {
            payload = JSON.parse(rawText);
          } catch {
            const snippet = rawText.slice(0, 160).replace(/\\s+/g, " ").trim();
            throw new Error("API did not return JSON. " + (snippet || response.status + " " + response.statusText));
          }

          renderDebugPanel(payload.debug || payload.last_error?.debug || null, {
            api_path: "/api/usage",
            api_status: response.status,
            api_status_text: response.statusText
          });

          if (!response.ok) {
            throw new Error(payload.details || payload.error || ("API request failed with status " + response.status));
          }

          const snapshot = payload.data;
          if (!snapshot) {
            throw new Error("API response is missing data payload.");
          }

          byId("status").textContent = displayStatusText(payload.status);
          byId("status").className = "big " + statusClassName(payload.status);
          byId("status-meta").textContent = "上次颁诏 " + toChineseEraDate(payload.cache.refreshed_at) + " · 卷龄 " + (payload.cache.age_seconds ?? "-") + "s";
          byId("platform").textContent = snapshot.platform || "-";
          byId("query-time").textContent = "记档时刻：" + toChineseEraDatetime(snapshot.query_time);
          byId("window").innerHTML = snapshot.time_range ? toChineseEraDatetime(snapshot.time_range.start) + " →<br>" + toChineseEraDatetime(snapshot.time_range.end) : "-";
          if (payload.partial_failures?.quota_limit?.message) {
            byId("window-meta").textContent = "额度卷宗未达：" + payload.partial_failures.quota_limit.message;
            renderDebugPanel(
              payload.partial_failures.quota_limit.debug || payload.partial_failures,
              {
                api_path: "/api/usage",
                api_status: response.status,
                api_status_text: response.statusText,
                mode: "partial"
              }
            );
          } else {
            byId("window-meta").textContent = payload.last_error ? "上次宣旨受阻：" + payload.last_error.message : "龙体安康，上游无虞";
          }

          renderRows(
            byId("quota-body"),
            normalizeQuotaRows(snapshot.quota_limit, payload.partial_failures),
            ["type", "usage", "percentage"]
          );
          renderRows(
            byId("models-body"),
            normalizeModelRows(snapshot.model_usage),
            ["name", "callCount", "totalTokens"]
          );
          renderRows(
            byId("tools-body"),
            normalizeToolRows(snapshot.tool_usage),
            ["name", "count", "mcpUsage"]
          );
        } catch (error) {
          byId("status").textContent = "天听未达";
          byId("status").className = "big status-error";
          byId("status-meta").textContent = error.message;
          if (!byId("debug-panel").hidden) {
            byId("debug-meta").textContent = "调试卷宗已启封";
          } else if (rawText) {
            renderDebugPanel(
              {
                client_error: error.message,
                api_path: "/api/usage",
                raw_response: rawText.slice(0, 2000)
              },
              {
                api_path: "/api/usage"
              }
            );
          }
        }
      }

      function renderDebugPanel(debug, meta) {
        const panel = byId("debug-panel");
        if (!debug) {
          panel.hidden = true;
          byId("debug-meta").textContent = "未启封";
          byId("debug-pre").textContent = "";
          return;
        }

        panel.hidden = false;
        byId("debug-meta").textContent = "已记录 " + (meta?.api_path || "/api/usage") + " 的调试细节";
        byId("debug-pre").textContent = JSON.stringify({ meta, debug }, null, 2);
      }

      function statusClassName(status) {
        if (status === "fresh") return "status-fresh";
        if (status === "partial") return "status-partial";
        if (status === "stale") return "status-stale";
        return "status-error";
      }

      function displayStatusText(status) {
        if (status === "fresh") return "圣眷正隆";
        if (status === "partial") return "赏册未全";
        if (status === "stale") return "旧诏可阅";
        return "天听未达";
      }

      function normalizeQuotaRows(quotaLimit, partialFailures) {
        const limits = Array.isArray(quotaLimit?.limits) ? quotaLimit.limits : [];
        if (limits.length === 0 && partialFailures?.quota_limit?.message) {
          return [
            {
              type: "额度卷宗",
              usage: "Unavailable",
              percentage: "-"
            }
          ];
        }
        return limits.map((item) => ({
          type: translateQuotaType(item.type),
          usage: formatQuotaUsage(item),
          percentage: item.percentage != null ? item.percentage + "%" : "-"
        }));
      }

      function normalizeModelRows(modelUsage) {
        const rows = Array.isArray(modelUsage)
          ? modelUsage
          : Array.isArray(modelUsage?.modelSummaryList)
            ? modelUsage.modelSummaryList
            : [];

        return rows.map((item) => ({
          name: item.name || item.modelName || item.model || "-",
          callCount: item.callCount ?? item.count ?? "-",
          totalTokens: item.totalTokens ?? item.tokens ?? "-"
        }));
      }

      function normalizeToolRows(toolUsage) {
        const rows = Array.isArray(toolUsage)
          ? toolUsage
          : Array.isArray(toolUsage?.toolSummaryList)
            ? toolUsage.toolSummaryList
            : [];

        return rows.map((item) => ({
          name: item.name || item.toolName || item.tool || "-",
          count: item.count ?? item.callCount ?? "-",
          mcpUsage: item.mcpUsage ?? item.usage ?? "-"
        }));
      }

      function formatQuotaUsage(item) {
        if (item.currentUsage != null && item.total != null) {
          return item.currentUsage + " / " + item.total;
        }
        if (item.currentValue != null && item.limit != null) {
          return item.currentValue + " / " + item.limit;
        }
        if (item.currentUsage != null) {
          return item.currentUsage;
        }
        if (item.currentValue != null) {
          return item.currentValue;
        }
        return "-";
      }

      function translateQuotaType(type) {
        if (type === "Token usage (5 Hour)") return "两个半时辰 token 赏额";
        if (type === "MCP usage (1 Month)") return "一月 MCP 恩赏";
        return type || "-";
      }

      load();
      setInterval(load, 60000);
    </script>
  </body>
</html>`;
}
