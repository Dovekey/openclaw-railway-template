#!/bin/sh
# Docker entrypoint script for OpenClaw
# Handles data directory permissions gracefully for Railway volume mounts

set -e

# Default data directory (may be overridden by environment)
DATA_BASE="${DATA_DIR:-/data}"
DESIRED_STATE_DIR="${OPENCLAW_STATE_DIR:-$DATA_BASE/.openclaw}"
DESIRED_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$DESIRED_STATE_DIR/workspace}"

# Fallback locations if primary isn't writable
FALLBACK_STATE_DIR="${HOME:-.}/.openclaw"
FALLBACK_WORKSPACE_DIR="$FALLBACK_STATE_DIR/workspace"

# Function to check if a directory is writable (or can be created)
check_writable() {
    dir="$1"
    if [ -d "$dir" ]; then
        # Directory exists, check if writable
        [ -w "$dir" ]
    else
        # Directory doesn't exist, check if parent is writable
        parent=$(dirname "$dir")
        [ -d "$parent" ] && [ -w "$parent" ]
    fi
}

# Function to setup directories
setup_directories() {
    state_dir="$1"
    workspace_dir="$2"

    mkdir -p "$state_dir" 2>/dev/null || return 1
    mkdir -p "$workspace_dir" 2>/dev/null || return 1

    # Verify we can write to them
    touch "$state_dir/.write-test" 2>/dev/null && rm -f "$state_dir/.write-test" || return 1

    return 0
}

# Try primary location first
if setup_directories "$DESIRED_STATE_DIR" "$DESIRED_WORKSPACE_DIR"; then
    echo "Using data directory: $DESIRED_STATE_DIR"
    export OPENCLAW_STATE_DIR="$DESIRED_STATE_DIR"
    export OPENCLAW_WORKSPACE_DIR="$DESIRED_WORKSPACE_DIR"
else
    echo "Warning: Cannot write to $DESIRED_STATE_DIR, using fallback: $FALLBACK_STATE_DIR"

    if setup_directories "$FALLBACK_STATE_DIR" "$FALLBACK_WORKSPACE_DIR"; then
        export OPENCLAW_STATE_DIR="$FALLBACK_STATE_DIR"
        export OPENCLAW_WORKSPACE_DIR="$FALLBACK_WORKSPACE_DIR"
        echo "Fallback data directory ready: $FALLBACK_STATE_DIR"
    else
        echo "Error: Cannot create data directory at $FALLBACK_STATE_DIR"
        echo "Please ensure the container has write permissions to either:"
        echo "  - $DATA_BASE (primary)"
        echo "  - $HOME (fallback)"
        exit 1
    fi
fi

# Execute the main command
exec "$@"
