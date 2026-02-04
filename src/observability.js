/**
 * OpenClaw Observability Module
 *
 * Provides structured logging, request tracing, metrics, and diagnostics
 * for Railway and Cloudflare deployments.
 */

import os from "node:os";
import { performance } from "node:perf_hooks";

// ============================================================================
// Configuration
// ============================================================================

const LOG_LEVEL = process.env.LOG_LEVEL?.toLowerCase() || "info";
const LOG_FORMAT = process.env.LOG_FORMAT?.toLowerCase() || "json";
const SERVICE_NAME = process.env.SERVICE_NAME || "openclaw";
const RAILWAY_DEPLOYMENT_ID = process.env.RAILWAY_DEPLOYMENT_ID || null;
const RAILWAY_SERVICE_ID = process.env.RAILWAY_SERVICE_ID || null;
const RAILWAY_ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT || "production";
const RAILWAY_REPLICA_ID = process.env.RAILWAY_REPLICA_ID || null;

// Log levels with numeric priorities
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
  trace: 5,
};

const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;

// ============================================================================
// Metrics Storage (in-memory, designed for Railway's ephemeral containers)
// ============================================================================

// Supported messaging channels
const SUPPORTED_CHANNELS = [
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "google-chat",
  "teams",
  "mattermost",
  "matrix",
  "zalo",
  "zalo-personal",
  "bluebubbles",
  "webchat",
];

const metrics = {
  // Request metrics
  requests: {
    total: 0,
    byStatus: new Map(),
    byPath: new Map(),
    byMethod: new Map(),
  },
  // Latency histograms (buckets in ms)
  latency: {
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    counts: new Map(), // path -> bucket -> count
    sum: new Map(),    // path -> total ms
  },
  // Error tracking
  errors: {
    total: 0,
    byType: new Map(),
    recent: [], // Last 100 errors with stack traces
  },
  // Gateway metrics
  gateway: {
    startCount: 0,
    restartCount: 0,
    crashCount: 0,
    lastStart: null,
    uptime: 0,
  },
  // Messaging channel metrics
  messaging: {
    received: new Map(),    // channel -> count
    sent: new Map(),        // channel -> count
    errors: new Map(),      // channel -> count
    latency: new Map(),     // channel -> total ms
    lastActivity: new Map(), // channel -> timestamp
  },
  // System metrics snapshot
  system: {
    lastSnapshot: null,
  },
  // Start time for uptime calculation
  startTime: Date.now(),
};

// ============================================================================
// Trace Context
// ============================================================================

const traceStore = new Map();

function generateTraceId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

function generateSpanId() {
  return Math.random().toString(36).substring(2, 10);
}

// ============================================================================
// Structured Logger
// ============================================================================

function formatMessage(level, message, context = {}) {
  const timestamp = new Date().toISOString();

  const baseEntry = {
    timestamp,
    level,
    message,
    service: SERVICE_NAME,
  };

  // Add Railway metadata if available
  if (RAILWAY_DEPLOYMENT_ID) {
    baseEntry.railway = {
      deploymentId: RAILWAY_DEPLOYMENT_ID,
      serviceId: RAILWAY_SERVICE_ID,
      environment: RAILWAY_ENVIRONMENT,
      replicaId: RAILWAY_REPLICA_ID,
    };
  }

  // Add trace context if available
  if (context.traceId) {
    baseEntry.trace = {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
    };
    delete context.traceId;
    delete context.spanId;
    delete context.parentSpanId;
  }

  // Merge additional context
  const entry = { ...baseEntry, ...context };

  if (LOG_FORMAT === "json") {
    return JSON.stringify(entry);
  }

  // Pretty format for development
  const parts = [`[${timestamp}]`, `[${level.toUpperCase()}]`, message];
  if (Object.keys(context).length > 0) {
    parts.push(JSON.stringify(context));
  }
  return parts.join(" ");
}

function shouldLog(level) {
  return (LOG_LEVELS[level] ?? LOG_LEVELS.info) <= currentLogLevel;
}

export const logger = {
  error(message, context = {}) {
    if (shouldLog("error")) {
      console.error(formatMessage("error", message, context));
    }
  },
  warn(message, context = {}) {
    if (shouldLog("warn")) {
      console.warn(formatMessage("warn", message, context));
    }
  },
  info(message, context = {}) {
    if (shouldLog("info")) {
      console.log(formatMessage("info", message, context));
    }
  },
  http(message, context = {}) {
    if (shouldLog("http")) {
      console.log(formatMessage("http", message, context));
    }
  },
  debug(message, context = {}) {
    if (shouldLog("debug")) {
      console.log(formatMessage("debug", message, context));
    }
  },
  trace(message, context = {}) {
    if (shouldLog("trace")) {
      console.log(formatMessage("trace", message, context));
    }
  },
  // Audit log (always logs, regardless of level)
  audit(event, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "audit",
      event,
      service: SERVICE_NAME,
      ...details,
    };
    if (RAILWAY_DEPLOYMENT_ID) {
      entry.railway = {
        deploymentId: RAILWAY_DEPLOYMENT_ID,
        environment: RAILWAY_ENVIRONMENT,
      };
    }
    console.log(JSON.stringify(entry));
  },
};

// ============================================================================
// Request Tracing Middleware
// ============================================================================

export function requestTracer() {
  return (req, res, next) => {
    const startTime = performance.now();

    // Extract or generate trace ID
    // Support Cloudflare's cf-ray header as parent trace
    const cfRay = req.headers["cf-ray"];
    const incomingTraceId = req.headers["x-trace-id"] || req.headers["x-request-id"];
    const traceId = incomingTraceId || cfRay?.split("-")[0] || generateTraceId();
    const spanId = generateSpanId();
    const parentSpanId = req.headers["x-parent-span-id"];

    // Attach trace context to request
    req.trace = {
      traceId,
      spanId,
      parentSpanId,
      startTime,
    };

    // Store for async operations
    traceStore.set(traceId, req.trace);

    // Cloudflare context
    req.cf = {
      ray: cfRay,
      country: req.headers["cf-ipcountry"],
      ip: req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress,
      datacenter: req.headers["cf-ray"]?.split("-")[1],
      httpProtocol: req.headers["x-forwarded-proto"] || "http",
      tlsVersion: req.headers["cf-visitor"] ? JSON.parse(req.headers["cf-visitor"]).scheme : null,
    };

    // Set response headers for tracing
    res.setHeader("X-Trace-Id", traceId);
    res.setHeader("X-Span-Id", spanId);

    // Capture response details
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
      const duration = performance.now() - startTime;

      // Record metrics
      recordRequestMetrics(req, res, duration);

      // Log request completion
      logger.http("Request completed", {
        traceId,
        spanId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(duration * 100) / 100,
        userAgent: req.headers["user-agent"],
        cf: req.cf.ray ? {
          ray: req.cf.ray,
          country: req.cf.country,
          datacenter: req.cf.datacenter,
        } : undefined,
      });

      // Cleanup trace store
      traceStore.delete(traceId);

      return originalEnd.call(this, chunk, encoding);
    };

    next();
  };
}

// ============================================================================
// Metrics Recording
// ============================================================================

function recordRequestMetrics(req, res, durationMs) {
  const path = normalizePath(req.path);
  const method = req.method;
  const status = res.statusCode;
  const statusClass = `${Math.floor(status / 100)}xx`;

  // Total requests
  metrics.requests.total++;

  // By status
  metrics.requests.byStatus.set(statusClass, (metrics.requests.byStatus.get(statusClass) || 0) + 1);

  // By path (limit cardinality)
  const pathCount = metrics.requests.byPath.get(path) || 0;
  metrics.requests.byPath.set(path, pathCount + 1);

  // By method
  metrics.requests.byMethod.set(method, (metrics.requests.byMethod.get(method) || 0) + 1);

  // Latency
  recordLatency(path, durationMs);

  // Track errors
  if (status >= 400) {
    metrics.errors.total++;
    const errorType = status >= 500 ? "server_error" : "client_error";
    metrics.errors.byType.set(errorType, (metrics.errors.byType.get(errorType) || 0) + 1);
  }
}

function normalizePath(path) {
  // Normalize paths to reduce cardinality
  // e.g., /setup/api/console/123 -> /setup/api/console/:id
  return path
    .replace(/\/[0-9a-f]{8,}/gi, "/:id")
    .replace(/\/\d+/g, "/:num");
}

function recordLatency(path, durationMs) {
  // Find bucket
  let bucket = "inf";
  for (const b of metrics.latency.buckets) {
    if (durationMs <= b) {
      bucket = b;
      break;
    }
  }

  const key = `${path}:${bucket}`;
  metrics.latency.counts.set(key, (metrics.latency.counts.get(key) || 0) + 1);
  metrics.latency.sum.set(path, (metrics.latency.sum.get(path) || 0) + durationMs);
}

// ============================================================================
// Error Tracking
// ============================================================================

export function trackError(error, context = {}) {
  const errorEntry = {
    timestamp: new Date().toISOString(),
    message: error.message,
    name: error.name,
    stack: error.stack,
    code: error.code,
    ...context,
  };

  metrics.errors.total++;
  metrics.errors.byType.set(error.name, (metrics.errors.byType.get(error.name) || 0) + 1);

  // Keep last 100 errors
  metrics.errors.recent.push(errorEntry);
  if (metrics.errors.recent.length > 100) {
    metrics.errors.recent.shift();
  }

  // Log the error
  logger.error("Error tracked", errorEntry);

  return errorEntry;
}

// ============================================================================
// Gateway Observability
// ============================================================================

export function trackGatewayStart() {
  metrics.gateway.startCount++;
  metrics.gateway.lastStart = Date.now();
  logger.info("Gateway started", {
    startCount: metrics.gateway.startCount,
    restartCount: metrics.gateway.restartCount,
  });
}

export function trackGatewayRestart() {
  metrics.gateway.restartCount++;
  metrics.gateway.lastStart = Date.now();
  logger.warn("Gateway restarted", {
    restartCount: metrics.gateway.restartCount,
  });
}

export function trackGatewayCrash(code, signal) {
  metrics.gateway.crashCount++;
  logger.error("Gateway crashed", {
    exitCode: code,
    signal,
    crashCount: metrics.gateway.crashCount,
    uptimeMs: metrics.gateway.lastStart ? Date.now() - metrics.gateway.lastStart : 0,
  });
}

// ============================================================================
// Messaging Channel Observability
// ============================================================================

/**
 * Track an incoming message from a messaging channel
 */
export function trackMessageReceived(channel, context = {}) {
  const normalizedChannel = channel.toLowerCase();
  metrics.messaging.received.set(
    normalizedChannel,
    (metrics.messaging.received.get(normalizedChannel) || 0) + 1
  );
  metrics.messaging.lastActivity.set(normalizedChannel, Date.now());

  logger.info("Message received", {
    channel: normalizedChannel,
    chatId: context.chatId,
    userId: context.userId,
    traceId: context.traceId,
  });
}

/**
 * Track an outgoing message to a messaging channel
 */
export function trackMessageSent(channel, context = {}) {
  const normalizedChannel = channel.toLowerCase();
  metrics.messaging.sent.set(
    normalizedChannel,
    (metrics.messaging.sent.get(normalizedChannel) || 0) + 1
  );
  metrics.messaging.lastActivity.set(normalizedChannel, Date.now());

  if (context.durationMs) {
    metrics.messaging.latency.set(
      normalizedChannel,
      (metrics.messaging.latency.get(normalizedChannel) || 0) + context.durationMs
    );
  }

  logger.info("Message sent", {
    channel: normalizedChannel,
    chatId: context.chatId,
    durationMs: context.durationMs,
    traceId: context.traceId,
  });
}

/**
 * Track a messaging channel error
 */
export function trackMessageError(channel, error, context = {}) {
  const normalizedChannel = channel.toLowerCase();
  metrics.messaging.errors.set(
    normalizedChannel,
    (metrics.messaging.errors.get(normalizedChannel) || 0) + 1
  );

  logger.error("Messaging error", {
    channel: normalizedChannel,
    error: error.message,
    code: error.code,
    chatId: context.chatId,
    traceId: context.traceId,
  });

  trackError(error, { context: `messaging_${normalizedChannel}`, ...context });
}

/**
 * Get messaging channel statistics
 */
export function getMessagingStats() {
  const channels = {};

  for (const channel of SUPPORTED_CHANNELS) {
    const received = metrics.messaging.received.get(channel) || 0;
    const sent = metrics.messaging.sent.get(channel) || 0;
    const errors = metrics.messaging.errors.get(channel) || 0;
    const totalLatency = metrics.messaging.latency.get(channel) || 0;
    const lastActivity = metrics.messaging.lastActivity.get(channel);

    if (received > 0 || sent > 0 || errors > 0) {
      channels[channel] = {
        received,
        sent,
        errors,
        avgLatencyMs: sent > 0 ? Math.round((totalLatency / sent) * 100) / 100 : null,
        lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
      };
    }
  }

  return {
    supportedChannels: SUPPORTED_CHANNELS,
    activeChannels: Object.keys(channels),
    stats: channels,
    totals: {
      received: Array.from(metrics.messaging.received.values()).reduce((a, b) => a + b, 0),
      sent: Array.from(metrics.messaging.sent.values()).reduce((a, b) => a + b, 0),
      errors: Array.from(metrics.messaging.errors.values()).reduce((a, b) => a + b, 0),
    },
  };
}

// ============================================================================
// System Metrics
// ============================================================================

function getSystemMetrics() {
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  return {
    timestamp: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
        rssMB: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
        externalMB: Math.round(memUsage.external / 1024 / 1024 * 100) / 100,
      },
      cpu: {
        userMicros: cpuUsage.user,
        systemMicros: cpuUsage.system,
      },
    },
    system: {
      loadAvg: os.loadavg(),
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
      cpuCount: os.cpus().length,
      platform: os.platform(),
      nodeVersion: process.version,
    },
  };
}

// ============================================================================
// Health and Diagnostics
// ============================================================================

export function getHealthStatus(isConfigured, gatewayProc) {
  const systemMetrics = getSystemMetrics();
  const uptimeMs = Date.now() - metrics.startTime;

  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "unknown",
    uptime: {
      ms: uptimeMs,
      human: formatUptime(uptimeMs),
    },
    configured: isConfigured,
    gateway: {
      status: gatewayProc ? "running" : "stopped",
      pid: gatewayProc?.pid || null,
      starts: metrics.gateway.startCount,
      restarts: metrics.gateway.restartCount,
      crashes: metrics.gateway.crashCount,
      lastStart: metrics.gateway.lastStart ? new Date(metrics.gateway.lastStart).toISOString() : null,
    },
    railway: RAILWAY_DEPLOYMENT_ID ? {
      deploymentId: RAILWAY_DEPLOYMENT_ID,
      serviceId: RAILWAY_SERVICE_ID,
      environment: RAILWAY_ENVIRONMENT,
      replicaId: RAILWAY_REPLICA_ID,
    } : null,
    system: systemMetrics.system,
    process: systemMetrics.process,
  };
}

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ============================================================================
// Metrics Export (Prometheus-compatible format)
// ============================================================================

export function getMetricsPrometheus() {
  const lines = [];
  const prefix = "openclaw";

  // Request metrics
  lines.push(`# HELP ${prefix}_requests_total Total number of requests`);
  lines.push(`# TYPE ${prefix}_requests_total counter`);
  lines.push(`${prefix}_requests_total ${metrics.requests.total}`);

  lines.push(`# HELP ${prefix}_requests_by_status Requests by status class`);
  lines.push(`# TYPE ${prefix}_requests_by_status counter`);
  for (const [status, count] of metrics.requests.byStatus) {
    lines.push(`${prefix}_requests_by_status{status="${status}"} ${count}`);
  }

  // Latency histogram
  lines.push(`# HELP ${prefix}_request_duration_ms Request duration in milliseconds`);
  lines.push(`# TYPE ${prefix}_request_duration_ms histogram`);
  for (const [key, count] of metrics.latency.counts) {
    const [path, bucket] = key.split(":");
    lines.push(`${prefix}_request_duration_ms_bucket{path="${path}",le="${bucket}"} ${count}`);
  }

  // Error metrics
  lines.push(`# HELP ${prefix}_errors_total Total number of errors`);
  lines.push(`# TYPE ${prefix}_errors_total counter`);
  lines.push(`${prefix}_errors_total ${metrics.errors.total}`);

  // Gateway metrics
  lines.push(`# HELP ${prefix}_gateway_starts_total Gateway start count`);
  lines.push(`# TYPE ${prefix}_gateway_starts_total counter`);
  lines.push(`${prefix}_gateway_starts_total ${metrics.gateway.startCount}`);

  lines.push(`# HELP ${prefix}_gateway_crashes_total Gateway crash count`);
  lines.push(`# TYPE ${prefix}_gateway_crashes_total counter`);
  lines.push(`${prefix}_gateway_crashes_total ${metrics.gateway.crashCount}`);

  // Process metrics
  const mem = process.memoryUsage();
  lines.push(`# HELP ${prefix}_process_heap_bytes Heap memory usage`);
  lines.push(`# TYPE ${prefix}_process_heap_bytes gauge`);
  lines.push(`${prefix}_process_heap_bytes ${mem.heapUsed}`);

  lines.push(`# HELP ${prefix}_process_rss_bytes RSS memory usage`);
  lines.push(`# TYPE ${prefix}_process_rss_bytes gauge`);
  lines.push(`${prefix}_process_rss_bytes ${mem.rss}`);

  return lines.join("\n");
}

// ============================================================================
// Metrics JSON Export
// ============================================================================

export function getMetricsJson() {
  return {
    timestamp: new Date().toISOString(),
    uptime: Date.now() - metrics.startTime,
    requests: {
      total: metrics.requests.total,
      byStatus: Object.fromEntries(metrics.requests.byStatus),
      byMethod: Object.fromEntries(metrics.requests.byMethod),
      topPaths: getTopEntries(metrics.requests.byPath, 10),
    },
    latency: {
      byPath: getLatencyStats(),
    },
    errors: {
      total: metrics.errors.total,
      byType: Object.fromEntries(metrics.errors.byType),
      recent: metrics.errors.recent.slice(-10),
    },
    gateway: {
      starts: metrics.gateway.startCount,
      restarts: metrics.gateway.restartCount,
      crashes: metrics.gateway.crashCount,
      lastStart: metrics.gateway.lastStart,
    },
    system: getSystemMetrics(),
  };
}

function getTopEntries(map, limit) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => ({ path: key, count: value }));
}

function getLatencyStats() {
  const stats = {};
  for (const [path, sum] of metrics.latency.sum) {
    const count = Array.from(metrics.latency.counts.entries())
      .filter(([key]) => key.startsWith(`${path}:`))
      .reduce((acc, [, c]) => acc + c, 0);
    if (count > 0) {
      stats[path] = {
        count,
        totalMs: Math.round(sum * 100) / 100,
        avgMs: Math.round((sum / count) * 100) / 100,
      };
    }
  }
  return stats;
}

// ============================================================================
// Cloudflare-specific utilities
// ============================================================================

export function cloudflareContext(req) {
  return {
    ray: req.headers["cf-ray"],
    country: req.headers["cf-ipcountry"],
    ip: req.headers["cf-connecting-ip"],
    datacenter: req.headers["cf-ray"]?.split("-")[1],
    isBot: req.headers["cf-bot-score"] ? parseInt(req.headers["cf-bot-score"], 10) < 30 : undefined,
    botScore: req.headers["cf-bot-score"] ? parseInt(req.headers["cf-bot-score"], 10) : undefined,
    tlsCipherSuite: req.headers["cf-tls-cipher-suite"],
    httpProtocol: req.headers["x-forwarded-proto"],
    // Cloudflare Access context (if using Zero Trust)
    accessEmail: req.headers["cf-access-authenticated-user-email"],
    accessId: req.headers["cf-access-jwt-assertion"],
  };
}

// ============================================================================
// Diagnostic Report Generator
// ============================================================================

export async function generateDiagnosticReport(opts = {}) {
  const { isConfigured, gatewayProc, stateDir, workspaceDir } = opts;

  const report = {
    generated: new Date().toISOString(),
    format: "openclaw-diagnostic-v1",

    // Health status
    health: getHealthStatus(isConfigured, gatewayProc),

    // Metrics summary
    metrics: getMetricsJson(),

    // Environment (sanitized)
    environment: {
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      stateDir,
      workspaceDir,
      logLevel: LOG_LEVEL,
      logFormat: LOG_FORMAT,
    },

    // Recent errors
    recentErrors: metrics.errors.recent.slice(-20),

    // Railway context
    railway: RAILWAY_DEPLOYMENT_ID ? {
      deploymentId: RAILWAY_DEPLOYMENT_ID,
      serviceId: RAILWAY_SERVICE_ID,
      environment: RAILWAY_ENVIRONMENT,
      replicaId: RAILWAY_REPLICA_ID,
    } : null,
  };

  return report;
}

// ============================================================================
// Express Middleware for Metrics Endpoints
// ============================================================================

export function metricsRouter(express, opts = {}) {
  const router = express.Router();
  const { isConfigured, getGatewayProc, stateDir, workspaceDir } = opts;

  // JSON metrics endpoint
  router.get("/metrics", (_req, res) => {
    res.json(getMetricsJson());
  });

  // Prometheus metrics endpoint
  router.get("/metrics/prometheus", (_req, res) => {
    res.type("text/plain").send(getMetricsPrometheus());
  });

  // Extended health endpoint
  router.get("/health/detailed", (_req, res) => {
    res.json(getHealthStatus(isConfigured?.() ?? false, getGatewayProc?.() ?? null));
  });

  // Diagnostic report endpoint
  router.get("/diagnostics", async (_req, res) => {
    const report = await generateDiagnosticReport({
      isConfigured: isConfigured?.() ?? false,
      gatewayProc: getGatewayProc?.() ?? null,
      stateDir,
      workspaceDir,
    });
    res.json(report);
  });

  // Recent errors endpoint
  router.get("/errors", (_req, res) => {
    res.json({
      total: metrics.errors.total,
      byType: Object.fromEntries(metrics.errors.byType),
      recent: metrics.errors.recent.slice(-50),
    });
  });

  return router;
}

// ============================================================================
// Startup banner
// ============================================================================

export function logStartupBanner(opts = {}) {
  const { port, stateDir, workspaceDir } = opts;

  logger.info("OpenClaw server starting", {
    port,
    stateDir,
    workspaceDir,
    nodeVersion: process.version,
    logLevel: LOG_LEVEL,
    logFormat: LOG_FORMAT,
    railway: RAILWAY_DEPLOYMENT_ID ? {
      deploymentId: RAILWAY_DEPLOYMENT_ID,
      environment: RAILWAY_ENVIRONMENT,
    } : undefined,
  });
}

export { metrics };
