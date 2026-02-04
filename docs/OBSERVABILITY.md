# OpenClaw Observability Guide

Full observability setup for Railway deployment with optional Cloudflare logging integration.

## Quick Start

Once deployed, your OpenClaw instance exposes these observability endpoints:

| Endpoint | Description |
|----------|-------------|
| `/health` | Basic health check (used by Railway) |
| `/health/detailed` | Extended health with system metrics |
| `/metrics` | JSON metrics for dashboards |
| `/metrics/prometheus` | Prometheus-compatible metrics |
| `/diagnostics` | Full diagnostic report |

## Environment Variables

Configure observability via Railway environment variables:

```bash
# Log level: error, warn, info, http, debug, trace
LOG_LEVEL=info

# Log format: json (for log aggregation) or pretty (for development)
LOG_FORMAT=json

# Service name in log entries
SERVICE_NAME=openclaw
```

## Log Format

All logs are emitted in structured JSON format for easy parsing:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "message": "Request completed",
  "service": "openclaw",
  "trace": {
    "traceId": "abc123",
    "spanId": "def456"
  },
  "railway": {
    "deploymentId": "xyz789",
    "environment": "production"
  },
  "method": "GET",
  "path": "/health",
  "statusCode": 200,
  "durationMs": 5.23
}
```

## Railway Logs

View logs in Railway Dashboard:
1. Go to your deployment
2. Click "Logs" tab
3. Use filters to search by level or trace ID

Railway automatically aggregates logs from stdout/stderr.

## Cloudflare Integration

### Option 1: Logpush (Recommended)

Configure Cloudflare Logpush to capture edge-level analytics:

1. Go to Cloudflare Dashboard > Analytics & Logs > Logpush
2. Create a new job with these datasets:
   - `http_requests` - All HTTP requests
   - `firewall_events` - WAF events
3. Choose a destination (R2, Datadog, Splunk, etc.)

### Option 2: Cloudflare Worker

Deploy the included worker for enhanced logging:

```bash
cd cloudflare
npm install wrangler -g
wrangler login
# Edit wrangler.toml with your Railway URL
wrangler deploy
```

The worker adds:
- Request/response timing
- Cloudflare metadata (country, datacenter, bot score)
- Custom trace IDs
- Optional Analytics Engine integration

## Metrics Reference

### Request Metrics

```
openclaw_requests_total              - Total request count
openclaw_requests_by_status{status}  - Requests by status class (2xx, 4xx, 5xx)
openclaw_request_duration_ms_bucket  - Latency histogram
```

### Gateway Metrics

```
openclaw_gateway_starts_total   - Gateway start count
openclaw_gateway_crashes_total  - Gateway crash count
```

### System Metrics

```
openclaw_process_heap_bytes  - Node.js heap usage
openclaw_process_rss_bytes   - Resident set size
```

## Diagnostic Report

The `/diagnostics` endpoint provides a comprehensive snapshot:

```json
{
  "generated": "2024-01-15T10:30:00.000Z",
  "health": {
    "status": "healthy",
    "uptime": { "ms": 3600000, "human": "1h 0m 0s" },
    "gateway": { "status": "running", "crashes": 0 }
  },
  "metrics": {
    "requests": { "total": 1000 },
    "errors": { "total": 5 }
  },
  "environment": {
    "nodeVersion": "v22.0.0",
    "platform": "linux"
  },
  "railway": {
    "deploymentId": "...",
    "environment": "production"
  },
  "recentErrors": [...]
}
```

## Tracing

Each request receives a trace ID, accessible via:
- Response header: `X-Trace-Id`
- Log entries: `trace.traceId` field

For Cloudflare requests, the `CF-Ray` header is used as the parent trace.

## Alerting

### Railway Alerts

Configure in Railway Dashboard > Settings > Alerts:
- Health check failures
- High error rate
- Deployment failures

### Cloudflare Alerts

Configure in Cloudflare Dashboard > Notifications:
- Origin errors
- High 5xx rate
- DDoS attacks

## Troubleshooting

### Common Issues

**Gateway crashes repeatedly**
```bash
# Check diagnostics
curl https://your-app.up.railway.app/diagnostics | jq '.recentErrors'
```

**High latency**
```bash
# Check metrics
curl https://your-app.up.railway.app/metrics | jq '.latency'
```

**Missing logs**
- Verify `LOG_LEVEL` is set correctly
- Check Railway log retention settings

### Debug Mode

Set `LOG_LEVEL=debug` for verbose logging (not recommended for production).
