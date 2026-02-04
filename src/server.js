import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Observability module for structured logging, tracing, and metrics
import {
  logger,
  requestTracer,
  trackError,
  trackGatewayStart,
  trackGatewayRestart,
  trackGatewayCrash,
  getHealthStatus,
  getMetricsJson,
  getMetricsPrometheus,
  generateDiagnosticReport,
  metricsRouter,
  logStartupBanner,
  cloudflareContext,
} from "./observability.js";

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
// Returns { ok: boolean, error?: string }
function testDirUsable(dir, verbose = false) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (verbose) console.error(`[wrapper] Cannot create directory ${dir}: ${err.message}`);
    return { ok: false, error: `Cannot create directory: ${err.message}` };
  }

  // Test write access to the directory itself
  const testFile = path.join(dir, ".write-test");
  try {
    fs.writeFileSync(testFile, "test", { mode: 0o600 });
    fs.unlinkSync(testFile);
  } catch (err) {
    if (verbose) console.error(`[wrapper] Cannot write to ${dir}: ${err.message}`);
    return { ok: false, error: `Cannot write file: ${err.message}` };
  }

  // Also test that we can create subdirectories (critical for workspace)
  const testSubdir = path.join(dir, ".subdir-test");
  try {
    fs.mkdirSync(testSubdir, { recursive: true });
    fs.rmdirSync(testSubdir);
  } catch (err) {
    if (verbose) console.error(`[wrapper] Cannot create subdirs in ${dir}: ${err.message}`);
    return { ok: false, error: `Cannot create subdirectory: ${err.message}` };
  }

  return { ok: true };
}

// Detailed diagnosis of /data mount point
function diagnoseDataMount() {
  const diagnosis = {
    exists: false,
    isDirectory: false,
    writable: false,
    stats: null,
    error: null,
  };

  try {
    const stats = fs.statSync("/data");
    diagnosis.exists = true;
    diagnosis.isDirectory = stats.isDirectory();
    diagnosis.stats = {
      uid: stats.uid,
      gid: stats.gid,
      mode: (stats.mode & 0o777).toString(8),
    };

    // Try to write
    const testResult = testDirUsable("/data/.openclaw", false);
    diagnosis.writable = testResult.ok;
    if (!testResult.ok) {
      diagnosis.error = testResult.error;
    }
  } catch (err) {
    diagnosis.error = err.message;
  }

  return diagnosis;
}

function findWritableStateDir() {
  console.log("[wrapper] ========================================");
  console.log("[wrapper] Finding writable state directory...");
  console.log(`[wrapper] Process UID: ${process.getuid?.() ?? "N/A"}, GID: ${process.getgid?.() ?? "N/A"}`);
  console.log(`[wrapper] HOME: ${os.homedir()}`);

  // Diagnose /data mount point
  const dataDiagnosis = diagnoseDataMount();
  console.log(`[wrapper] /data diagnosis:`, JSON.stringify(dataDiagnosis));

  // If explicitly set via env, expand shell variables and validate
  const rawEnvDir = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (rawEnvDir) {
    const envDir = expandShellPath(rawEnvDir);
    console.log(`[wrapper] Env-specified state dir: ${rawEnvDir} -> ${envDir}`);

    const testResult = testDirUsable(envDir, true);
    if (testResult.ok) {
      console.log(`[wrapper] ✓ Using env-specified state dir: ${envDir}`);
      console.log("[wrapper] ========================================");
      return envDir;
    }
    console.warn(`[wrapper] ✗ Env-specified state dir not usable: ${testResult.error}`);
  }

  // Try candidate directories in order of preference
  // /data is the Railway volume mount - prioritize it for persistent storage
  const candidates = [
    { path: "/data/.openclaw", label: "Railway volume" },
    { path: path.join(os.homedir(), ".openclaw"), label: "Home directory" },
    { path: path.join(os.tmpdir(), ".openclaw"), label: "Temp directory (NOT PERSISTENT)" },
    { path: path.join(process.cwd(), ".openclaw"), label: "Current directory" },
  ];

  for (const candidate of candidates) {
    console.log(`[wrapper] Trying: ${candidate.path} (${candidate.label})`);
    const testResult = testDirUsable(candidate.path, true);
    if (testResult.ok) {
      console.log(`[wrapper] ✓ Using: ${candidate.path}`);

      // Warn if not using /data
      if (!candidate.path.startsWith("/data")) {
        console.warn("[wrapper] ========================================");
        console.warn("[wrapper] ⚠️  WARNING: NOT USING /data VOLUME!");
        console.warn("[wrapper] ⚠️  Data will NOT persist across restarts!");
        console.warn("[wrapper] ⚠️  Add a Railway volume mounted at /data");
        console.warn("[wrapper] ========================================");
      }

      console.log("[wrapper] ========================================");
      return candidate.path;
    }
    console.log(`[wrapper] ✗ ${candidate.path}: ${testResult.error}`);
  }

  // Last resort: use tmpdir directly with a unique subdirectory
  const fallback = path.join(os.tmpdir(), `openclaw-${process.pid}`);
  console.warn("[wrapper] ========================================");
  console.warn("[wrapper] ⚠️⚠️⚠️  CRITICAL: USING TEMP FALLBACK ⚠️⚠️⚠️");
  console.warn(`[wrapper] ⚠️  Path: ${fallback}`);
  console.warn("[wrapper] ⚠️  ALL DATA WILL BE LOST ON RESTART!");
  console.warn("[wrapper] ⚠️  This should NEVER happen in production!");
  console.warn("[wrapper] ========================================");

  try {
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    // If even tmpdir fails, just return the first candidate and let it fail later with a clear error
    return candidates[0].path;
  }
}

let STATE_DIR = findWritableStateDir();

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

let WORKSPACE_DIR = findWritableWorkspaceDir();

// Ensure directories are available with fallback logic
// Called at runtime to handle permission changes that may occur after initial setup
function ensureDirectoriesWithFallback() {
  // Try to create the configured directories
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      console.warn(`[wrapper] Permission denied for STATE_DIR: ${STATE_DIR}, finding fallback...`);
      STATE_DIR = findWritableStateDir();
      WORKSPACE_DIR = path.join(STATE_DIR, "workspace");
    } else {
      throw err;
    }
  }

  try {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      console.warn(`[wrapper] Permission denied for WORKSPACE_DIR: ${WORKSPACE_DIR}, finding fallback...`);
      // Try alternative workspace locations
      const alternatives = [
        path.join(STATE_DIR, "workspace"),
        path.join(os.homedir(), ".openclaw", "workspace"),
        path.join(os.tmpdir(), `openclaw-workspace-${process.pid}`),
      ];

      let found = false;
      for (const alt of alternatives) {
        try {
          fs.mkdirSync(alt, { recursive: true, mode: 0o700 });
          WORKSPACE_DIR = alt;
          console.log(`[wrapper] Using fallback workspace: ${WORKSPACE_DIR}`);
          found = true;
          break;
        } catch {
          continue;
        }
      }

      if (!found) {
        throw new Error(`Cannot create workspace directory. Tried: ${WORKSPACE_DIR}, ${alternatives.join(", ")}`);
      }
    } else {
      throw err;
    }
  }

  // Verify both directories are truly usable
  const stateTest = testDirUsable(STATE_DIR, true);
  if (!stateTest.ok) {
    console.warn(`[wrapper] STATE_DIR ${STATE_DIR} failed usability test: ${stateTest.error}`);
    STATE_DIR = findWritableStateDir();
    WORKSPACE_DIR = path.join(STATE_DIR, "workspace");
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  }

  const workspaceTest = testDirUsable(WORKSPACE_DIR, true);
  if (!workspaceTest.ok) {
    console.warn(`[wrapper] WORKSPACE_DIR ${WORKSPACE_DIR} failed usability test: ${workspaceTest.error}`);
    WORKSPACE_DIR = path.join(STATE_DIR, "workspace");
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  }

  return { stateDir: STATE_DIR, workspaceDir: WORKSPACE_DIR };
}

// Check if data is truly persistent (using /data Railway volume)
// This helps users understand if their data will survive container restarts
function checkDataPersistence() {
  const isPersistent = process.env.OPENCLAW_DATA_PERSISTENT === "true" ||
    STATE_DIR.startsWith("/data");
  const isVolumeMounted = fs.existsSync("/data") && STATE_DIR.startsWith("/data");
  const storageType = STATE_DIR.startsWith("/data")
    ? "railway-volume"
    : STATE_DIR.startsWith("/tmp")
      ? "temporary"
      : STATE_DIR.includes("/home/")
        ? "home-directory"
        : "unknown";

  return {
    persistent: isPersistent && isVolumeMounted,
    storageType,
    stateDir: STATE_DIR,
    workspaceDir: WORKSPACE_DIR,
    warning: !isPersistent || !isVolumeMounted
      ? "Data may not persist across container restarts. Add a Railway volume mounted at /data."
      : null,
  };
}

const DATA_PERSISTENCE = checkDataPersistence();

// Log persistence warning at startup
if (!DATA_PERSISTENCE.persistent) {
  console.warn(`[wrapper] ⚠️ WARNING: Data persistence issue detected!`);
  console.warn(`[wrapper] Storage type: ${DATA_PERSISTENCE.storageType}`);
  console.warn(`[wrapper] State directory: ${DATA_PERSISTENCE.stateDir}`);
  console.warn(`[wrapper] ${DATA_PERSISTENCE.warning}`);
}

// Create symlinks between /data and ~/ for convenience
function setupDataHomeSymlinks() {
  const homeDir = os.homedir();
  const dataDir = "/data";

  console.log("[wrapper] Setting up symlinks between /data and ~/...");

  // Only proceed if /data exists and is a directory
  if (!fs.existsSync(dataDir)) {
    console.log("[wrapper] /data does not exist, skipping symlink setup");
    return { ok: false, reason: "/data does not exist" };
  }

  try {
    const dataStats = fs.statSync(dataDir);
    if (!dataStats.isDirectory()) {
      console.log("[wrapper] /data is not a directory, skipping symlink setup");
      return { ok: false, reason: "/data is not a directory" };
    }
  } catch (err) {
    console.warn(`[wrapper] Cannot stat /data: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  const results = { homeToData: null, dataToHome: null };

  // Create ~/data -> /data symlink (access /data from home)
  const homeDataLink = path.join(homeDir, "data");
  try {
    // Check if symlink already exists and points to the right place
    if (fs.existsSync(homeDataLink)) {
      const linkStats = fs.lstatSync(homeDataLink);
      if (linkStats.isSymbolicLink()) {
        const target = fs.readlinkSync(homeDataLink);
        if (target === dataDir) {
          console.log(`[wrapper] ✓ ~/data -> /data symlink already exists`);
          results.homeToData = "exists";
        } else {
          // Remove incorrect symlink and recreate
          fs.unlinkSync(homeDataLink);
          fs.symlinkSync(dataDir, homeDataLink);
          console.log(`[wrapper] ✓ Updated ~/data -> /data symlink`);
          results.homeToData = "updated";
        }
      } else {
        console.log(`[wrapper] ~/data exists but is not a symlink, skipping`);
        results.homeToData = "skipped (not a symlink)";
      }
    } else {
      // Create new symlink
      fs.symlinkSync(dataDir, homeDataLink);
      console.log(`[wrapper] ✓ Created ~/data -> /data symlink`);
      results.homeToData = "created";
    }
  } catch (err) {
    console.warn(`[wrapper] Failed to create ~/data symlink: ${err.message}`);
    results.homeToData = `error: ${err.message}`;
  }

  // Create /data/home -> ~/ symlink (access home from /data)
  const dataHomeLink = path.join(dataDir, "home");
  try {
    if (fs.existsSync(dataHomeLink)) {
      const linkStats = fs.lstatSync(dataHomeLink);
      if (linkStats.isSymbolicLink()) {
        const target = fs.readlinkSync(dataHomeLink);
        if (target === homeDir) {
          console.log(`[wrapper] ✓ /data/home -> ~/ symlink already exists`);
          results.dataToHome = "exists";
        } else {
          fs.unlinkSync(dataHomeLink);
          fs.symlinkSync(homeDir, dataHomeLink);
          console.log(`[wrapper] ✓ Updated /data/home -> ~/ symlink`);
          results.dataToHome = "updated";
        }
      } else {
        console.log(`[wrapper] /data/home exists but is not a symlink, skipping`);
        results.dataToHome = "skipped (not a symlink)";
      }
    } else {
      fs.symlinkSync(homeDir, dataHomeLink);
      console.log(`[wrapper] ✓ Created /data/home -> ~/ symlink`);
      results.dataToHome = "created";
    }
  } catch (err) {
    console.warn(`[wrapper] Failed to create /data/home symlink: ${err.message}`);
    results.dataToHome = `error: ${err.message}`;
  }

  return { ok: true, results };
}

// Set up symlinks at startup
const SYMLINK_SETUP = setupDataHomeSymlinks();
if (SYMLINK_SETUP.ok) {
  console.log("[wrapper] Symlink setup complete:", JSON.stringify(SYMLINK_SETUP.results));
}

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

  // Ensure directories exist with fallback logic for permission errors
  try {
    ensureDirectoriesWithFallback();
    console.log(`[wrapper] Using STATE_DIR: ${STATE_DIR}`);
    console.log(`[wrapper] Using WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  } catch (err) {
    console.error(`[wrapper] Failed to create directories: ${err.message}`);
    throw new Error(`Cannot create required directories: ${err.message}`);
  }

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

  // Track gateway start
  trackGatewayStart();

  gatewayProc.on("error", (err) => {
    logger.error("Gateway spawn error", { error: err.message, code: err.code });
    trackError(err, { context: "gateway_spawn" });
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    // Track as crash if exit was unexpected (non-zero code or signal)
    if (code !== 0 || signal) {
      trackGatewayCrash(code, signal);
    }
    logger.warn("Gateway exited", { exitCode: code, signal });
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
    trackGatewayRestart();
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

// === REQUEST TRACING MIDDLEWARE ===
// Add tracing context and Cloudflare integration for all requests
app.use(requestTracer());

// Health endpoint for Railway (primary)
app.get("/health", (_req, res) => {
  const status = {
    ok: true,
    configured: isConfigured(),
    gateway: gatewayProc ? "running" : "stopped",
    storage: {
      persistent: DATA_PERSISTENCE.persistent,
      type: DATA_PERSISTENCE.storageType,
    },
    timestamp: new Date().toISOString()
  };
  res.json(status);
});

// === OBSERVABILITY ENDPOINTS ===
// Detailed health with system metrics
app.get("/health/detailed", (_req, res) => {
  const health = getHealthStatus(isConfigured(), gatewayProc);
  health.storage = DATA_PERSISTENCE;
  res.json(health);
});

// Storage-specific health check - useful for debugging persistence issues
app.get("/health/storage", (_req, res) => {
  const volumeExists = fs.existsSync("/data");
  let volumeWritable = false;
  let volumeStats = null;

  if (volumeExists) {
    try {
      const testPath = "/data/.write-test-" + Date.now();
      fs.writeFileSync(testPath, "test");
      fs.unlinkSync(testPath);
      volumeWritable = true;
    } catch {
      volumeWritable = false;
    }

    try {
      const stats = fs.statSync("/data");
      volumeStats = {
        uid: stats.uid,
        gid: stats.gid,
        mode: stats.mode.toString(8),
      };
    } catch {
      // ignore
    }
  }

  const storageStatus = {
    ...DATA_PERSISTENCE,
    volume: {
      path: "/data",
      exists: volumeExists,
      writable: volumeWritable,
      stats: volumeStats,
    },
    environment: {
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR || "(not set)",
      OPENCLAW_WORKSPACE_DIR: process.env.OPENCLAW_WORKSPACE_DIR || "(not set)",
      OPENCLAW_DATA_PERSISTENT: process.env.OPENCLAW_DATA_PERSISTENT || "(not set)",
      HOME: process.env.HOME || "(not set)",
    },
    recommendation: !DATA_PERSISTENCE.persistent
      ? "Add a Railway volume mounted at /data to enable persistent storage"
      : "Storage is properly configured for persistence",
  };

  res.json(storageStatus);
});

// JSON metrics for dashboards
app.get("/metrics", (_req, res) => {
  res.json(getMetricsJson());
});

// Prometheus-compatible metrics
app.get("/metrics/prometheus", (_req, res) => {
  res.type("text/plain").send(getMetricsPrometheus());
});

// Full diagnostic report
app.get("/diagnostics", async (_req, res) => {
  const report = await generateDiagnosticReport({
    isConfigured: isConfigured(),
    gatewayProc,
    stateDir: STATE_DIR,
    workspaceDir: WORKSPACE_DIR,
  });
  res.json(report);
});

// Legacy health endpoint for backward compatibility
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

// Autologin endpoint - sets auth cookie and redirects to OpenClaw UI
// This allows users to seamlessly access the full UI after dashboard login
app.get("/setup/autologin", requireSetupAuth, (_req, res) => {
  if (!isConfigured()) {
    return res.redirect("/setup");
  }

  // Set the gateway auth token as a cookie for the browser
  // The cookie is httpOnly: false so client JS can read it if needed
  // secure: true in production (when not localhost)
  const isLocalhost = _req.hostname === "localhost" || _req.hostname === "127.0.0.1";

  // Set multiple cookie formats to maximize compatibility with different gateway versions
  // openclaw-token: primary token cookie
  res.cookie("openclaw-token", OPENCLAW_GATEWAY_TOKEN, {
    httpOnly: false,
    secure: !isLocalhost,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: "/",
  });

  // gateway-token: alternative name
  res.cookie("gateway-token", OPENCLAW_GATEWAY_TOKEN, {
    httpOnly: false,
    secure: !isLocalhost,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });

  // Also set in localStorage-compatible format via a redirect page
  // This ensures the token is available however the gateway expects it
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Logging in to OpenClaw...</title>
  <style>
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .loader {
      text-align: center;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #262626;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .message {
      color: #a3a3a3;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="loader">
    <div class="spinner"></div>
    <div class="message">Logging in to OpenClaw...</div>
  </div>
  <script>
    // Store token in localStorage for gateway UI
    try {
      localStorage.setItem('openclaw-token', '${OPENCLAW_GATEWAY_TOKEN}');
      localStorage.setItem('gateway-token', '${OPENCLAW_GATEWAY_TOKEN}');
      localStorage.setItem('authToken', '${OPENCLAW_GATEWAY_TOKEN}');
    } catch (e) {
      console.warn('Could not set localStorage:', e);
    }
    // Redirect to OpenClaw UI with token as query param (fallback)
    setTimeout(function() {
      window.location.href = '/openclaw?token=' + encodeURIComponent('${OPENCLAW_GATEWAY_TOKEN}');
    }, 500);
  </script>
</body>
</html>`);
});

// API endpoint to get the gateway token (for programmatic access)
app.get("/setup/api/gateway-token", requireSetupAuth, (_req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ ok: false, error: "Not configured" });
  }
  res.json({
    ok: true,
    token: OPENCLAW_GATEWAY_TOKEN,
    usage: "Use this token to authenticate with the OpenClaw gateway",
  });
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
    :root {
      --bg-primary: #0a0a0a;
      --bg-secondary: #111111;
      --bg-card: #171717;
      --bg-card-hover: #1f1f1f;
      --border-color: #262626;
      --border-accent: #374151;
      --text-primary: #f5f5f5;
      --text-secondary: #a3a3a3;
      --text-muted: #737373;
      --accent-blue: #3b82f6;
      --accent-green: #10b981;
      --accent-purple: #8b5cf6;
      --accent-orange: #f59e0b;
      --accent-red: #ef4444;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
    }

    * { box-sizing: border-box; }

    body {
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      margin: 0;
      padding: 1.5rem;
      min-height: 100vh;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border-color);
    }

    .header h1 {
      font-size: 2rem;
      font-weight: 700;
      margin: 0 0 0.5rem 0;
      background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .header p {
      color: var(--text-secondary);
      margin: 0;
      font-size: 0.95rem;
    }

    /* Split Layout - Bento Left, Chat Right */
    .split-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      min-height: calc(100vh - 140px);
    }

    .bento-panel {
      overflow-y: auto;
      max-height: calc(100vh - 140px);
      padding-right: 0.5rem;
    }

    .chat-panel {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 140px);
      position: sticky;
      top: 1rem;
    }

    /* Bento Grid Layout - Compact */
    .bento-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 0.75rem;
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      padding: 1rem;
      transition: border-color 0.2s, background 0.2s;
    }

    .card:hover {
      border-color: var(--border-accent);
    }

    .card h2 {
      font-size: 0.9rem;
      font-weight: 600;
      margin: 0 0 0.5rem 0;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .card h2 .icon {
      font-size: 1rem;
    }

    .card p.desc {
      color: var(--text-muted);
      font-size: 0.8rem;
      margin: 0 0 0.75rem 0;
      line-height: 1.4;
    }

    /* Card sizes - Compact Bento */
    .card-status { grid-column: span 4; }
    .card-health { grid-column: span 2; }
    .card-troubleshooter { grid-column: span 3; }
    .card-console { grid-column: span 3; }
    .card-config { grid-column: span 3; }
    .card-auth { grid-column: span 3; }
    .card-channels { grid-column: span 3; }
    .card-onboarding { grid-column: span 3; }

    /* Mobile: Stack vertically */
    @media (max-width: 1024px) {
      .split-layout {
        grid-template-columns: 1fr;
        min-height: auto;
      }
      .bento-panel {
        max-height: none;
        overflow-y: visible;
        padding-right: 0;
      }
      .chat-panel {
        height: 500px;
        position: relative;
        top: 0;
      }
      .bento-grid {
        grid-template-columns: repeat(6, 1fr);
      }
      .card-status, .card-health, .card-troubleshooter, .card-console, .card-config,
      .card-auth, .card-channels, .card-onboarding {
        grid-column: span 6;
      }
    }

    /* Medium screens */
    @media (min-width: 1025px) and (max-width: 1400px) {
      .card-status { grid-column: span 4; }
      .card-health { grid-column: span 2; }
      .card-troubleshooter { grid-column: span 3; }
      .card-console { grid-column: span 3; }
      .card-config { grid-column: span 3; }
      .card-auth { grid-column: span 3; }
      .card-channels { grid-column: span 3; }
      .card-onboarding { grid-column: span 3; }
    }

    /* Troubleshooter status box */
    .troubleshoot-status {
      padding: 0.75rem 1rem;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      margin: 0.75rem 0;
      border-left: 3px solid var(--accent-purple);
    }

    .troubleshoot-status-text { font-weight: 500; font-size: 0.9rem; }
    .troubleshoot-progress { color: var(--text-muted); font-size: 0.8rem; margin-top: 0.25rem; }

    /* Direct Chat styles */
    .chat-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 400px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      background: var(--bg-secondary);
      overflow: hidden;
    }

    .chat-panel .card-chat {
      display: flex;
      flex-direction: column;
      flex: 1;
      height: 100%;
    }

    .chat-panel .card-chat .chat-container {
      flex: 1;
    }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .chat-message {
      max-width: 80%;
      padding: 0.75rem 1rem;
      border-radius: var(--radius-sm);
      font-size: 0.9rem;
      line-height: 1.5;
      word-wrap: break-word;
    }

    .chat-message.user {
      align-self: flex-end;
      background: var(--accent-blue);
      color: white;
    }

    .chat-message.assistant {
      align-self: flex-start;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
    }

    .chat-message.system {
      align-self: center;
      background: var(--bg-card);
      color: var(--text-muted);
      font-size: 0.8rem;
      padding: 0.5rem 1rem;
    }

    .chat-message.error {
      background: rgba(239, 68, 68, 0.2);
      border: 1px solid var(--accent-red);
      color: var(--accent-red);
    }

    .chat-message pre {
      background: var(--bg-primary);
      padding: 0.5rem;
      border-radius: 4px;
      overflow-x: auto;
      margin: 0.5rem 0 0 0;
      font-size: 0.8rem;
    }

    .chat-input-row {
      display: flex;
      gap: 0.5rem;
      padding: 0.75rem;
      border-top: 1px solid var(--border-color);
      background: var(--bg-card);
    }

    .chat-input-row input {
      flex: 1;
      margin: 0;
    }

    .chat-input-row button {
      flex-shrink: 0;
    }

    .chat-typing {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    .chat-typing-dots {
      display: flex;
      gap: 3px;
    }

    .chat-typing-dots span {
      width: 6px;
      height: 6px;
      background: var(--text-muted);
      border-radius: 50%;
      animation: typing 1.4s infinite;
    }

    .chat-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .chat-typing-dots span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes typing {
      0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
      30% { opacity: 1; transform: translateY(-3px); }
    }

    /* Form elements */
    label {
      display: block;
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--text-secondary);
      margin-top: 0.75rem;
      margin-bottom: 0.25rem;
    }

    input, select, textarea {
      width: 100%;
      padding: 0.6rem 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 0.9rem;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }

    input::placeholder { color: var(--text-muted); }

    textarea {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8rem;
      resize: vertical;
    }

    select option, select optgroup {
      background: var(--bg-secondary);
      color: var(--text-primary);
    }

    /* Buttons */
    button {
      padding: 0.6rem 1rem;
      border-radius: var(--radius-sm);
      border: none;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      transition: transform 0.1s, opacity 0.2s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
    }

    button:hover { opacity: 0.9; }
    button:active { transform: scale(0.98); }

    .btn-primary { background: var(--accent-blue); color: white; }
    .btn-success { background: var(--accent-green); color: white; }
    .btn-purple { background: var(--accent-purple); color: white; }
    .btn-orange { background: var(--accent-orange); color: white; }
    .btn-dark { background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); }
    .btn-danger { background: var(--accent-red); color: white; }
    .btn-muted { background: #404040; color: var(--text-primary); }

    .btn-group {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .btn-group button { flex: 1; min-width: 100px; }

    /* Status indicator */
    .status-bar {
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      font-size: 0.9rem;
      border-left: 3px solid var(--accent-blue);
    }

    /* Links */
    a {
      color: var(--accent-blue);
      text-decoration: none;
      font-weight: 500;
    }

    a:hover { text-decoration: underline; }

    .link-group {
      display: flex;
      gap: 1rem;
      margin-top: 0.75rem;
      flex-wrap: wrap;
    }

    .link-group a {
      font-size: 0.85rem;
      padding: 0.4rem 0.75rem;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      transition: border-color 0.2s;
    }

    .link-group a:hover {
      text-decoration: none;
      border-color: var(--accent-blue);
    }

    /* Code */
    code {
      background: var(--bg-secondary);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.85em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    /* Pre/output */
    pre {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      padding: 0.75rem;
      font-size: 0.8rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 250px;
      overflow-y: auto;
      margin: 0.75rem 0 0 0;
    }

    /* Health status box */
    .health-status {
      padding: 0.75rem 1rem;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      margin-bottom: 0.75rem;
      display: none;
      border-left: 3px solid var(--accent-blue);
    }

    .health-status-text { font-weight: 500; font-size: 0.9rem; }
    .health-progress { color: var(--text-muted); font-size: 0.8rem; margin-top: 0.25rem; }

    /* Hints */
    .hint {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.35rem;
      line-height: 1.4;
    }

    .hint.success { color: var(--accent-green); }

    /* Import section */
    .import-section {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-color);
    }

    .import-section input[type="file"] {
      padding: 0.5rem;
      font-size: 0.85rem;
    }

    /* Section divider */
    .section-divider {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin: 1rem 0;
      color: var(--text-muted);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .section-divider::before,
    .section-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border-color);
    }

    /* Console styling */
    .console-controls {
      display: flex;
      gap: 0.5rem;
      align-items: stretch;
      flex-wrap: wrap;
    }

    .console-controls select { flex: 2; min-width: 180px; }
    .console-controls input { flex: 1; min-width: 120px; }
    .console-controls button { flex-shrink: 0; }

    .console-hint {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
      font-style: italic;
    }

    /* Accent cards */
    .card-accent-health {
      border-color: var(--accent-green);
      background: linear-gradient(135deg, var(--bg-card) 0%, rgba(16, 185, 129, 0.05) 100%);
    }

    .card-accent-config {
      border-color: var(--accent-purple);
      background: linear-gradient(135deg, var(--bg-card) 0%, rgba(139, 92, 246, 0.05) 100%);
    }

    /* Autologin button styles */
    .btn-autologin:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(59, 130, 246, 0.3);
      text-decoration: none !important;
    }

    .btn-autologin:active {
      transform: translateY(0);
    }

    .autologin-section {
      position: relative;
    }

    /* Token copy button */
    .token-copy-btn {
      padding: 0.4rem 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .token-copy-btn:hover {
      background: var(--bg-card-hover);
      border-color: var(--accent-blue);
      color: var(--text-primary);
    }

    .token-copy-btn.copied {
      background: var(--accent-green);
      border-color: var(--accent-green);
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>OpenClaw Setup</h1>
      <p>Configure OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>
    </div>

    <div class="split-layout">
      <!-- Left Panel: Bento Grid -->
      <div class="bento-panel">
        <div class="bento-grid">
          <!-- Status Card -->
      <div class="card card-status">
        <h2><span class="icon">📊</span> Status</h2>
        <div class="status-bar" id="status">Loading...</div>

        <!-- Prominent Autologin Button -->
        <div class="autologin-section" style="margin: 1rem 0; padding: 1rem; background: linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%); border-radius: var(--radius-md); border: 1px solid var(--accent-blue);">
          <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
            <a href="/setup/autologin" class="btn-autologin" style="display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.5rem; background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple)); color: white; border-radius: var(--radius-sm); font-weight: 600; font-size: 1rem; text-decoration: none; transition: transform 0.1s, box-shadow 0.2s;">
              <span style="font-size: 1.2rem;">🚀</span> Open OpenClaw UI
            </a>
            <button id="copyTokenBtn" class="token-copy-btn" title="Copy gateway token for manual login">
              📋 Copy Token
            </button>
            <span style="color: var(--text-muted); font-size: 0.85rem;">Auto-login enabled</span>
          </div>
        </div>

        <div class="link-group">
          <a href="/openclaw" target="_blank">Direct UI (manual login)</a>
          <a href="/setup/export" target="_blank">Download Backup</a>
        </div>
        <div class="import-section">
          <label>Import backup (restores into <code>/data</code> and restarts)</label>
          <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
          <div style="margin-top: 0.5rem">
            <button id="importRun" class="btn-orange">Import Backup</button>
          </div>
          <pre id="importOut" style="display:none"></pre>
        </div>
      </div>

      <!-- Health Check Card -->
      <div class="card card-health card-accent-health">
        <h2><span class="icon">🩺</span> Health Check</h2>
        <p class="desc">Check system health and automatically fix common issues.</p>
        <div class="btn-group">
          <button id="healthCheck" class="btn-primary">Check</button>
          <button id="fixAllIssues" class="btn-success">Fix All</button>
        </div>
        <div class="health-status" id="healthStatus">
          <div class="health-status-text" id="healthStatusText"></div>
          <div class="health-progress" id="healthProgress"></div>
        </div>
        <pre id="healthOut" style="max-height:200px"></pre>
      </div>

      <!-- Troubleshooter Card -->
      <div class="card card-troubleshooter card-accent-health">
        <h2><span class="icon">🔧</span> Troubleshooter</h2>
        <p class="desc">Comprehensive system diagnostics with automatic issue detection and fixes.</p>
        <div class="btn-group">
          <button id="troubleshootQuick" class="btn-dark">Quick Check</button>
          <button id="troubleshootStandard" class="btn-primary">Standard</button>
          <button id="troubleshootDeep" class="btn-purple">Deep Scan</button>
        </div>
        <div class="troubleshoot-status" id="troubleshootStatus" style="display:none;">
          <div class="troubleshoot-status-text" id="troubleshootStatusText"></div>
          <div class="troubleshoot-progress" id="troubleshootProgress"></div>
        </div>
        <pre id="troubleshootOut" style="max-height:300px"></pre>
      </div>

      <!-- Debug Console Card -->
      <div class="card card-console">
        <h2><span class="icon">🖥️</span> Command Console</h2>
        <p class="desc">Run OpenClaw commands for debugging, management, and recovery.</p>
        <div class="console-controls">
          <select id="consoleCmd">
            <optgroup label="Troubleshooting">
              <option value="wrapper.troubleshoot">Troubleshoot (Standard)</option>
              <option value="wrapper.troubleshoot.quick">Troubleshoot (Quick)</option>
              <option value="wrapper.troubleshoot.deep">Troubleshoot (Deep)</option>
            </optgroup>
            <optgroup label="Gateway">
              <option value="gateway.restart">gateway restart</option>
              <option value="gateway.stop">gateway stop</option>
              <option value="gateway.start">gateway start</option>
              <option value="gateway.probe">gateway probe</option>
            </optgroup>
            <optgroup label="Core Diagnostics">
              <option value="openclaw.doctor">doctor</option>
              <option value="openclaw.doctor.fix">doctor --fix</option>
              <option value="openclaw.status">status</option>
              <option value="openclaw.status.all">status --all</option>
              <option value="openclaw.health">health</option>
              <option value="openclaw.version">version</option>
            </optgroup>
            <optgroup label="Updates">
              <option value="openclaw.update.check">update check</option>
              <option value="openclaw.update.run">update run</option>
            </optgroup>
            <optgroup label="Logs">
              <option value="openclaw.logs.tail">logs --tail</option>
              <option value="openclaw.logs.follow">logs --follow (5s)</option>
              <option value="openclaw.logs.clear">logs --clear</option>
            </optgroup>
            <optgroup label="Security">
              <option value="openclaw.security.audit">security audit</option>
              <option value="openclaw.security.audit.deep">security audit --deep</option>
            </optgroup>
            <optgroup label="Configuration">
              <option value="openclaw.config.get">config get</option>
              <option value="openclaw.config.list">config list</option>
              <option value="openclaw.config.validate">config validate</option>
            </optgroup>
            <optgroup label="Sessions">
              <option value="openclaw.sessions.list">sessions list</option>
              <option value="openclaw.sessions.active">sessions active</option>
              <option value="openclaw.sessions.clear">sessions clear</option>
            </optgroup>
            <optgroup label="Agents">
              <option value="openclaw.agents.list">agents list</option>
              <option value="openclaw.agents.status">agents status</option>
              <option value="openclaw.agents.restart">agents restart</option>
            </optgroup>
            <optgroup label="Memory">
              <option value="openclaw.memory.status">memory status</option>
              <option value="openclaw.memory.stats">memory stats</option>
              <option value="openclaw.memory.clear">memory clear</option>
            </optgroup>
            <optgroup label="Channels">
              <option value="openclaw.channels.list">channels list</option>
              <option value="openclaw.channels.status">channels status</option>
              <option value="openclaw.channels.test">channels test</option>
            </optgroup>
            <optgroup label="Pairing">
              <option value="openclaw.pairing.list">pairing list</option>
              <option value="openclaw.pairing.pending">pairing pending</option>
            </optgroup>
            <optgroup label="Wrapper Utilities">
              <option value="wrapper.fix.dirs">fix directories</option>
              <option value="wrapper.fix.permissions">fix permissions</option>
              <option value="wrapper.env.check">check environment</option>
              <option value="wrapper.storage.check">storage diagnostics</option>
              <option value="wrapper.network.check">network diagnostics</option>
            </optgroup>
          </select>
          <input id="consoleArg" placeholder="arg" />
          <button id="consoleRun" class="btn-dark">Run</button>
        </div>
        <div class="console-hint" id="consoleArgHint"></div>
        <pre id="consoleOut"></pre>
      </div>

      <!-- Config Editor Card -->
      <div class="card card-config card-accent-config">
        <h2><span class="icon">⚙️</span> Config Editor</h2>
        <p class="desc">Edit config file directly. Saves create timestamped backups.</p>
        <div class="hint" id="configPath"></div>
        <textarea id="configText" style="height: 180px; margin-top: 0.5rem"></textarea>
        <div class="btn-group" style="margin-top: 0.5rem">
          <button id="configReload" class="btn-dark">Reload</button>
          <button id="configSave" class="btn-purple">Save</button>
        </div>
        <pre id="configOut" style="display:none"></pre>
      </div>

      <!-- Auth Provider Card -->
      <div class="card card-auth">
        <h2><span class="icon">🔑</span> Auth Provider</h2>
        <label>Provider</label>
        <select id="authGroup">${authGroupOptionsHtml}</select>

        <label>Auth method</label>
        <select id="authChoice">${authChoiceOptionsHtml}</select>
        ${formConfig.authKeyType ? `<div class="hint">Saved: <code>${formConfig.authKeyType}</code></div>` : ''}

        <label>Key / Token</label>
        <input id="authSecret" type="password" placeholder="Paste API key or token" />
        ${formConfig.hasSecret ? '<div class="hint success">Secret configured</div>' : ''}

        <label>Wizard flow</label>
        <select id="flow">${flowOptionsHtml}</select>
      </div>

      <!-- Channels Card -->
      <div class="card card-channels">
        <h2><span class="icon">📱</span> Channels</h2>
        <p class="desc">Optional: configure messaging channels.</p>

        <label>Telegram bot token</label>
        <input id="telegramToken" type="password" placeholder="123456:ABC..." />
        ${formConfig.telegramEnabled ? '<div class="hint success">Enabled</div>' : ''}

        <label>Discord bot token</label>
        <input id="discordToken" type="password" placeholder="Bot token" />
        ${formConfig.discordEnabled ? '<div class="hint success">Enabled</div>' : ''}

        <label>Slack bot token</label>
        <input id="slackBotToken" type="password" placeholder="xoxb-..." />
        ${formConfig.slackEnabled ? '<div class="hint success">Enabled</div>' : ''}

        <label>Slack app token</label>
        <input id="slackAppToken" type="password" placeholder="xapp-..." />
      </div>

      <!-- Onboarding Card -->
      <div class="card card-onboarding">
        <h2><span class="icon">🚀</span> Run Onboarding</h2>
        <p class="desc">Execute setup or manage user pairing.</p>

        <div class="btn-group">
          <button id="run" class="btn-primary">Run Setup</button>
          <button id="reset" class="btn-muted">Reset</button>
        </div>

        <div class="section-divider">Pairing</div>

        <div class="btn-group">
          <button id="pairingList" class="btn-dark">List</button>
          <button id="pairingApprove" class="btn-dark">Approve</button>
          <button id="pairingApproveAll" class="btn-success">All</button>
        </div>

        <pre id="log"></pre>
      </div>
        </div>
      </div>

      <!-- Right Panel: Chat -->
      <div class="chat-panel">
        <div class="card card-chat">
          <h2><span class="icon">💬</span> Direct Chat</h2>
          <p class="desc">Chat directly with OpenClaw. Messages are sent via the agent command.</p>
          <div class="chat-container">
            <div class="chat-messages" id="chatMessages">
              <div class="chat-message system">Type a message below to start chatting with OpenClaw.</div>
            </div>
            <div id="chatTyping" class="chat-typing" style="display: none;">
              <div class="chat-typing-dots">
                <span></span><span></span><span></span>
              </div>
              <span>OpenClaw is thinking...</span>
            </div>
            <div class="chat-input-row">
              <input type="text" id="chatInput" placeholder="Type your message..." />
              <button id="chatSend" class="btn-primary">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

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
  const { timeoutMs, ...spawnOpts } = opts;

  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...spawnOpts,
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
    let timedOut = false;
    let timeoutId = null;

    // Set up timeout if specified
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        // Force kill after 5 seconds if SIGTERM doesn't work
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
      }, timeoutMs);
    }

    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) {
        out += `\n[timeout] Command timed out after ${timeoutMs}ms\n`;
        resolve({ code: 124, output: out }); // 124 is standard timeout exit code
      } else {
        resolve({ code: code ?? 0, output: out });
      }
    });
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

    // Use fallback logic in case /data volume isn't writable
    ensureDirectoriesWithFallback();

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

// Embedded response generator for when the gateway agent is unavailable
function generateEmbeddedResponse(message) {
  const lowerMsg = message.toLowerCase();

  // Help and status queries
  if (lowerMsg.includes("help") || lowerMsg.includes("what can you do")) {
    return `I'm OpenClaw's embedded assistant. Here's what I can help with:

**Quick Commands** (type in chat):
- \`/health\` - Run health check
- \`/troubleshoot\` - Diagnose issues
- \`/status\` - Check system status
- \`/restart\` - Restart the gateway
- \`/logs\` - View recent logs

**Setup Help**:
- Use the **Auth Provider** card to configure your AI provider
- Click **Run Setup** to complete configuration
- Use **Health Check** to diagnose and fix issues

Type \`/help\` for all available commands!`;
  }

  if (lowerMsg.includes("status") || lowerMsg.includes("how are you")) {
    return `OpenClaw is running but the main agent isn't responding. Try:
1. Run \`/health\` to check system health
2. Run \`/troubleshoot\` for diagnostics
3. Use the **Fix All** button to repair issues
4. Check if your auth provider is configured correctly`;
  }

  if (lowerMsg.includes("error") || lowerMsg.includes("problem") || lowerMsg.includes("not working")) {
    return `Let me help you troubleshoot! Try these steps:

1. **Run diagnostics**: Type \`/troubleshoot\` or click "Standard" in Troubleshooter
2. **Check health**: Type \`/health\` or click "Check" in Health Check
3. **Auto-fix issues**: Click "Fix All" in Health Check
4. **Restart gateway**: Type \`/restart\` or use Command Console

If issues persist, check:
- Auth provider configuration
- API key/token validity
- Network connectivity`;
  }

  if (lowerMsg.includes("setup") || lowerMsg.includes("configure") || lowerMsg.includes("start")) {
    return `To set up OpenClaw:

1. **Select Provider**: Choose your AI provider (Anthropic, OpenAI, etc.)
2. **Enter API Key**: Paste your API key or token
3. **Run Setup**: Click the "Run Setup" button
4. **Verify**: Check that status shows "Configured"

Optional: Configure Telegram, Discord, or Slack for messaging.`;
  }

  // Default response
  return `I'm OpenClaw's embedded assistant (the main agent isn't responding right now).

**Quick Actions**:
- Type \`/help\` for available commands
- Type \`/troubleshoot\` to diagnose issues
- Type \`/health\` to check system status

**Your message**: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"

I can help with setup, configuration, and troubleshooting. For full AI chat, please ensure the gateway is running and configured correctly.`;
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",
  "gateway.probe",

  // OpenClaw CLI helpers - Core
  "openclaw.version",
  "openclaw.status",
  "openclaw.status.all",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.doctor.fix",
  "openclaw.update.check",
  "openclaw.update.run",

  // OpenClaw CLI helpers - Logs
  "openclaw.logs.tail",
  "openclaw.logs.follow",
  "openclaw.logs.clear",

  // OpenClaw CLI helpers - Security
  "openclaw.security.audit",
  "openclaw.security.audit.deep",

  // OpenClaw CLI helpers - Configuration
  "openclaw.config.get",
  "openclaw.config.list",
  "openclaw.config.validate",

  // OpenClaw CLI helpers - Sessions
  "openclaw.sessions.list",
  "openclaw.sessions.clear",
  "openclaw.sessions.active",

  // OpenClaw CLI helpers - Agents
  "openclaw.agents.list",
  "openclaw.agents.status",
  "openclaw.agents.restart",

  // OpenClaw CLI helpers - Memory
  "openclaw.memory.status",
  "openclaw.memory.stats",
  "openclaw.memory.clear",

  // OpenClaw CLI helpers - Channels
  "openclaw.channels.list",
  "openclaw.channels.status",
  "openclaw.channels.test",

  // OpenClaw CLI helpers - Pairing
  "openclaw.pairing.list",
  "openclaw.pairing.pending",

  // Wrapper utilities for fixing common issues
  "wrapper.fix.dirs",
  "wrapper.fix.permissions",
  "wrapper.env.check",
  "wrapper.storage.check",
  "wrapper.network.check",

  // Comprehensive troubleshooter
  "wrapper.troubleshoot",
  "wrapper.troubleshoot.quick",
  "wrapper.troubleshoot.deep",
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
    if (cmd === "openclaw.logs.follow") {
      // Follow logs for a brief period (5 seconds) to avoid hanging
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--follow"]), { timeoutMs: 5000 });
      return res.json({ ok: true, output: redactSecrets(r.output) + "\n(Log stream ended after 5s timeout)" });
    }
    if (cmd === "openclaw.logs.clear") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--clear"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.validate") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "validate"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Status commands
    if (cmd === "openclaw.status.all") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status", "--all"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Update commands
    if (cmd === "openclaw.update.check") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["update", "--check"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.update.run") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["update"]), { timeoutMs: 120000 });
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Security commands
    if (cmd === "openclaw.security.audit.deep") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["security", "audit", "--deep"]), { timeoutMs: 60000 });
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Sessions commands
    if (cmd === "openclaw.sessions.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["sessions", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.sessions.clear") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["sessions", "clear"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.sessions.active") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["sessions", "active"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Agents commands
    if (cmd === "openclaw.agents.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["agents", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.agents.status") {
      const agentName = arg || "main";
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["agents", "status", agentName]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.agents.restart") {
      const agentName = arg || "main";
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["agents", "restart", agentName]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Memory commands
    if (cmd === "openclaw.memory.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["memory", "status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.memory.stats") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["memory", "stats"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.memory.clear") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["memory", "clear"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Channels commands
    if (cmd === "openclaw.channels.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.channels.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.channels.test") {
      const channelName = arg || "";
      const args = channelName ? ["channels", "test", channelName] : ["channels", "test"];
      const r = await runCmd(OPENCLAW_NODE, clawArgs(args), { timeoutMs: 30000 });
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Pairing commands
    if (cmd === "openclaw.pairing.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.pairing.pending") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "list", "--pending"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Gateway probe
    if (cmd === "gateway.probe") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "probe"]), { timeoutMs: 30000 });
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Wrapper storage check
    if (cmd === "wrapper.storage.check") {
      let output = "╔══════════════════════════════════════════════════════════════╗\n";
      output += "║                    📦 STORAGE DIAGNOSTICS                    ║\n";
      output += "╚══════════════════════════════════════════════════════════════╝\n\n";

      // Check /data volume
      output += "━━━ Volume Mount Check ━━━\n";
      const volumeExists = fs.existsSync("/data");
      output += `  /data exists: ${volumeExists ? "✓ Yes" : "✗ No"}\n`;

      if (volumeExists) {
        try {
          const stats = fs.statSync("/data");
          output += `  /data type: ${stats.isDirectory() ? "✓ Directory" : "✗ Not a directory"}\n`;
          output += `  /data mode: ${(stats.mode & 0o777).toString(8)}\n`;
          output += `  /data uid/gid: ${stats.uid}/${stats.gid}\n`;

          // Test write access
          const testFile = "/data/.write-test-" + Date.now();
          try {
            fs.writeFileSync(testFile, "test");
            fs.unlinkSync(testFile);
            output += "  /data writable: ✓ Yes\n";
          } catch (err) {
            output += `  /data writable: ✗ No (${err.message})\n`;
          }
        } catch (err) {
          output += `  /data stat error: ${err.message}\n`;
        }
      }

      output += "\n━━━ State Directory Check ━━━\n";
      output += `  STATE_DIR: ${STATE_DIR}\n`;
      output += `  Under /data: ${STATE_DIR.startsWith("/data") ? "✓ Yes" : "⚠ No"}\n`;

      try {
        const stateStats = fs.statSync(STATE_DIR);
        output += `  Exists: ✓ Yes\n`;
        output += `  Mode: ${(stateStats.mode & 0o777).toString(8)}\n`;
      } catch {
        output += "  Exists: ✗ No\n";
      }

      output += "\n━━━ Workspace Directory Check ━━━\n";
      output += `  WORKSPACE_DIR: ${WORKSPACE_DIR}\n`;
      output += `  Under /data: ${WORKSPACE_DIR.startsWith("/data") ? "✓ Yes" : "⚠ No"}\n`;

      try {
        const workspaceStats = fs.statSync(WORKSPACE_DIR);
        output += `  Exists: ✓ Yes\n`;
        output += `  Mode: ${(workspaceStats.mode & 0o777).toString(8)}\n`;
      } catch {
        output += "  Exists: ✗ No\n";
      }

      output += "\n━━━ Persistence Status ━━━\n";
      output += `  Persistent: ${DATA_PERSISTENCE.persistent ? "✓ Yes" : "✗ No"}\n`;
      output += `  Storage type: ${DATA_PERSISTENCE.storageType}\n`;
      if (DATA_PERSISTENCE.warning) {
        output += `  ⚠ Warning: ${DATA_PERSISTENCE.warning}\n`;
      }

      output += "\n━━━ Config File Status ━━━\n";
      const cfgPath = configPath();
      output += `  Path: ${cfgPath}\n`;
      try {
        const cfgStats = fs.statSync(cfgPath);
        output += `  Exists: ✓ Yes (${cfgStats.size} bytes)\n`;
        output += `  Mode: ${(cfgStats.mode & 0o777).toString(8)}\n`;
      } catch {
        output += "  Exists: ✗ No\n";
      }

      return res.json({ ok: true, output });
    }

    // Wrapper network check
    if (cmd === "wrapper.network.check") {
      let output = "╔══════════════════════════════════════════════════════════════╗\n";
      output += "║                    🌐 NETWORK DIAGNOSTICS                    ║\n";
      output += "╚══════════════════════════════════════════════════════════════╝\n\n";

      output += "━━━ Gateway Status ━━━\n";
      output += `  Target: ${GATEWAY_TARGET}\n`;
      output += `  Process running: ${gatewayProc ? "✓ Yes" : "✗ No"}\n`;

      // Test gateway connectivity
      output += "\n━━━ Gateway Connectivity ━━━\n";
      try {
        const response = await fetch(`${GATEWAY_TARGET}/openclaw`, { method: "GET" });
        output += `  Reachable: ✓ Yes (status ${response.status})\n`;
      } catch (err) {
        output += `  Reachable: ✗ No (${err.message})\n`;
      }

      output += "\n━━━ Port Configuration ━━━\n";
      output += `  Public port: ${PORT}\n`;
      output += `  Internal gateway port: ${INTERNAL_GATEWAY_PORT}\n`;
      output += `  Gateway host: ${INTERNAL_GATEWAY_HOST}\n`;

      output += "\n━━━ Environment ━━━\n";
      output += `  Process ID: ${process.pid}\n`;
      output += `  Node version: ${process.version}\n`;
      output += `  Platform: ${process.platform} (${process.arch})\n`;

      return res.json({ ok: true, output });
    }

    // Comprehensive troubleshooter
    if (cmd === "wrapper.troubleshoot" || cmd === "wrapper.troubleshoot.quick" || cmd === "wrapper.troubleshoot.deep") {
      const isDeep = cmd === "wrapper.troubleshoot.deep";
      const isQuick = cmd === "wrapper.troubleshoot.quick";

      let output = "╔══════════════════════════════════════════════════════════════╗\n";
      output += isDeep
        ? "║           🔬 DEEP TROUBLESHOOTER - COMPREHENSIVE SCAN        ║\n"
        : isQuick
        ? "║               ⚡ QUICK TROUBLESHOOTER - FAST CHECK           ║\n"
        : "║                 🔧 OPENCLAW TROUBLESHOOTER                   ║\n";
      output += "╚══════════════════════════════════════════════════════════════╝\n\n";

      const issues = [];
      const fixes = [];
      let stepNum = 0;

      // Step 1: Configuration check
      stepNum++;
      output += `━━━ Step ${stepNum}: Configuration Check ━━━\n`;
      const configured = isConfigured();
      if (configured) {
        output += "  ✓ Configuration file exists\n";
        try {
          const cfgContent = fs.readFileSync(configPath(), "utf8");
          const cfg = JSON.parse(cfgContent);
          output += "  ✓ Configuration is valid JSON\n";
          if (cfg.auth) {
            output += `  ✓ Auth configured: ${cfg.auth.provider || "unknown"}\n`;
          } else {
            output += "  ⚠ Auth not configured\n";
            issues.push("Auth provider not configured");
          }
        } catch (err) {
          output += `  ✗ Configuration parse error: ${err.message}\n`;
          issues.push("Configuration file is invalid JSON");
          fixes.push("Reset configuration and run setup again");
        }
      } else {
        output += "  ✗ Configuration file missing\n";
        issues.push("OpenClaw is not configured");
        fixes.push("Run the setup wizard to configure OpenClaw");
      }
      output += "\n";

      // Step 2: Directory structure
      stepNum++;
      output += `━━━ Step ${stepNum}: Directory Structure ━━━\n`;
      const requiredDirs = [
        { path: STATE_DIR, name: "State directory" },
        { path: WORKSPACE_DIR, name: "Workspace directory" },
        { path: path.join(STATE_DIR, "credentials"), name: "Credentials directory" },
        { path: path.join(STATE_DIR, "identity"), name: "Identity directory" },
        { path: path.join(STATE_DIR, "logs"), name: "Logs directory" },
        { path: path.join(STATE_DIR, "sessions"), name: "Sessions directory" },
      ];

      for (const dir of requiredDirs) {
        try {
          if (fs.existsSync(dir.path)) {
            const stats = fs.statSync(dir.path);
            const mode = (stats.mode & 0o777).toString(8);
            if (mode === "700" || mode === "755" || mode === "750") {
              output += `  ✓ ${dir.name}: exists (mode ${mode})\n`;
            } else {
              output += `  ⚠ ${dir.name}: exists but mode is ${mode} (should be 700)\n`;
              issues.push(`${dir.name} has insecure permissions (${mode})`);
              fixes.push(`Run 'Fix permissions' to set ${dir.path} to 700`);
            }
          } else {
            output += `  ✗ ${dir.name}: missing\n`;
            issues.push(`${dir.name} does not exist`);
            fixes.push(`Run 'Fix directories' to create ${dir.path}`);
          }
        } catch (err) {
          output += `  ✗ ${dir.name}: error (${err.message})\n`;
          issues.push(`Cannot access ${dir.name}`);
        }
      }
      output += "\n";

      // Step 3: Storage persistence
      stepNum++;
      output += `━━━ Step ${stepNum}: Storage Persistence ━━━\n`;
      if (DATA_PERSISTENCE.persistent) {
        output += `  ✓ Using persistent storage (${DATA_PERSISTENCE.storageType})\n`;
      } else {
        output += `  ✗ NOT using persistent storage!\n`;
        output += `    Storage type: ${DATA_PERSISTENCE.storageType}\n`;
        issues.push("Data will not persist across restarts");
        fixes.push("Add a Railway volume mounted at /data");
      }
      output += "\n";

      // Step 4: Gateway status
      stepNum++;
      output += `━━━ Step ${stepNum}: Gateway Status ━━━\n`;
      output += `  Process: ${gatewayProc ? "✓ Running" : "✗ Not running"}\n`;
      if (!gatewayProc && configured) {
        issues.push("Gateway is not running");
        fixes.push("Run 'gateway.start' to start the gateway");
      }

      // Test gateway connectivity
      try {
        const response = await fetch(`${GATEWAY_TARGET}/openclaw`, { method: "GET" });
        output += `  Connectivity: ✓ Reachable (status ${response.status})\n`;
      } catch (err) {
        output += `  Connectivity: ✗ Unreachable (${err.message})\n`;
        if (configured) {
          issues.push("Gateway is unreachable");
          fixes.push("Restart the gateway or check port configuration");
        }
      }
      output += "\n";

      // Step 5: OpenClaw CLI check
      if (!isQuick) {
        stepNum++;
        output += `━━━ Step ${stepNum}: OpenClaw CLI ━━━\n`;
        const versionResult = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
        if (versionResult.code === 0) {
          output += `  ✓ CLI accessible: ${versionResult.output.trim()}\n`;
        } else {
          output += `  ✗ CLI error: ${versionResult.output.slice(0, 100)}\n`;
          issues.push("OpenClaw CLI is not accessible");
        }
        output += "\n";
      }

      // Step 6: Doctor check (standard and deep)
      if (!isQuick) {
        stepNum++;
        output += `━━━ Step ${stepNum}: OpenClaw Doctor ━━━\n`;
        const doctorResult = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
        const doctorOutput = redactSecrets(doctorResult.output);

        // Parse doctor output for issues
        const doctorLines = doctorOutput.split("\n");
        let doctorIssueCount = 0;
        for (const line of doctorLines) {
          if (line.includes("CRITICAL") || line.includes("ERROR") || line.includes("✗")) {
            doctorIssueCount++;
            if (doctorIssueCount <= 3) {
              output += `  ⚠ ${line.trim().slice(0, 70)}\n`;
            }
          }
        }

        if (doctorResult.code === 0 && doctorIssueCount === 0) {
          output += "  ✓ No issues detected by doctor\n";
        } else {
          output += `  ⚠ Doctor found ${doctorIssueCount} issue(s)\n`;
          if (doctorIssueCount > 0) {
            issues.push(`OpenClaw doctor reported ${doctorIssueCount} issue(s)`);
            fixes.push("Run 'openclaw.doctor.fix' to attempt automatic fixes");
          }
        }
        output += "\n";
      }

      // Step 7: Security audit (deep only)
      if (isDeep) {
        stepNum++;
        output += `━━━ Step ${stepNum}: Security Audit (Deep) ━━━\n`;
        const auditResult = await runCmd(OPENCLAW_NODE, clawArgs(["security", "audit", "--deep"]), { timeoutMs: 60000 });
        const auditOutput = redactSecrets(auditResult.output);

        // Parse for critical security issues
        const auditLines = auditOutput.split("\n");
        let criticalCount = 0;
        let warnCount = 0;
        for (const line of auditLines) {
          if (line.includes("CRITICAL")) criticalCount++;
          if (line.includes("WARN")) warnCount++;
        }

        output += `  Critical: ${criticalCount}\n`;
        output += `  Warnings: ${warnCount}\n`;

        if (criticalCount > 0) {
          issues.push(`Security audit found ${criticalCount} critical issue(s)`);
          fixes.push("Review security audit output and address critical issues");
        }
        output += "\n";
      }

      // Step 8: Channel status (standard and deep)
      if (!isQuick) {
        stepNum++;
        output += `━━━ Step ${stepNum}: Channel Status ━━━\n`;
        const channelsResult = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "status"]));
        if (channelsResult.code === 0) {
          const lines = channelsResult.output.split("\n").filter(l => l.trim());
          for (const line of lines.slice(0, 5)) {
            output += `  ${line.trim()}\n`;
          }
        } else {
          output += "  ⚠ Could not retrieve channel status\n";
        }
        output += "\n";
      }

      // Step 9: Memory status (deep only)
      if (isDeep) {
        stepNum++;
        output += `━━━ Step ${stepNum}: Memory Plugin Status ━━━\n`;
        const memoryResult = await runCmd(OPENCLAW_NODE, clawArgs(["memory", "status"]));
        if (memoryResult.code === 0) {
          output += `  ${redactSecrets(memoryResult.output).slice(0, 200)}\n`;
        } else {
          output += "  ⚠ Memory plugin status unavailable\n";
        }
        output += "\n";
      }

      // Summary
      output += "╔══════════════════════════════════════════════════════════════╗\n";
      if (issues.length === 0) {
        output += "║                    ✅ ALL CHECKS PASSED                     ║\n";
      } else {
        output += `║              ⚠️  FOUND ${issues.length} ISSUE(S) TO ADDRESS                  ║\n`;
      }
      output += "╚══════════════════════════════════════════════════════════════╝\n\n";

      if (issues.length > 0) {
        output += "━━━ Issues Found ━━━\n";
        for (let i = 0; i < issues.length; i++) {
          output += `  ${i + 1}. ${issues[i]}\n`;
        }
        output += "\n━━━ Suggested Fixes ━━━\n";
        for (let i = 0; i < fixes.length; i++) {
          output += `  ${i + 1}. ${fixes[i]}\n`;
        }
      }

      output += "\n━━━ Quick Actions ━━━\n";
      output += "  • Run 'Fix All Issues' button for automatic repair\n";
      output += "  • Use /doctor command in chat for diagnostics\n";
      output += "  • Check logs with 'openclaw.logs.tail' command\n";

      return res.json({
        ok: issues.length === 0,
        issues,
        fixes,
        output
      });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Direct Chat endpoint - wraps openclaw agent command
app.post("/setup/api/chat", requireSetupAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const { message } = req.body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ ok: false, error: "Message is required" });
  }

  // Sanitize message - remove control characters but allow unicode
  const sanitizedMessage = message.trim().replace(/[\x00-\x1F\x7F]/g, "");

  if (sanitizedMessage.length > 10000) {
    return res.status(400).json({ ok: false, error: "Message too long (max 10000 characters)" });
  }

  auditLog("CHAT_MESSAGE", { ip, messageLength: sanitizedMessage.length });

  try {
    // Check if configured
    if (!isConfigured()) {
      return res.status(400).json({
        ok: false,
        error: "OpenClaw is not configured. Please complete the setup first.",
      });
    }

    // Run the agent command with the message
    // Use --agent main to specify the default agent, avoiding session selection errors
    const result = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["agent", "--agent", "main", "--message", sanitizedMessage]),
      { timeoutMs: 120000 } // 2 minute timeout for AI responses
    );

    if (result.code !== 0) {
      // Check for specific errors
      const output = result.output || "";

      // Handle session/agent selection errors - fall back to embedded response
      if (output.includes("--to") || output.includes("--session-id") || output.includes("--agent to choose")) {
        logger.warn("Gateway agent failed, using embedded fallback", { output: output.slice(0, 200) });
        return res.json({
          ok: true,
          response: generateEmbeddedResponse(sanitizedMessage),
          timestamp: new Date().toISOString(),
          fallback: true,
        });
      }

      // Handle unknown option errors gracefully
      if (output.includes("unknown option")) {
        logger.warn("CLI compatibility issue", { output: output.slice(0, 200) });
        // Try fallback for unknown option errors too
        return res.json({
          ok: true,
          response: generateEmbeddedResponse(sanitizedMessage),
          timestamp: new Date().toISOString(),
          fallback: true,
        });
      }

      logger.error("Chat command failed", {
        code: result.code,
        output: output.slice(0, 500),
      });

      // Final fallback for any error
      return res.json({
        ok: true,
        response: generateEmbeddedResponse(sanitizedMessage),
        timestamp: new Date().toISOString(),
        fallback: true,
      });
    }

    // Parse the response - agent output may have metadata, try to extract just the response
    let response = result.output.trim();

    // If output contains markdown or structured format, keep it
    // Otherwise just return as-is

    logger.info("Chat response generated", {
      ip,
      inputLength: sanitizedMessage.length,
      outputLength: response.length,
    });

    return res.json({
      ok: true,
      response,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("Chat error", { error: err.message, ip });
    return res.status(500).json({
      ok: false,
      error: "An error occurred while processing your message",
      details: err.message,
    });
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
  output += "━━━ Step 1/5: Creating missing directories ━━━\n";
  const dirsToCreate = [
    path.join(STATE_DIR, "credentials"),
    path.join(STATE_DIR, "identity"),
    path.join(STATE_DIR, "logs"),
    path.join(STATE_DIR, "sessions"),
    path.join(STATE_DIR, "agents", "main", "sessions"),
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
  output += "━━━ Step 2/5: Fixing directory permissions ━━━\n";
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

  // Step 3: Set gateway mode if not configured
  output += "━━━ Step 3/5: Configuring gateway mode ━━━\n";
  let gatewayModeOk = true;
  try {
    // Check if gateway.mode is set
    const modeCheck = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "gateway.mode"]));
    const currentMode = (modeCheck.output || "").trim();
    if (!currentMode || currentMode === "undefined" || currentMode === "null" || modeCheck.code !== 0) {
      output += "  Setting gateway.mode to 'local'...\n";
      const setResult = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.mode", "local"]));
      if (setResult.code === 0) {
        output += "  ✓ gateway.mode set to 'local'\n";
      } else {
        output += `  ✗ Failed to set gateway.mode: ${redactSecrets(setResult.output)}\n`;
        gatewayModeOk = false;
      }
    } else {
      output += `  ✓ gateway.mode already set to '${currentMode}'\n`;
    }
  } catch (err) {
    output += `  ✗ Error configuring gateway mode: ${err.message}\n`;
    gatewayModeOk = false;
  }
  steps.push({ name: "Configure gateway mode", ok: gatewayModeOk });
  output += "\n";

  // Step 4: Run openclaw doctor --fix
  output += "━━━ Step 4/5: Running openclaw doctor --fix ━━━\n";
  const doctorResult = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
  const doctorOk = doctorResult.code === 0;
  output += redactSecrets(doctorResult.output) + "\n";
  steps.push({ name: "OpenClaw doctor --fix", ok: doctorOk });

  // Step 5: Restart gateway
  output += "━━━ Step 5/5: Restarting gateway ━━━\n";
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

    // Ensure directories exist with fallback for permission errors
    ensureDirectoriesWithFallback();

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

  // Ensure directories exist with fallback for permission errors
  ensureDirectoriesWithFallback();

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

proxy.on("error", (err, req, _res) => {
  logger.error("Proxy error", {
    error: err.message,
    code: err.code,
    path: req?.url,
    method: req?.method,
    traceId: req?.trace?.traceId,
  });
  trackError(err, { context: "proxy", path: req?.url });
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
  // Use structured logging for startup
  logStartupBanner({
    port: PORT,
    stateDir: STATE_DIR,
    workspaceDir: WORKSPACE_DIR,
  });

  logger.info("Server configuration", {
    port: PORT,
    stateDir: STATE_DIR,
    workspaceDir: WORKSPACE_DIR,
    gatewayToken: OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)",
    gatewayTarget: GATEWAY_TARGET,
    configured: isConfigured(),
    setupPasswordSet: Boolean(SETUP_PASSWORD),
    storage: DATA_PERSISTENCE,
  });

  // Log storage persistence status prominently
  if (!DATA_PERSISTENCE.persistent) {
    logger.warn("DATA PERSISTENCE WARNING", {
      message: "Data may not persist across container restarts!",
      storageType: DATA_PERSISTENCE.storageType,
      stateDir: DATA_PERSISTENCE.stateDir,
      recommendation: DATA_PERSISTENCE.warning,
    });
  } else {
    logger.info("Storage configured for persistence", {
      storageType: DATA_PERSISTENCE.storageType,
      stateDir: DATA_PERSISTENCE.stateDir,
    });
  }

  if (!SETUP_PASSWORD) {
    logger.warn("SETUP_PASSWORD is not set; /setup will error");
  }

  // Log observability endpoints
  logger.info("Observability endpoints available", {
    endpoints: [
      "/health",
      "/health/detailed",
      "/health/storage",
      "/metrics",
      "/metrics/prometheus",
      "/diagnostics",
    ],
  });
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
  logger.info("Received SIGTERM, shutting down gracefully");
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  logger.info("Shutdown complete");
  process.exit(0);
});
