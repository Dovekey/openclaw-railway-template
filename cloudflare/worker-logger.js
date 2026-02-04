/**
 * OpenClaw Cloudflare Worker - Request Logger
 *
 * Deploy this worker in front of your Railway deployment to get enhanced
 * logging and observability through Cloudflare.
 *
 * Setup:
 * 1. Create a new Worker in Cloudflare Dashboard
 * 2. Copy this code into the worker
 * 3. Add a route that points to your Railway domain
 * 4. Configure environment variables (see below)
 *
 * Environment Variables:
 * - RAILWAY_ORIGIN: Your Railway deployment URL (e.g., https://your-app.up.railway.app)
 * - LOG_SAMPLE_RATE: Percentage of requests to log (0-100, default 100)
 * - ANALYTICS_ENGINE_DATASET: Optional Analytics Engine dataset name
 */

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    // Clone request for logging
    const url = new URL(request.url);

    // Build origin URL
    const originUrl = new URL(url.pathname + url.search, env.RAILWAY_ORIGIN || url.origin);

    // Forward request to Railway
    const originRequest = new Request(originUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow",
    });

    // Add tracing headers
    originRequest.headers.set("X-Request-Id", requestId);
    originRequest.headers.set("X-Forwarded-Host", url.host);
    originRequest.headers.set("X-Real-IP", request.headers.get("CF-Connecting-IP") || "");

    let response;
    let error = null;

    try {
      response = await fetch(originRequest);
    } catch (err) {
      error = err;
      response = new Response("Origin Error", { status: 502 });
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    // Log to console (appears in Cloudflare dashboard)
    const logEntry = {
      timestamp: new Date().toISOString(),
      requestId,
      method: request.method,
      url: url.pathname,
      status: response.status,
      durationMs: duration,
      cf: {
        ray: request.headers.get("CF-Ray"),
        country: request.headers.get("CF-IPCountry"),
        colo: request.cf?.colo,
        tlsVersion: request.cf?.tlsVersion,
        httpProtocol: request.cf?.httpProtocol,
        clientTrustScore: request.cf?.clientTrustScore,
        botManagement: request.cf?.botManagement,
      },
      client: {
        ip: request.headers.get("CF-Connecting-IP"),
        userAgent: request.headers.get("User-Agent"),
        asn: request.cf?.asn,
        asOrganization: request.cf?.asOrganization,
      },
      cache: {
        cacheStatus: response.headers.get("CF-Cache-Status"),
      },
      error: error ? error.message : null,
    };

    // Sample rate for logging
    const sampleRate = parseInt(env.LOG_SAMPLE_RATE || "100", 10);
    if (Math.random() * 100 < sampleRate) {
      console.log(JSON.stringify(logEntry));
    }

    // Write to Analytics Engine if configured
    if (env.ANALYTICS_ENGINE_DATASET) {
      ctx.waitUntil(writeToAnalyticsEngine(env, logEntry));
    }

    // Clone response and add headers
    const modifiedResponse = new Response(response.body, response);
    modifiedResponse.headers.set("X-Request-Id", requestId);
    modifiedResponse.headers.set("X-Response-Time", `${duration}ms`);

    return modifiedResponse;
  },
};

/**
 * Write metrics to Cloudflare Analytics Engine
 */
async function writeToAnalyticsEngine(env, logEntry) {
  if (!env.ANALYTICS_ENGINE) return;

  try {
    env.ANALYTICS_ENGINE.writeDataPoint({
      blobs: [
        logEntry.method,
        logEntry.url,
        logEntry.cf.country || "unknown",
        logEntry.cf.colo || "unknown",
      ],
      doubles: [logEntry.durationMs, logEntry.status],
      indexes: [logEntry.requestId.slice(0, 8)],
    });
  } catch (err) {
    console.error("Analytics Engine write failed:", err.message);
  }
}

/**
 * Tail Worker for real-time log processing
 * Deploy as a separate worker and configure as a Tail Consumer
 */
export const tailHandler = {
  async tail(events) {
    for (const event of events) {
      // Process logs in real-time
      // Can forward to external services, filter, transform, etc.

      for (const log of event.logs) {
        // Example: Forward errors to an alerting service
        if (log.level === "error" || (log.message && log.message.includes("error"))) {
          // Send alert (implement your alerting logic here)
          console.log("ALERT:", JSON.stringify(log));
        }
      }
    }
  },
};
