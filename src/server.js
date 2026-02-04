import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway deployments sometimes inject PORT=3000 by default. We want the wrapper to
// reliably listen on 8080 unless explicitly overridden.
//
// Prefer OPENCLAW_PUBLIC_PORT (set in the Dockerfile / template) over PORT.
// Keep CLAWDBOT_PUBLIC_PORT as a backward-compat alias for older templates.
const PORT = Number.parseInt(
  process.env.OPENCLAW_PUBLIC_PORT ?? process.env.CLAWDBOT_PUBLIC_PORT ?? process.env.PORT ?? "8080",
  10,
);

// State/workspace
// OpenClaw defaults to ~/.openclaw. Keep CLAWDBOT_* as backward-compat aliases.
// If none of the default locations are writable, find any writable location.

// Expand shell variables like $HOME and ~ in paths
// (Railway passes env vars as literal strings without shell expansion)
function expandShellPath(p) {
  if (!p) return p;
  // Expand ~ at start of path
  if (p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(2));
  } else if (p === "~") {
    p = os.homedir();
  }
  // Expand $HOME anywhere in path
  p = p.replace(/\$HOME\b/g, os.homedir());
  p = p.replace(/\$\{HOME\}/g, os.homedir());
  return p;
}

// Test if a directory is fully usable (can create subdirs, write files)
function testDirUsable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Test write access to the directory itself
  const testFile = path.join(dir, ".write-test");
  fs.writeFileSync(testFile, "test", { mode: 0o600 });
  fs.unlinkSync(testFile);
  // Also test that we can create subdirectories (critical for workspace)
  const testSubdir = path.join(dir, ".subdir-test");
  fs.mkdirSync(testSubdir, { recursive: true });
  fs.rmdirSync(testSubdir);
}

function findWritableStateDir() {
  // If explicitly set via env, expand shell variables and validate
  const rawEnvDir = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (rawEnvDir) {
    const envDir = expandShellPath(rawEnvDir);
    // Validate the expanded path is usable before returning
    try {
      testDirUsable(envDir);
      return envDir;
    } catch {
      // Env-specified path not usable, fall through to auto-discovery
      console.warn(`[wrapper] Configured state dir "${rawEnvDir}" (expanded: "${envDir}") is not writable, auto-discovering...`);
    }
  }

  // Try candidate directories in order of preference
  // /data is the Railway volume mount - prioritize it for persistent storage
  const candidates = [
    "/data/.openclaw",
    path.join(os.homedir(), ".openclaw"),
    path.join(os.tmpdir(), ".openclaw"),
    path.join(process.cwd(), ".openclaw"),
  ];

  for (const dir of candidates) {
    try {
      testDirUsable(dir);
      return dir;
    } catch {
      // This location isn't writable, try next
    }
  }

  // Last resort: use tmpdir directly with a unique subdirectory
  const fallback = path.join(os.tmpdir(), `openclaw-${process.pid}`);
  try {
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    // If even tmpdir fails, just return the first candidate and let it fail later with a clear error
    return candidates[0];
  }
}

const STATE_DIR = findWritableStateDir();

function findWritableWorkspaceDir() {
  // If explicitly set via env, expand and validate
  const rawEnvDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || process.env.CLAWDBOT_WORKSPACE_DIR?.trim();
  if (rawEnvDir) {
    const envDir = expandShellPath(rawEnvDir);
    try {
      testDirUsable(envDir);
      return envDir;
    } catch {
      console.warn(`[wrapper] Configured workspace dir "${rawEnvDir}" (expanded: "${envDir}") is not writable, using default...`);
    }
  }
  // Default: under the state directory
  const defaultDir = path.join(STATE_DIR, "workspace");
  try {
    testDirUsable(defaultDir);
    return defaultDir;
  } catch {
    // If even default fails, try tmpdir
    const fallback = path.join(os.tmpdir(), `openclaw-workspace-${process.pid}`);
    try {
      fs.mkdirSync(fallback, { recursive: true });
      return fallback;
    } catch {
      return defaultDir; // Let it fail with clear error later
    }
  }
}

const WORKSPACE_DIR = findWritableWorkspaceDir();

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
// Backward-compat: some older flows expect CLAWDBOT_GATEWAY_TOKEN.
process.env.CLAWDBOT_GATEWAY_TOKEN = process.env.CLAWDBOT_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    process.env.CLAWDBOT_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

// Auth groups definition (used for both HTML rendering and API response)
// These match OpenClaw's own auth-choice grouping logic.
const AUTH_GROUPS = [
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", keyType: "api-key", options: [
    { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)", keyType: "oauth" },
    { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)", keyType: "oauth" },
    { value: "openai-api-key", label: "OpenAI API key", keyType: "api-key" }
  ]},
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", keyType: "api-key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)", keyType: "oauth" },
    { value: "token", label: "Anthropic token (paste setup-token)", keyType: "token" },
    { value: "apiKey", label: "Anthropic API key", keyType: "api-key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key + OAuth", keyType: "api-key", options: [
    { value: "gemini-api-key", label: "Google Gemini API key", keyType: "api-key" },
    { value: "google-antigravity", label: "Google Antigravity OAuth", keyType: "oauth" },
    { value: "google-gemini-cli", label: "Google Gemini CLI OAuth", keyType: "oauth" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", keyType: "api-key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key", keyType: "api-key" }
  ]},
  { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", keyType: "api-key", options: [
    { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key", keyType: "api-key" }
  ]},
  { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", keyType: "api-key", options: [
    { value: "moonshot-api-key", label: "Moonshot AI API key", keyType: "api-key" },
    { value: "kimi-code-api-key", label: "Kimi Code API key", keyType: "api-key" }
  ]},
  { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", keyType: "api-key", options: [
    { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key", keyType: "api-key" }
  ]},
  { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", keyType: "api-key", options: [
    { value: "minimax-api", label: "MiniMax M2.1", keyType: "api-key" },
    { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning", keyType: "api-key" }
  ]},
  { value: "qwen", label: "Qwen", hint: "OAuth", keyType: "oauth", options: [
    { value: "qwen-portal", label: "Qwen OAuth", keyType: "oauth" }
  ]},
  { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", keyType: "oauth", options: [
    { value: "github-copilot", label: "GitHub Copilot (GitHub device login)", keyType: "oauth" },
    { value: "copilot-proxy", label: "Copilot Proxy (local)", keyType: "proxy" }
  ]},
  { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", keyType: "api-key", options: [
    { value: "synthetic-api-key", label: "Synthetic API key", keyType: "api-key" }
  ]},
  { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", keyType: "api-key", options: [
    { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)", keyType: "api-key" }
  ]}
];

// Helper to find auth option details by value
function findAuthOption(authChoice) {
  for (const group of AUTH_GROUPS) {
    for (const opt of group.options) {
      if (opt.value === authChoice) {
        return { group, option: opt };
      }
    }
  }
  return null;
}

// Load existing config values for form pre-population (non-sensitive fields only)
function loadConfigForForm() {
  const result = {
    authProvider: null,
    authChoice: null,
    authKeyType: null,
    flow: "quickstart",
    hasSecret: false,
    // Channel configs (non-sensitive)
    telegramEnabled: false,
    discordEnabled: false,
    slackEnabled: false,
  };

  try {
    const cfgPath = configPath();
    if (!fs.existsSync(cfgPath)) return result;

    const content = fs.readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(content);

    // Load auth settings
    if (cfg.auth) {
      result.authProvider = cfg.auth.provider || null;
      result.authChoice = cfg.auth.choice || null;
      result.authKeyType = cfg.auth.keyType || null;
      // Don't load the actual secret, just indicate if one is set
      result.hasSecret = Boolean(cfg.auth.secretSet);
    }

    // Load channel enabled states
    if (cfg.channels) {
      result.telegramEnabled = cfg.channels.telegram?.enabled ?? false;
      result.discordEnabled = cfg.channels.discord?.enabled ?? false;
      result.slackEnabled = cfg.channels.slack?.enabled ?? false;
    }
  } catch {
    // Config doesn't exist or is invalid, use defaults
  }

  return result;
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to legacy or root.
      const paths = ["/openclaw", "/clawdbot", "/"]; 
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          // Any HTTP response means the port is open.
          if (res) return true;
        } catch {
          // try next
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      // Backward-compat aliases
      CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
      CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  // Get client IP (handle proxies)
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

  // Check rate limit before processing auth
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    auditLog("AUTH_RATE_LIMITED", { ip, path: req.path });
    res.setHeader("Retry-After", Math.ceil(rateCheck.retryAfterMs / 1000));
    return res.status(429).type("text/plain").send("Too many authentication attempts. Please try again later.");
  }

  // Check request rate limit
  const requestRateCheck = checkRequestRateLimit(ip);
  if (!requestRateCheck.allowed) {
    auditLog("REQUEST_RATE_LIMITED", { ip, path: req.path });
    res.setHeader("Retry-After", Math.ceil(requestRateCheck.retryAfterMs / 1000));
    return res.status(429).type("text/plain").send("Too many requests. Please try again later.");
  }

  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    recordAuthFailure(ip);
    auditLog("AUTH_FAILURE", { ip, path: req.path });
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }

  // Auth successful
  recordAuthSuccess(ip);
  auditLog("AUTH_SUCCESS", { ip, path: req.path });
  return next();
}

const app = express();
app.disable("x-powered-by");

// === SECURITY HEADERS MIDDLEWARE ===
// Defense-in-depth: Add security headers to all responses
app.use((_req, res, next) => {
  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");
  // XSS protection (legacy browsers)
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Referrer policy - don't leak URLs
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions policy - restrict browser features
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // Content Security Policy for /setup pages
  if (_req.path.startsWith("/setup")) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self';"
    );
  }
  next();
});

// === RATE LIMITING STATE ===
// Brute force protection for authentication endpoints
const rateLimitState = {
  // Map of IP -> { attempts: number, lastAttempt: timestamp, lockedUntil: timestamp }
  authAttempts: new Map(),
  // Map of IP -> { requests: number[], windowStart: timestamp }
  requestCounts: new Map(),
};

const RATE_LIMIT_CONFIG = {
  maxAuthAttempts: 5,           // Max failed auth attempts before lockout
  authLockoutMs: 15 * 60 * 1000, // 15 minute lockout
  authWindowMs: 5 * 60 * 1000,   // 5 minute window for counting attempts
  maxRequestsPerMinute: 30,      // Max requests per minute to /setup endpoints
  requestWindowMs: 60 * 1000,    // 1 minute window
};

function checkRateLimit(ip) {
  const now = Date.now();
  const state = rateLimitState.authAttempts.get(ip);

  if (state && state.lockedUntil && now < state.lockedUntil) {
    const remainingMs = state.lockedUntil - now;
    return { allowed: false, retryAfterMs: remainingMs };
  }

  return { allowed: true };
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const state = rateLimitState.authAttempts.get(ip) || { attempts: 0, lastAttempt: 0 };

  // Reset if outside window
  if (now - state.lastAttempt > RATE_LIMIT_CONFIG.authWindowMs) {
    state.attempts = 0;
  }

  state.attempts++;
  state.lastAttempt = now;

  if (state.attempts >= RATE_LIMIT_CONFIG.maxAuthAttempts) {
    state.lockedUntil = now + RATE_LIMIT_CONFIG.authLockoutMs;
    auditLog("AUTH_LOCKOUT", { ip, attempts: state.attempts });
  }

  rateLimitState.authAttempts.set(ip, state);
}

function recordAuthSuccess(ip) {
  rateLimitState.authAttempts.delete(ip);
}

function checkRequestRateLimit(ip) {
  const now = Date.now();
  let state = rateLimitState.requestCounts.get(ip);

  if (!state || now - state.windowStart > RATE_LIMIT_CONFIG.requestWindowMs) {
    state = { requests: [], windowStart: now };
  }

  // Remove requests outside current window
  state.requests = state.requests.filter(t => now - t < RATE_LIMIT_CONFIG.requestWindowMs);

  if (state.requests.length >= RATE_LIMIT_CONFIG.maxRequestsPerMinute) {
    return { allowed: false, retryAfterMs: RATE_LIMIT_CONFIG.requestWindowMs - (now - state.requests[0]) };
  }

  state.requests.push(now);
  rateLimitState.requestCounts.set(ip, state);
  return { allowed: true };
}

// === AUDIT LOGGING ===
// Security event logging for forensics and monitoring
function auditLog(event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  // Log to stdout in JSON format for log aggregation
  console.log(`[AUDIT] ${JSON.stringify(entry)}`);
}

// Cleanup stale rate limit entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of rateLimitState.authAttempts) {
    if (state.lockedUntil && now > state.lockedUntil + RATE_LIMIT_CONFIG.authWindowMs) {
      rateLimitState.authAttempts.delete(ip);
    }
  }
  for (const [ip, state] of rateLimitState.requestCounts) {
    if (now - state.windowStart > RATE_LIMIT_CONFIG.requestWindowMs * 2) {
      rateLimitState.requestCounts.delete(ip);
    }
  }
}, 5 * 60 * 1000);

app.use(express.json({ limit: "1mb" }));

// Health endpoint for Railway (primary)
app.get("/health", (_req, res) => {
  const status = {
    ok: true,
    configured: isConfigured(),
    gateway: gatewayProc ? "running" : "stopped",
    timestamp: new Date().toISOString()
  };
  res.json(status);
});

// Legacy health endpoint for backward compatibility
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

// Helper to generate HTML for auth group options
function renderAuthGroupOptions(selectedGroup) {
  return AUTH_GROUPS.map(g => {
    const selected = g.value === selectedGroup ? ' selected' : '';
    const label = g.label + (g.hint ? ' - ' + g.hint : '');
    return `<option value="${g.value}"${selected}>${label}</option>`;
  }).join('\n        ');
}

// Helper to generate HTML for all auth choice options (grouped by optgroup)
function renderAuthChoiceOptions(selectedChoice) {
  return AUTH_GROUPS.map(g => {
    const options = g.options.map(o => {
      const selected = o.value === selectedChoice ? ' selected' : '';
      const label = o.label + (o.hint ? ' - ' + o.hint : '');
      return `<option value="${o.value}" data-group="${g.value}" data-keytype="${o.keyType}"${selected}>${label}</option>`;
    }).join('\n          ');
    return `<optgroup label="${g.label}" data-group="${g.value}">\n          ${options}\n        </optgroup>`;
  }).join('\n        ');
}

// Helper to generate flow options
function renderFlowOptions(selectedFlow) {
  const flows = ['quickstart', 'advanced', 'manual'];
  return flows.map(f => {
    const selected = f === selectedFlow ? ' selected' : '';
    return `<option value="${f}"${selected}>${f}</option>`;
  }).join('\n        ');
}

app.get("/setup", requireSetupAuth, (_req, res) => {
  // Load existing config values for pre-population
  const formConfig = loadConfigForForm();

  // Determine which group should be selected (based on saved choice or default to first)
  let selectedGroup = AUTH_GROUPS[0].value;
  if (formConfig.authChoice) {
    const found = findAuthOption(formConfig.authChoice);
    if (found) selectedGroup = found.group.value;
  }

  // Generate the static HTML options
  const authGroupOptionsHtml = renderAuthGroupOptions(selectedGroup);
  const authChoiceOptionsHtml = renderAuthChoiceOptions(formConfig.authChoice);
  const flowOptionsHtml = renderFlowOptions(formConfig.flow || 'quickstart');

  // Embed auth groups as JSON for JavaScript cascading behavior
  const authGroupsJson = JSON.stringify(AUTH_GROUPS);

  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
    .config-hint { font-size: 0.85em; color: #666; margin-top: 0.25rem; }
    .has-secret { color: #065f46; }
  </style>
</head>
<body>
  <h1>OpenClaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card" style="border: 2px solid #374151;">
    <h2>🩺 Health Check</h2>
    <p class="muted">Check system health and automatically fix common issues like missing directories and permissions.</p>

    <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:1rem">
      <button id="healthCheck" style="background:#1e40af; flex:1">Run Health Check</button>
      <button id="fixAllIssues" style="background:#065f46; flex:1">Fix All Issues</button>
    </div>
    <div id="healthStatus" style="padding:0.75rem; background:#1f2937; border-radius:0.375rem; margin-bottom:0.5rem; display:none">
      <div id="healthStatusText" style="font-weight:500"></div>
      <div id="healthProgress" class="muted" style="font-size:0.9em; margin-top:0.25rem"></div>
    </div>
    <pre id="healthOut" style="white-space:pre-wrap; max-height:300px; overflow-y:auto"></pre>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap">
      <select id="consoleCmd" style="flex: 2; min-width:200px">
        <optgroup label="🔧 Gateway (wrapper-managed)">
          <option value="gateway.restart">gateway.restart</option>
          <option value="gateway.stop">gateway.stop</option>
          <option value="gateway.start">gateway.start</option>
        </optgroup>
        <optgroup label="🔍 Diagnostics">
          <option value="openclaw.doctor">openclaw doctor</option>
          <option value="openclaw.doctor.fix">openclaw doctor --fix</option>
          <option value="openclaw.status">openclaw status</option>
          <option value="openclaw.health">openclaw health</option>
          <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        </optgroup>
        <optgroup label="🛡️ Security">
          <option value="openclaw.security.audit">openclaw security audit</option>
        </optgroup>
        <optgroup label="⚙️ Configuration">
          <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
          <option value="openclaw.version">openclaw --version</option>
        </optgroup>
        <optgroup label="🛠️ Wrapper Utilities">
          <option value="wrapper.fix.dirs">Fix missing directories</option>
          <option value="wrapper.fix.permissions">Fix directory permissions</option>
          <option value="wrapper.env.check">Check environment</option>
        </optgroup>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port, deep)" style="flex: 1; min-width:150px" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <div id="consoleArgHint" class="muted" style="font-size:0.85em; margin-top:0.25rem"></div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup">
        ${authGroupOptionsHtml}
    </select>

    <label>Auth method</label>
    <select id="authChoice">
        ${authChoiceOptionsHtml}
    </select>
    ${formConfig.authKeyType ? `<div class="config-hint">Saved key type: <code>${formConfig.authKeyType}</code></div>` : ''}

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />
    ${formConfig.hasSecret ? '<div class="config-hint has-secret">A secret is already configured. Leave blank to keep existing.</div>' : ''}

    <label>Wizard flow</label>
    <select id="flow">
        ${flowOptionsHtml}
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside OpenClaw, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    ${formConfig.telegramEnabled ? '<div class="config-hint has-secret">Telegram is currently enabled in config.</div>' : ''}
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    ${formConfig.discordEnabled ? '<div class="config-hint has-secret">Discord is currently enabled in config.</div>' : ''}
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />
    ${formConfig.slackEnabled ? '<div class="config-hint has-secret">Slack is currently enabled in config.</div>' : ''}

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingList" style="background:#1e3a5f; margin-left:0.5rem">List pending</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="pairingApproveAll" style="background:#065f46; margin-left:0.5rem">Approve all</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">
      <strong>Pairing required?</strong> When users message your bot, they receive a pairing code. Use "List pending" to see codes, then "Approve pairing" (single) or "Approve all" (batch).<br/>
      Reset deletes the OpenClaw config file so you can rerun onboarding.
    </p>
  </div>

  <!-- Embed auth groups data for JavaScript cascading behavior -->
  <script id="authGroupsData" type="application/json">${authGroupsJson}</script>
  <script src="/setup/app.js"></script>
</body>
</html>`);
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  // Load existing config for status display
  const formConfig = loadConfigForForm();

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
    // Include saved config info (non-sensitive)
    savedAuth: {
      provider: formConfig.authProvider,
      choice: formConfig.authChoice,
      keyType: formConfig.authKeyType,
      hasSecret: formConfig.hasSecret,
    },
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart"
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key"
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        // Backward-compat aliases
        CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
        CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const payload = req.body || {};
  const onboardArgs = buildOnboardArgs(payload);
  const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
  if (ok) {
    // Ensure gateway token is written into config so the browser UI can authenticate reliably.
    // (We also enforce loopback bind since the wrapper proxies externally.)
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    // Save auth info explicitly (provider, choice, keyType) so we don't have to infer from the key
    if (payload.authChoice) {
      const authInfo = findAuthOption(payload.authChoice);
      const authConfig = {
        choice: payload.authChoice,
        provider: authInfo ? authInfo.group.value : null,
        keyType: authInfo ? authInfo.option.keyType : null,
        // Mark that a secret was provided (don't store the actual secret here)
        secretSet: Boolean((payload.authSecret || "").trim()),
      };
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "auth", JSON.stringify(authConfig)]));
      extra += `\n[auth] Saved auth config: provider=${authConfig.provider}, choice=${authConfig.choice}, keyType=${authConfig.keyType}\n`;
    }

    // Apply security hardening configuration
    // Security: require pairing for DM policy (users must be approved before chatting)
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "security.dmPolicy", "pairing"]));

    // Security: require approval for high-risk actions
    const requireApproval = JSON.stringify(["file_write", "network_request", "shell_command"]);
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "security.requireApprovalFor", requireApproval]));

    // Security: enable sandbox mode for non-main agent sessions
    const sandboxConfig = JSON.stringify({
      mode: "non-main",
      docker: {
        readOnly: true,
        capDrop: ["ALL"],
        networkMode: "none",
        memoryLimit: "512m",
        cpuLimit: "0.5"
      }
    });
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.sandbox", sandboxConfig]));

    extra += "\n[security] Applied security hardening configuration\n";

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();
  }

  return res.status(ok ? 200 : 500).json({
    ok,
    output: `${onboard.output}${extra}`,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

// === SECRET REDACTION ===
// Comprehensive patterns for detecting and redacting sensitive data
// Based on common API key formats and credential patterns
const SECRET_PATTERNS = [
  // OpenAI API keys (sk-..., sk-proj-...)
  /(sk-[A-Za-z0-9_-]{10,})/g,
  /(sk-proj-[A-Za-z0-9_-]{10,})/g,
  // Anthropic API keys
  /(sk-ant-[A-Za-z0-9_-]{10,})/g,
  // GitHub tokens (classic and fine-grained)
  /(ghp_[A-Za-z0-9]{36,})/g,
  /(gho_[A-Za-z0-9_]{10,})/g,
  /(ghs_[A-Za-z0-9]{36,})/g,
  /(ghu_[A-Za-z0-9]{36,})/g,
  /(github_pat_[A-Za-z0-9_]{22,})/g,
  // Slack tokens
  /(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  /(xapp-[A-Za-z0-9-]{10,})/g,
  // Telegram bot tokens
  /(AA[A-Za-z0-9_-]{10,}:\S{10,})/g,
  /(\d{8,12}:[A-Za-z0-9_-]{35,})/g,
  // Discord tokens
  /([A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})/g,
  // AWS keys
  /(AKIA[A-Z0-9]{16})/g,
  /(ABIA[A-Z0-9]{16})/g,
  /(ACCA[A-Z0-9]{16})/g,
  // Google API keys
  /(AIza[A-Za-z0-9_-]{35})/g,
  // Azure keys
  /([A-Za-z0-9+\/]{86}==)/g,
  // Generic JWT tokens (eyJ...)
  /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  // Generic API key patterns
  /([Aa]pi[_-]?[Kk]ey["']?\s*[:=]\s*["']?)([A-Za-z0-9_-]{20,})/g,
  /([Ss]ecret["']?\s*[:=]\s*["']?)([A-Za-z0-9_-]{20,})/g,
  /([Tt]oken["']?\s*[:=]\s*["']?)([A-Za-z0-9_-]{20,})/g,
  /([Pp]assword["']?\s*[:=]\s*["']?)([^\s"']{8,})/g,
  // Private keys
  /(-----BEGIN [A-Z ]+PRIVATE KEY-----)/g,
  // Bearer tokens in headers
  /(Bearer\s+[A-Za-z0-9_-]{20,})/gi,
];

function redactSecrets(text) {
  if (!text) return text;
  let result = String(text);

  // Apply all secret patterns
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, ...groups) => {
      // For patterns with capture groups for context (like api_key=XXX), preserve context
      if (groups.length > 2 && typeof groups[0] === "string" && typeof groups[1] === "string") {
        return groups[0] + "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }

  return result;
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.doctor.fix",
  "openclaw.security.audit",
  "openclaw.logs.tail",
  "openclaw.config.get",

  // Wrapper utilities for fixing common issues
  "wrapper.fix.dirs",
  "wrapper.fix.permissions",
  "wrapper.env.check",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    auditLog("CONSOLE_CMD_BLOCKED", { ip, cmd, reason: "not in allowlist" });
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  auditLog("CONSOLE_CMD_EXECUTE", { ip, cmd, arg: arg || undefined });

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor.fix") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.security.audit") {
      const depth = arg === "deep" ? "--deep" : "";
      const args = depth ? ["security", "audit", depth] : ["security", "audit"];
      const r = await runCmd(OPENCLAW_NODE, clawArgs(args));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Wrapper utility commands for fixing common issues
    if (cmd === "wrapper.fix.dirs") {
      let output = "=== Fixing directory structure ===\n\n";
      const dirsToCreate = [
        path.join(STATE_DIR, "credentials"),
        path.join(STATE_DIR, "identity"),
        path.join(STATE_DIR, "logs"),
        path.join(STATE_DIR, "sessions"),
        path.join(WORKSPACE_DIR),
      ];
      for (const dir of dirsToCreate) {
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          output += `✓ Created/verified: ${dir}\n`;
        } catch (err) {
          output += `✗ Failed to create ${dir}: ${err.message}\n`;
        }
      }
      output += "\n=== Directory fix complete ===\n";
      return res.json({ ok: true, output });
    }
    if (cmd === "wrapper.fix.permissions") {
      let output = "=== Fixing directory permissions ===\n\n";
      const dirsToFix = [STATE_DIR, WORKSPACE_DIR];
      for (const dir of dirsToFix) {
        try {
          if (fs.existsSync(dir)) {
            fs.chmodSync(dir, 0o700);
            output += `✓ Set ${dir} to 700\n`;
          } else {
            output += `⚠ Directory does not exist: ${dir}\n`;
          }
        } catch (err) {
          output += `✗ Failed to chmod ${dir}: ${err.message}\n`;
        }
      }
      // Also fix subdirectories
      const subDirs = ["credentials", "identity", "logs", "sessions"];
      for (const sub of subDirs) {
        const subPath = path.join(STATE_DIR, sub);
        try {
          if (fs.existsSync(subPath)) {
            fs.chmodSync(subPath, 0o700);
            output += `✓ Set ${subPath} to 700\n`;
          }
        } catch (err) {
          output += `✗ Failed to chmod ${subPath}: ${err.message}\n`;
        }
      }
      output += "\n=== Permission fix complete ===\n";
      return res.json({ ok: true, output });
    }
    if (cmd === "wrapper.env.check") {
      let output = "=== Environment Check ===\n\n";
      output += `STATE_DIR: ${STATE_DIR}\n`;
      output += `WORKSPACE_DIR: ${WORKSPACE_DIR}\n`;
      output += `OPENCLAW_ENTRY: ${process.env.OPENCLAW_ENTRY || "(default)"}\n`;
      output += `OPENCLAW_NODE: ${OPENCLAW_NODE}\n`;
      output += `INTERNAL_GATEWAY_PORT: ${process.env.INTERNAL_GATEWAY_PORT || "18789"}\n\n`;

      // Check for deprecated env vars
      const deprecated = ["CLAWDBOT_WORKSPACE_DIR", "CLAWDBOT_STATE_DIR", "CLAWDBOT_GATEWAY_TOKEN"];
      const deprecatedFound = deprecated.filter((k) => process.env[k]);
      if (deprecatedFound.length > 0) {
        output += "⚠ Deprecated environment variables detected:\n";
        for (const k of deprecatedFound) {
          output += `  - ${k} (use OPENCLAW_${k.replace("CLAWDBOT_", "")} instead)\n`;
        }
        output += "\n";
      } else {
        output += "✓ No deprecated environment variables detected.\n\n";
      }

      // Check directory existence and permissions
      output += "Directory status:\n";
      for (const dir of [STATE_DIR, WORKSPACE_DIR]) {
        try {
          const stats = fs.statSync(dir);
          const mode = (stats.mode & 0o777).toString(8);
          output += `  ${dir}: exists (mode: ${mode})\n`;
        } catch {
          output += `  ${dir}: DOES NOT EXIST\n`;
        }
      }

      output += "\n=== Environment check complete ===\n";
      return res.json({ ok: true, output });
    }

    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Health check endpoint - runs doctor and returns structured results
app.get("/setup/api/health", requireSetupAuth, async (_req, res) => {
  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const output = redactSecrets(r.output);

    // Parse output to extract issues
    const issues = [];
    const lines = output.split("\n");
    for (const line of lines) {
      if (line.includes("CRITICAL") || line.includes("permission") || line.includes("missing") || line.includes("Error")) {
        issues.push(line.trim());
      }
    }

    res.json({
      ok: r.code === 0,
      healthy: r.code === 0 && issues.length === 0,
      issues,
      output,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Fix all issues endpoint - runs all fixes in sequence
app.post("/setup/api/health/fix-all", requireSetupAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  auditLog("HEALTH_FIX_ALL", { ip });

  const steps = [];
  let output = "╔══════════════════════════════════════════════════════════════╗\n";
  output += "║           🔧 AUTOMATIC ISSUE REPAIR IN PROGRESS 🔧           ║\n";
  output += "╚══════════════════════════════════════════════════════════════╝\n\n";

  // Step 1: Create missing directories
  output += "━━━ Step 1/4: Creating missing directories ━━━\n";
  const dirsToCreate = [
    path.join(STATE_DIR, "credentials"),
    path.join(STATE_DIR, "identity"),
    path.join(STATE_DIR, "logs"),
    path.join(STATE_DIR, "sessions"),
    WORKSPACE_DIR,
  ];
  let dirSuccess = true;
  for (const dir of dirsToCreate) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      output += `  ✓ ${dir}\n`;
    } catch (err) {
      output += `  ✗ ${dir}: ${err.message}\n`;
      dirSuccess = false;
    }
  }
  steps.push({ name: "Create directories", ok: dirSuccess });
  output += "\n";

  // Step 2: Fix permissions
  output += "━━━ Step 2/4: Fixing directory permissions ━━━\n";
  let permSuccess = true;
  const dirsToFix = [STATE_DIR, WORKSPACE_DIR, ...dirsToCreate.filter((d) => d !== WORKSPACE_DIR)];
  for (const dir of dirsToFix) {
    try {
      if (fs.existsSync(dir)) {
        fs.chmodSync(dir, 0o700);
        output += `  ✓ chmod 700 ${dir}\n`;
      }
    } catch (err) {
      output += `  ✗ ${dir}: ${err.message}\n`;
      permSuccess = false;
    }
  }
  steps.push({ name: "Fix permissions", ok: permSuccess });
  output += "\n";

  // Step 3: Run openclaw doctor --fix
  output += "━━━ Step 3/4: Running openclaw doctor --fix ━━━\n";
  const doctorResult = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
  const doctorOk = doctorResult.code === 0;
  output += redactSecrets(doctorResult.output) + "\n";
  steps.push({ name: "OpenClaw doctor --fix", ok: doctorOk });

  // Step 4: Restart gateway
  output += "━━━ Step 4/4: Restarting gateway ━━━\n";
  try {
    await restartGateway();
    output += "  ✓ Gateway restarted successfully\n";
    steps.push({ name: "Restart gateway", ok: true });
  } catch (err) {
    output += `  ✗ Gateway restart failed: ${err.message}\n`;
    steps.push({ name: "Restart gateway", ok: false });
  }
  output += "\n";

  // Final health check
  output += "━━━ Final Health Check ━━━\n";
  const finalCheck = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
  const finalHealthy = finalCheck.code === 0;
  output += redactSecrets(finalCheck.output) + "\n";

  // Summary
  const allOk = steps.every((s) => s.ok);
  output += "╔══════════════════════════════════════════════════════════════╗\n";
  output += allOk
    ? "║                    ✅ ALL REPAIRS COMPLETE                    ║\n"
    : "║              ⚠️  SOME REPAIRS MAY HAVE FAILED                 ║\n";
  output += "╚══════════════════════════════════════════════════════════════╝\n";
  output += "\nSummary:\n";
  for (const step of steps) {
    output += `  ${step.ok ? "✓" : "✗"} ${step.name}\n`;
  }

  auditLog("HEALTH_FIX_ALL_COMPLETE", { ip, allOk, finalHealthy, steps });

  res.json({
    ok: allOk,
    healthy: finalHealthy,
    steps,
    output,
  });
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      auditLog("CONFIG_SAVE_BLOCKED", { ip, reason: "content too large", size: content.length });
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    auditLog("CONFIG_SAVE", { ip, size: content.length });

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  auditLog("PAIRING_APPROVE", { ip, channel, code });

  // Try with --channel flag first, then positional
  let r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", "--channel", String(channel), String(code)]));
  if (r.code !== 0) {
    r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  }

  if (r.code === 0) {
    auditLog("PAIRING_APPROVED", { ip, channel, code });
  } else {
    auditLog("PAIRING_APPROVE_FAILED", { ip, channel, code });
  }
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

// List pending pairing requests
app.get("/setup/api/pairing/pending", requireSetupAuth, async (req, res) => {
  // Try to list for all known channels
  const channels = ["telegram", "discord", "slack"];
  const allPending = [];
  let lastOutput = "";

  for (const channel of channels) {
    // Try with --channel flag first, then positional
    let r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", "--channel", channel, "--json"]));
    if (r.code !== 0) {
      // Fall back to positional argument
      r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", channel, "--json"]));
    }
    lastOutput = r.output;
    try {
      const pending = JSON.parse(r.output);
      if (Array.isArray(pending)) {
        for (const p of pending) {
          allPending.push({ ...p, channel: p.channel || channel });
        }
      }
    } catch {
      // Channel may not be configured or CLI format changed - ignore
    }
  }

  // Also try without channel for legacy compatibility
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", "--json"]));
  try {
    const pending = JSON.parse(r.output);
    if (Array.isArray(pending)) {
      for (const p of pending) {
        // Avoid duplicates
        const exists = allPending.some((x) => x.code === (p.code || p.pairingCode) && x.channel === (p.channel || p.type));
        if (!exists) allPending.push(p);
      }
    }
  } catch {
    // Ignore parse errors
  }

  return res.json({ ok: true, pending: allPending, output: allPending.length === 0 ? lastOutput : undefined });
});

// Approve all pending pairing requests (convenience endpoint)
app.post("/setup/api/pairing/approve-all", requireSetupAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  auditLog("PAIRING_APPROVE_ALL", { ip });

  // Collect pending from all channels using the updated method
  const channels = ["telegram", "discord", "slack"];
  let pending = [];

  for (const channel of channels) {
    let listResult = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", "--channel", channel, "--json"]));
    if (listResult.code !== 0) {
      listResult = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", channel, "--json"]));
    }
    try {
      const items = JSON.parse(listResult.output);
      if (Array.isArray(items)) {
        for (const p of items) {
          pending.push({ ...p, channel: p.channel || channel });
        }
      }
    } catch {
      // Channel not configured or parse error - ignore
    }
  }

  // Also try legacy format
  const legacyResult = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", "--json"]));
  try {
    const items = JSON.parse(legacyResult.output);
    if (Array.isArray(items)) {
      for (const p of items) {
        const exists = pending.some((x) => x.code === (p.code || p.pairingCode) && x.channel === (p.channel || p.type));
        if (!exists) pending.push(p);
      }
    }
  } catch {
    // Ignore
  }

  if (pending.length === 0) {
    return res.json({ ok: true, approved: 0, results: [], message: "No pending pairing requests found" });
  }

  const results = [];
  for (const pairingReq of pending) {
    const channel = pairingReq.channel || pairingReq.type;
    const code = pairingReq.code || pairingReq.pairingCode;
    if (channel && code) {
      // Try with --channel flag first, then positional
      let r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", "--channel", String(channel), String(code)]));
      if (r.code !== 0) {
        r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
      }
      results.push({ channel, code, ok: r.code === 0, output: r.output });
    }
  }

  return res.json({ ok: true, approved: results.length, results });
});

app.post("/setup/api/reset", requireSetupAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  auditLog("CONFIG_RESET", { ip });

  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    fs.rmSync(configPath(), { force: true });
    auditLog("CONFIG_RESET_SUCCESS", { ip });
    res.type("text/plain").send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    auditLog("CONFIG_RESET_FAILED", { ip, error: String(err) });
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  auditLog("BACKUP_EXPORT", { ip });

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  auditLog("BACKUP_IMPORT", { ip });

  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      auditLog("BACKUP_IMPORT_BLOCKED", { ip, reason: "directories not under /data" });
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    auditLog("BACKUP_IMPORT_SUCCESS", { ip });
    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }
  // Don't start gateway unless configured; proxy will ensure it starts.
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
