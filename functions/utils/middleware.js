import sentryPlugin from "@cloudflare/pages-plugin-sentry";
import '@sentry/tracing';

// Headers that must never be forwarded to third-party telemetry (Sentry).
// They can contain credentials (Basic Auth / API keys) or personally
// identifying session material.
const SENSITIVE_HEADER_PREFIXES = ["x-api-", "x-auth-"];
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
]);

function isSensitiveHeader(name) {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADERS.has(lower)) return true;
  return SENSITIVE_HEADER_PREFIXES.some((p) => lower.startsWith(p));
}

// Telemetry is OPT-IN. Operators must explicitly set `enable_telemetry=true`
// (and optionally `SENTRY_DSN`) to activate request reporting. This prevents
// unintentional leakage of request metadata — including credentials carried in
// headers — to any Sentry project the operator does not own.
function telemetryEnabled(env) {
  return typeof env.enable_telemetry !== "undefined"
    && env.enable_telemetry !== null
    && String(env.enable_telemetry).toLowerCase() === "true";
}

export async function errorHandling(context) {
  const env = context.env;
  if (!telemetryEnabled(env)) {
    return context.next();
  }

  const dsn = env.SENTRY_DSN;
  if (!dsn) {
    // Telemetry was requested but no DSN configured — fail open (no telemetry)
    // rather than sending data to a hardcoded third-party project.
    return context.next();
  }

  context.data.telemetry = true;
  let remoteSampleRate = 0.001;
  try {
    const sampleRate = await fetchSampleRate(context);
    if (sampleRate) {
      remoteSampleRate = sampleRate;
    }
  } catch (e) {
    console.log(e);
  }
  const sampleRate = env.sampleRate || remoteSampleRate;
  return sentryPlugin({
    dsn,
    tracesSampleRate: sampleRate,
  })(context);
}

export function telemetryData(context) {
  const env = context.env;
  if (!telemetryEnabled(env) || !context.data || !context.data.sentry) {
    return context.next();
  }

  try {
    const parsedHeaders = {};
    context.request.headers.forEach((value, key) => {
      if (isSensitiveHeader(key)) {
        parsedHeaders[key] = "[redacted]";
        return;
      }
      parsedHeaders[key] = value;
      if (value.length > 0) {
        context.data.sentry.setTag(key, value);
      }
    });
    const CF = JSON.parse(JSON.stringify(context.request.cf || {}));
    const parsedCF = {};
    for (const key in CF) {
      if (typeof CF[key] == "object") {
        parsedCF[key] = JSON.stringify(CF[key]);
      } else {
        parsedCF[key] = CF[key];
        if (String(CF[key]).length > 0) {
          context.data.sentry.setTag(key, CF[key]);
        }
      }
    }
    const data = {
      headers: parsedHeaders,
      cf: parsedCF,
      url: context.request.url,
      method: context.request.method,
      redirect: context.request.redirect,
    };
    const urlPath = new URL(context.request.url).pathname;
    const hostname = new URL(context.request.url).hostname;
    context.data.sentry.setTag("path", urlPath);
    context.data.sentry.setTag("url", data.url);
    context.data.sentry.setTag("method", context.request.method);
    context.data.sentry.setTag("redirect", context.request.redirect);
    context.data.sentry.setContext("request", data);
    const transaction = context.data.sentry.startTransaction({ name: `${context.request.method} ${hostname}` });
    context.data.transaction = transaction;
    return context.next();
  } catch (e) {
    console.log(e);
  } finally {
    if (context.data.transaction && typeof context.data.transaction.finish === "function") {
      context.data.transaction.finish();
    }
  }
  return context.next();
}

export async function traceData(context, span, op, name) {
  const data = context.data;
  if (data && data.telemetry) {
    if (span) {
      span.finish();
    } else if (context.data.transaction) {
      span = await context.data.transaction.startChild(
        { op: op, name: name },
      );
    }
  }
}

async function fetchSampleRate(context) {
  const data = context.data;
  if (!data || !data.telemetry) return null;
  const url = context.env.sampleRateUrl;
  if (!url) return null;
  const response = await fetch(url);
  const json = await response.json();
  return json.rate;
}
