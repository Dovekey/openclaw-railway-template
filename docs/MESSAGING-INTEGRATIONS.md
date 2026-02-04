# OpenClaw Messaging App Integrations

**OpenClaw** is an open-source AI personal assistant that can connect to a wide variety of messaging platforms.

## Supported Messaging Apps

| Platform | Connection Method |
|----------|-------------------|
| **WhatsApp** | Uses Baileys for WhatsApp Web protocol |
| **Telegram** | Bot support for DMs + groups via grammY |
| **Discord** | Bot for DMs + guild channels via discord.js |
| **Slack** | Native integration |
| **Signal** | Direct integration |
| **iMessage** | Local imsg CLI integration (macOS only) |
| **Google Chat** | Native integration |
| **Microsoft Teams** | Native integration |
| **Mattermost** | Plugin with bot token + WebSocket events |
| **Matrix** | Native integration |
| **Zalo** | Native integration |
| **Zalo Personal** | Native integration |
| **BlueBubbles** | Native integration |
| **WebChat** | Built-in web interface |

## How It Works

OpenClaw runs as a **Gateway** - an always-on control plane that bridges your AI assistant to these messaging surfaces. You can send messages through any connected channel using commands like:

```bash
openclaw agent --message "Your message" --thinking high
```

This delivers your message back to whichever platform you've configured (WhatsApp, Telegram, Slack, etc.).

## Setup

### Telegram

1. Create a bot via @BotFather
2. Get your bot token
3. Configure in OpenClaw setup wizard

### Discord

1. Create a Discord application at https://discord.com/developers
2. Create a bot and get the token
3. Configure in OpenClaw setup wizard

### WhatsApp

1. Uses WhatsApp Web protocol via Baileys
2. Scan QR code during setup
3. No business account required

### Slack

1. Create a Slack app at https://api.slack.com/apps
2. Install to your workspace
3. Configure OAuth tokens in setup wizard

### Signal

1. Register a Signal phone number
2. Configure via OpenClaw CLI
3. Uses Signal's native protocol

## Observability for Messaging

All messaging events are logged with structured JSON:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "event": "MESSAGE_RECEIVED",
  "channel": "telegram",
  "chatId": "123456",
  "traceId": "abc123"
}
```

Monitor messaging health via:
- `/health/detailed` - Shows channel connection status
- `/metrics` - Message counts by channel
- `/diagnostics` - Recent messaging errors

## Additional Features

- **Voice Support** - Speech-to-text and text-to-speech on supported platforms
- **Live Canvas** - Interactive UI elements on supported platforms
- **Multi-channel** - Connect multiple platforms simultaneously
- **DM Policy** - Control who can message your assistant
