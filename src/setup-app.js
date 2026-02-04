// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  var statusEl = document.getElementById('status');
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');
  var logEl = document.getElementById('log');

  // Debug console
  var consoleCmdEl = document.getElementById('consoleCmd');
  var consoleArgEl = document.getElementById('consoleArg');
  var consoleRunEl = document.getElementById('consoleRun');
  var consoleOutEl = document.getElementById('consoleOut');

  // Config editor
  var configPathEl = document.getElementById('configPath');
  var configTextEl = document.getElementById('configText');
  var configReloadEl = document.getElementById('configReload');
  var configSaveEl = document.getElementById('configSave');
  var configOutEl = document.getElementById('configOut');

  // Import
  var importFileEl = document.getElementById('importFile');
  var importRunEl = document.getElementById('importRun');
  var importOutEl = document.getElementById('importOut');

  // Direct Chat elements
  var chatMessagesEl = document.getElementById('chatMessages');
  var chatInputEl = document.getElementById('chatInput');
  var chatSendEl = document.getElementById('chatSend');
  var chatTypingEl = document.getElementById('chatTyping');

  // =========================================================================
  // Chat System - Central output hub
  // =========================================================================

  // Simple markdown-like formatting for chat messages
  function formatChatMessage(text) {
    // Escape HTML first
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Code blocks (```)
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
      return '<pre>' + code.trim() + '</pre>';
    });

    // Inline code (`)
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold (**text**)
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic (*text*)
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Links [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Line breaks
    text = text.replace(/\n/g, '<br>');

    return text;
  }

  function addChatMessage(content, type, skipFormat) {
    if (!chatMessagesEl) return;

    var msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message ' + type;

    if (type === 'assistant' && !skipFormat) {
      msgDiv.innerHTML = formatChatMessage(content);
    } else if (type === 'system-output') {
      // System output (command results, health checks, etc)
      msgDiv.className = 'chat-message system';
      var pre = document.createElement('pre');
      pre.style.margin = '0';
      pre.style.fontSize = '0.8rem';
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.wordBreak = 'break-word';
      pre.textContent = content;
      msgDiv.appendChild(pre);
    } else {
      msgDiv.textContent = content;
    }

    chatMessagesEl.appendChild(msgDiv);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function showTyping(show, text) {
    if (chatTypingEl) {
      chatTypingEl.style.display = show ? 'flex' : 'none';
      var textSpan = chatTypingEl.querySelector('span:last-child');
      if (textSpan && text) {
        textSpan.textContent = text;
      } else if (textSpan) {
        textSpan.textContent = 'OpenClaw is thinking...';
      }
    }
    if (chatMessagesEl && show) {
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }
  }

  // Send to chat and optionally to other outputs
  function outputToChat(content, type, alsoToLog) {
    addChatMessage(content, type || 'system');
    if (alsoToLog && logEl) {
      logEl.textContent += content + '\n';
    }
  }

  function setStatus(s) {
    statusEl.textContent = s;
  }

  // Filter authChoice options based on selected authGroup
  function filterAuthChoices() {
    var selectedGroup = authGroupEl.value;
    var optgroups = authChoiceEl.querySelectorAll('optgroup');
    var firstVisibleOption = null;
    var currentValueStillVisible = false;
    var currentValue = authChoiceEl.value;

    for (var i = 0; i < optgroups.length; i++) {
      var og = optgroups[i];
      var groupValue = og.getAttribute('data-group');
      if (groupValue === selectedGroup) {
        og.style.display = '';
        og.disabled = false;
        var opts = og.querySelectorAll('option');
        for (var j = 0; j < opts.length; j++) {
          if (!firstVisibleOption) firstVisibleOption = opts[j];
          if (opts[j].value === currentValue) currentValueStillVisible = true;
        }
      } else {
        og.style.display = 'none';
        og.disabled = true;
      }
    }

    if (!currentValueStillVisible && firstVisibleOption) {
      authChoiceEl.value = firstVisibleOption.value;
    }
  }

  if (authGroupEl && authChoiceEl) {
    authGroupEl.onchange = filterAuthChoices;
    filterAuthChoices();
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function refreshStatus() {
    setStatus('Loading...');
    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? (' | ' + j.openclawVersion) : '';
      var authInfo = '';
      if (j.savedAuth && j.savedAuth.choice) {
        authInfo = ' | Auth: ' + j.savedAuth.provider + ' (' + j.savedAuth.keyType + ')';
      }
      setStatus((j.configured ? 'Configured - open /openclaw' : 'Not configured - run setup below') + ver + authInfo);

      if (authGroupEl && authChoiceEl) {
        filterAuthChoices();
      }

      if (j.channelsAddHelp && j.channelsAddHelp.indexOf('telegram') === -1) {
        outputToChat('Note: this openclaw build does not list telegram in `channels add --help`. Telegram auto-add will be skipped.', 'system');
      }

      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }

    }).catch(function (e) {
      setStatus('Error: ' + String(e));
    });
  }

  // =========================================================================
  // Setup / Run button
  // =========================================================================
  document.getElementById('run').onclick = function () {
    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value
    };

    logEl.textContent = 'Running setup...\n';
    outputToChat('Starting setup wizard...', 'system');
    showTyping(true, 'Running setup wizard...');

    fetch('/setup/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      showTyping(false);
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      var output = j.output || JSON.stringify(j, null, 2);
      logEl.textContent += output;
      outputToChat(output, 'system-output');
      if (j.ok !== false) {
        outputToChat('Setup completed! You can now chat with OpenClaw.', 'system');
      }
      return refreshStatus();
    }).catch(function (e) {
      showTyping(false);
      logEl.textContent += '\nError: ' + String(e) + '\n';
      outputToChat('Setup error: ' + String(e), 'error');
    });
  };

  // =========================================================================
  // Debug Console
  // =========================================================================
  var commandHints = {
    // Troubleshooting
    'wrapper.troubleshoot': 'Comprehensive system check with issue detection',
    'wrapper.troubleshoot.quick': 'Fast check of essential components only',
    'wrapper.troubleshoot.deep': 'Deep scan including security audit and memory status',
    // Gateway
    'gateway.restart': 'Restarts the internal gateway process',
    'gateway.stop': 'Stops the internal gateway process',
    'gateway.start': 'Starts the internal gateway process',
    'gateway.probe': 'Tests gateway connectivity and reachability',
    // Core Diagnostics
    'openclaw.doctor': 'Runs diagnostics and shows any issues',
    'openclaw.doctor.fix': 'Runs diagnostics and attempts to fix issues automatically',
    'openclaw.status': 'Shows current status summary',
    'openclaw.status.all': 'Shows full status with all details',
    'openclaw.health': 'Health check endpoint status',
    'openclaw.version': 'Shows version information',
    // Updates
    'openclaw.update.check': 'Check for available updates',
    'openclaw.update.run': 'Run the update process (may take a while)',
    // Logs
    'openclaw.logs.tail': 'Arg: number of lines (50-1000, default: 200)',
    'openclaw.logs.follow': 'Stream logs for 5 seconds',
    'openclaw.logs.clear': 'Clear all log files',
    // Security
    'openclaw.security.audit': 'Run security audit',
    'openclaw.security.audit.deep': 'Run thorough security scan (takes longer)',
    // Configuration
    'openclaw.config.get': 'Arg: config path (e.g. gateway.port, security.dmPolicy)',
    'openclaw.config.list': 'List all configuration settings',
    'openclaw.config.validate': 'Validate configuration file syntax and values',
    // Sessions
    'openclaw.sessions.list': 'List all sessions',
    'openclaw.sessions.active': 'Show currently active sessions',
    'openclaw.sessions.clear': 'Clear all session data',
    // Agents
    'openclaw.agents.list': 'List all configured agents',
    'openclaw.agents.status': 'Arg: agent name (default: main)',
    'openclaw.agents.restart': 'Arg: agent name to restart (default: main)',
    // Memory
    'openclaw.memory.status': 'Show memory plugin status',
    'openclaw.memory.stats': 'Show memory usage statistics',
    'openclaw.memory.clear': 'Clear memory/conversation history',
    // Channels
    'openclaw.channels.list': 'List all configured channels',
    'openclaw.channels.status': 'Show status of all channels',
    'openclaw.channels.test': 'Arg: channel name to test (optional)',
    // Pairing
    'openclaw.pairing.list': 'List all pairing entries',
    'openclaw.pairing.pending': 'List pending pairing requests',
    // Wrapper Utilities
    'wrapper.fix.dirs': 'Creates missing directories (credentials, identity, logs, sessions)',
    'wrapper.fix.permissions': 'Sets directory permissions to 700 (owner only)',
    'wrapper.env.check': 'Shows environment variables and directory status',
    'wrapper.storage.check': 'Detailed storage and persistence diagnostics',
    'wrapper.network.check': 'Network and gateway connectivity diagnostics'
  };

  var consoleArgHintEl = document.getElementById('consoleArgHint');

  function updateCommandHint() {
    if (!consoleCmdEl || !consoleArgHintEl) return;
    var cmd = consoleCmdEl.value;
    var hint = commandHints[cmd] || '';
    consoleArgHintEl.textContent = hint;

    if (consoleArgEl) {
      if (cmd === 'openclaw.logs.tail') {
        consoleArgEl.placeholder = 'Lines (50-1000)';
      } else if (cmd === 'openclaw.config.get') {
        consoleArgEl.placeholder = 'Config path (e.g. gateway.port)';
      } else if (cmd === 'openclaw.agents.status' || cmd === 'openclaw.agents.restart') {
        consoleArgEl.placeholder = 'Agent name (default: main)';
      } else if (cmd === 'openclaw.channels.test') {
        consoleArgEl.placeholder = 'Channel name (optional)';
      } else {
        consoleArgEl.placeholder = '';
      }
    }
  }

  if (consoleCmdEl) {
    consoleCmdEl.onchange = updateCommandHint;
    updateCommandHint();
  }

  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) consoleOutEl.textContent = 'Running ' + cmd + '...\n';
    outputToChat('Running command: ' + cmd + (arg ? ' ' + arg : ''), 'user');
    showTyping(true, 'Executing command...');

    return httpJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg })
    }).then(function (j) {
      showTyping(false);
      var output = j.output || JSON.stringify(j, null, 2);
      if (consoleOutEl) consoleOutEl.textContent = output;
      outputToChat(output, 'system-output');
      return refreshStatus();
    }).catch(function (e) {
      showTyping(false);
      if (consoleOutEl) consoleOutEl.textContent += '\nError: ' + String(e) + '\n';
      outputToChat('Command error: ' + String(e), 'error');
    });
  }

  if (consoleRunEl) {
    consoleRunEl.onclick = runConsole;
  }

  // =========================================================================
  // Health Check
  // =========================================================================
  var healthCheckBtn = document.getElementById('healthCheck');
  var fixAllBtn = document.getElementById('fixAllIssues');
  var healthOutEl = document.getElementById('healthOut');
  var healthStatusEl = document.getElementById('healthStatus');
  var healthStatusTextEl = document.getElementById('healthStatusText');
  var healthProgressEl = document.getElementById('healthProgress');

  function showHealthStatus(text, progress, color) {
    if (healthStatusEl) {
      healthStatusEl.style.display = 'block';
      healthStatusEl.style.borderLeftColor = color || '#3b82f6';
    }
    if (healthStatusTextEl) healthStatusTextEl.textContent = text;
    if (healthProgressEl) healthProgressEl.textContent = progress || '';
  }

  function hideHealthStatus() {
    if (healthStatusEl) healthStatusEl.style.display = 'none';
  }

  function runHealthCheck() {
    if (healthOutEl) {
      healthOutEl.textContent = '';
      healthOutEl.style.display = 'block';
    }
    showHealthStatus('Running health check...', 'Please wait...', '#3b82f6');
    outputToChat('Running health check...', 'user');
    showTyping(true, 'Checking system health...');

    return httpJson('/setup/api/health').then(function (j) {
      showTyping(false);
      if (healthOutEl) healthOutEl.textContent = j.output || JSON.stringify(j, null, 2);

      if (j.healthy) {
        showHealthStatus('System is healthy!', 'No issues detected', '#10b981');
        outputToChat('Health check passed - system is healthy!', 'system');
      } else {
        var issueCount = j.issues ? j.issues.length : 0;
        showHealthStatus(
          'Issues detected (' + issueCount + ')',
          'Click "Fix All Issues" to repair automatically',
          '#f59e0b'
        );
        outputToChat('Health check found ' + issueCount + ' issue(s). Use "Fix All Issues" to repair.', 'system');
        if (j.issues && j.issues.length > 0) {
          outputToChat('Issues:\n' + j.issues.join('\n'), 'system-output');
        }
      }
      return refreshStatus();
    }).catch(function (e) {
      showTyping(false);
      if (healthOutEl) healthOutEl.textContent = 'Error: ' + String(e);
      showHealthStatus('Health check failed', String(e), '#ef4444');
      outputToChat('Health check error: ' + String(e), 'error');
    });
  }

  function runFixAll() {
    if (!confirm('This will attempt to fix all detected issues:\n\n• Create missing directories\n• Fix directory permissions\n• Configure gateway mode\n• Run openclaw doctor --fix\n• Restart the gateway\n\nContinue?')) {
      return;
    }

    if (healthOutEl) {
      healthOutEl.textContent = '';
      healthOutEl.style.display = 'block';
    }
    showHealthStatus('Fixing issues...', 'Step 1/5: Creating directories...', '#8b5cf6');
    outputToChat('Starting automatic issue repair...', 'user');
    showTyping(true, 'Fixing issues...');

    return httpJson('/setup/api/health/fix-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }).then(function (j) {
      showTyping(false);
      var output = j.output || JSON.stringify(j, null, 2);
      if (healthOutEl) healthOutEl.textContent = output;
      outputToChat(output, 'system-output');

      if (j.healthy) {
        showHealthStatus('All issues fixed!', 'System is now healthy', '#10b981');
        outputToChat('All issues have been fixed! System is now healthy.', 'system');
      } else if (j.ok) {
        showHealthStatus(
          'Repairs completed with warnings',
          'Some issues may require manual attention',
          '#f59e0b'
        );
        outputToChat('Repairs completed but some issues may need manual attention.', 'system');
      } else {
        showHealthStatus(
          'Some repairs failed',
          'Check the output below for details',
          '#ef4444'
        );
        outputToChat('Some repairs failed. Check the output for details.', 'error');
      }
      return refreshStatus();
    }).catch(function (e) {
      showTyping(false);
      if (healthOutEl) healthOutEl.textContent = 'Error: ' + String(e);
      showHealthStatus('Fix failed', String(e), '#ef4444');
      outputToChat('Fix error: ' + String(e), 'error');
    });
  }

  if (healthCheckBtn) healthCheckBtn.onclick = runHealthCheck;
  if (fixAllBtn) fixAllBtn.onclick = runFixAll;

  // =========================================================================
  // Troubleshooter
  // =========================================================================
  var troubleshootQuickBtn = document.getElementById('troubleshootQuick');
  var troubleshootStandardBtn = document.getElementById('troubleshootStandard');
  var troubleshootDeepBtn = document.getElementById('troubleshootDeep');
  var troubleshootOutEl = document.getElementById('troubleshootOut');
  var troubleshootStatusEl = document.getElementById('troubleshootStatus');
  var troubleshootStatusTextEl = document.getElementById('troubleshootStatusText');
  var troubleshootProgressEl = document.getElementById('troubleshootProgress');

  function showTroubleshootStatus(text, progress, color) {
    if (troubleshootStatusEl) {
      troubleshootStatusEl.style.display = 'block';
      troubleshootStatusEl.style.borderLeftColor = color || '#8b5cf6';
    }
    if (troubleshootStatusTextEl) troubleshootStatusTextEl.textContent = text;
    if (troubleshootProgressEl) troubleshootProgressEl.textContent = progress || '';
  }

  function hideTroubleshootStatus() {
    if (troubleshootStatusEl) troubleshootStatusEl.style.display = 'none';
  }

  function runTroubleshoot(level) {
    var cmdMap = {
      'quick': 'wrapper.troubleshoot.quick',
      'standard': 'wrapper.troubleshoot',
      'deep': 'wrapper.troubleshoot.deep'
    };
    var cmd = cmdMap[level] || 'wrapper.troubleshoot';
    var levelLabels = {
      'quick': 'Quick Check',
      'standard': 'Standard Troubleshoot',
      'deep': 'Deep Scan'
    };

    if (troubleshootOutEl) {
      troubleshootOutEl.textContent = '';
      troubleshootOutEl.style.display = 'block';
    }
    showTroubleshootStatus('Running ' + levelLabels[level] + '...', 'Checking system components...', '#8b5cf6');
    outputToChat('Running ' + levelLabels[level] + '...', 'user');
    showTyping(true, 'Running diagnostics...');

    return httpJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: '' })
    }).then(function (j) {
      showTyping(false);
      var output = j.output || JSON.stringify(j, null, 2);
      if (troubleshootOutEl) troubleshootOutEl.textContent = output;
      outputToChat(output, 'system-output');

      if (j.ok) {
        showTroubleshootStatus('All checks passed!', 'System is healthy', '#10b981');
        outputToChat('Troubleshoot completed - no issues found!', 'system');
      } else {
        var issueCount = j.issues ? j.issues.length : 0;
        showTroubleshootStatus(
          'Found ' + issueCount + ' issue(s)',
          'Click "Fix All Issues" in Health Check to repair',
          '#f59e0b'
        );
        outputToChat('Troubleshoot found ' + issueCount + ' issue(s). Check the output for details.', 'system');
      }
      return refreshStatus();
    }).catch(function (e) {
      showTyping(false);
      if (troubleshootOutEl) troubleshootOutEl.textContent = 'Error: ' + String(e);
      showTroubleshootStatus('Troubleshoot failed', String(e), '#ef4444');
      outputToChat('Troubleshoot error: ' + String(e), 'error');
    });
  }

  if (troubleshootQuickBtn) {
    troubleshootQuickBtn.onclick = function() { runTroubleshoot('quick'); };
  }
  if (troubleshootStandardBtn) {
    troubleshootStandardBtn.onclick = function() { runTroubleshoot('standard'); };
  }
  if (troubleshootDeepBtn) {
    troubleshootDeepBtn.onclick = function() { runTroubleshoot('deep'); };
  }

  // =========================================================================
  // Config Editor
  // =========================================================================
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) {
      configOutEl.textContent = '';
      configOutEl.style.display = 'none';
    }
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = (j.path || '(unknown)') + (j.exists ? '' : ' (does not exist yet)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) {
        configOutEl.style.display = 'block';
        configOutEl.textContent = 'Error loading config: ' + String(e);
      }
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway? A timestamped .bak backup will be created.')) return;
    if (configOutEl) {
      configOutEl.style.display = 'block';
      configOutEl.textContent = 'Saving...\n';
    }
    outputToChat('Saving configuration...', 'user');
    showTyping(true, 'Saving configuration...');

    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      showTyping(false);
      if (configOutEl) configOutEl.textContent = 'Saved: ' + (j.path || '') + '\nGateway restarted.\n';
      outputToChat('Configuration saved and gateway restarted.', 'system');
      return refreshStatus();
    }).catch(function (e) {
      showTyping(false);
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
      outputToChat('Config save error: ' + String(e), 'error');
    });
  }

  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // =========================================================================
  // Import Backup
  // =========================================================================
  function runImport() {
    if (!importRunEl || !importFileEl) return;
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) {
      alert('Pick a .tar.gz file first');
      return;
    }
    if (!confirm('Import backup? This overwrites files under /data and restarts the gateway.')) return;

    if (importOutEl) {
      importOutEl.style.display = 'block';
      importOutEl.textContent = 'Uploading ' + f.name + ' (' + f.size + ' bytes)...\n';
    }
    outputToChat('Importing backup: ' + f.name, 'user');
    showTyping(true, 'Importing backup...');

    return f.arrayBuffer().then(function (buf) {
      return fetch('/setup/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/gzip' },
        body: buf
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        showTyping(false);
        if (importOutEl) importOutEl.textContent += t + '\n';
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + t);
        outputToChat('Backup imported successfully.', 'system');
        return refreshStatus();
      });
    }).catch(function (e) {
      showTyping(false);
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
      outputToChat('Import error: ' + String(e), 'error');
    });
  }

  if (importRunEl) importRunEl.onclick = runImport;

  // =========================================================================
  // Pairing
  // =========================================================================
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Enter channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord' && channel !== 'slack') {
        alert('Channel must be "telegram", "discord", or "slack"');
        return;
      }
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      logEl.textContent += '\nApproving pairing for ' + channel + '...\n';
      outputToChat('Approving pairing: ' + channel + ' / ' + code, 'user');
      showTyping(true, 'Approving pairing...');

      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) {
          showTyping(false);
          logEl.textContent += t + '\n';
          outputToChat('Pairing result: ' + t, 'system');
        })
        .catch(function (e) {
          showTyping(false);
          logEl.textContent += 'Error: ' + String(e) + '\n';
          outputToChat('Pairing error: ' + String(e), 'error');
        });
    };
  }

  var pairingListBtn = document.getElementById('pairingList');
  if (pairingListBtn) {
    pairingListBtn.onclick = function () {
      logEl.textContent += '\nFetching pending pairing requests...\n';
      outputToChat('Fetching pending pairing requests...', 'user');
      showTyping(true, 'Fetching pairing requests...');

      httpJson('/setup/api/pairing/pending')
        .then(function (j) {
          showTyping(false);
          if (j.pending && j.pending.length > 0) {
            var msg = 'Pending pairing requests:\n';
            for (var i = 0; i < j.pending.length; i++) {
              var p = j.pending[i];
              msg += '  - ' + (p.channel || p.type) + ': ' + (p.code || p.pairingCode) + '\n';
            }
            logEl.textContent += msg;
            outputToChat(msg, 'system-output');
          } else {
            logEl.textContent += 'No pending pairing requests.\n';
            outputToChat('No pending pairing requests.', 'system');
            if (j.output) {
              logEl.textContent += j.output + '\n';
            }
          }
        })
        .catch(function (e) {
          showTyping(false);
          logEl.textContent += 'Error: ' + String(e) + '\n';
          outputToChat('Error fetching pairing: ' + String(e), 'error');
        });
    };
  }

  var pairingApproveAllBtn = document.getElementById('pairingApproveAll');
  if (pairingApproveAllBtn) {
    pairingApproveAllBtn.onclick = function () {
      if (!confirm('Approve ALL pending pairing requests? This grants DM access to all pending users.')) return;
      logEl.textContent += '\nApproving all pending pairing requests...\n';
      outputToChat('Approving all pending pairing requests...', 'user');
      showTyping(true, 'Approving all...');

      httpJson('/setup/api/pairing/approve-all', { method: 'POST' })
        .then(function (j) {
          showTyping(false);
          if (j.approved > 0) {
            var msg = 'Approved ' + j.approved + ' pairing request(s):\n';
            for (var i = 0; i < j.results.length; i++) {
              var r = j.results[i];
              msg += '  - ' + r.channel + ' (' + r.code + '): ' + (r.ok ? 'OK' : 'FAILED') + '\n';
            }
            logEl.textContent += msg;
            outputToChat(msg, 'system-output');
          } else {
            logEl.textContent += 'No pending pairing requests to approve.\n';
            outputToChat('No pending pairing requests to approve.', 'system');
          }
        })
        .catch(function (e) {
          showTyping(false);
          logEl.textContent += 'Error: ' + String(e) + '\n';
          outputToChat('Error: ' + String(e), 'error');
        });
    };
  }

  // =========================================================================
  // Reset
  // =========================================================================
  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config file so onboarding can run again.')) return;
    logEl.textContent = 'Resetting...\n';
    outputToChat('Resetting configuration...', 'user');
    showTyping(true, 'Resetting...');

    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) {
        showTyping(false);
        logEl.textContent += t + '\n';
        outputToChat('Reset complete: ' + t, 'system');
        return refreshStatus();
      })
      .catch(function (e) {
        showTyping(false);
        logEl.textContent += 'Error: ' + String(e) + '\n';
        outputToChat('Reset error: ' + String(e), 'error');
      });
  };

  // =========================================================================
  // Direct Chat with OpenClaw
  // =========================================================================

  function sendChatMessage() {
    if (!chatInputEl || !chatMessagesEl) return;

    var message = chatInputEl.value.trim();
    if (!message) return;

    // Check for special commands
    if (message.startsWith('/')) {
      handleChatCommand(message);
      chatInputEl.value = '';
      return;
    }

    // Disable input while sending
    chatInputEl.disabled = true;
    if (chatSendEl) chatSendEl.disabled = true;
    chatInputEl.value = '';

    // Add user message to chat
    addChatMessage(message, 'user');
    showTyping(true, 'OpenClaw is thinking...');

    fetch('/setup/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: message })
    })
    .then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, data: data };
      });
    })
    .then(function (result) {
      showTyping(false);

      if (result.ok && result.data.ok) {
        addChatMessage(result.data.response, 'assistant');
      } else {
        var errorMsg = result.data.error || 'Failed to get response';
        if (result.data.details) {
          errorMsg += '\n\n' + result.data.details;
        }
        addChatMessage(errorMsg, 'error');
      }
    })
    .catch(function (e) {
      showTyping(false);
      addChatMessage('Error: ' + String(e), 'error');
    })
    .finally(function () {
      chatInputEl.disabled = false;
      if (chatSendEl) chatSendEl.disabled = false;
      chatInputEl.focus();
    });
  }

  // Handle slash commands in chat
  function handleChatCommand(input) {
    var parts = input.slice(1).split(/\s+/);
    var cmd = parts[0].toLowerCase();
    var args = parts.slice(1).join(' ');

    addChatMessage(input, 'user');

    // Helper function for running console commands
    function runChatConsoleCmd(consoleCmdName, displayName, argValue) {
      showTyping(true, displayName + '...');
      return httpJson('/setup/api/console/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: consoleCmdName, arg: argValue || '' })
      }).then(function (j) {
        showTyping(false);
        addChatMessage(j.output || JSON.stringify(j), 'system-output');
      }).catch(function (e) {
        showTyping(false);
        addChatMessage('Error: ' + String(e), 'error');
      });
    }

    switch (cmd) {
      case 'help':
        addChatMessage(
          'Available commands:\n\n' +
          '**Diagnostics**\n' +
          '/health - Run health check\n' +
          '/fix - Fix all issues automatically\n' +
          '/doctor - Run OpenClaw diagnostics\n' +
          '/troubleshoot - Run comprehensive troubleshooter\n' +
          '/status - Show current status\n' +
          '/logs [n] - Show last n log lines (default: 100)\n\n' +
          '**Gateway**\n' +
          '/restart - Restart gateway\n' +
          '/probe - Test gateway connectivity\n\n' +
          '**Security**\n' +
          '/audit - Run security audit\n' +
          '/audit deep - Run deep security scan\n\n' +
          '**Sessions & Memory**\n' +
          '/sessions - List active sessions\n' +
          '/memory - Show memory status\n\n' +
          '**Channels**\n' +
          '/channels - Show channel status\n\n' +
          '**System**\n' +
          '/version - Show version info\n' +
          '/update - Check for updates\n' +
          '/storage - Storage diagnostics\n' +
          '/network - Network diagnostics\n' +
          '/clear - Clear chat history\n\n' +
          'Or just type a message to chat with OpenClaw!',
          'system'
        );
        break;

      case 'health':
        runHealthCheck();
        break;

      case 'fix':
        runFixAll();
        break;

      case 'troubleshoot':
        var level = args === 'deep' ? 'deep' : (args === 'quick' ? 'quick' : 'standard');
        runTroubleshoot(level);
        break;

      case 'doctor':
        runChatConsoleCmd('openclaw.doctor', 'Running diagnostics');
        break;

      case 'status':
        runChatConsoleCmd(args === 'all' ? 'openclaw.status.all' : 'openclaw.status', 'Getting status');
        break;

      case 'logs':
        var lineCount = parseInt(args, 10) || 100;
        runChatConsoleCmd('openclaw.logs.tail', 'Getting logs', String(lineCount));
        break;

      case 'restart':
        showTyping(true, 'Restarting gateway...');
        httpJson('/setup/api/console/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd: 'gateway.restart', arg: '' })
        }).then(function (j) {
          showTyping(false);
          addChatMessage('Gateway restarted.\n' + (j.output || ''), 'system');
        }).catch(function (e) {
          showTyping(false);
          addChatMessage('Error: ' + String(e), 'error');
        });
        break;

      case 'probe':
        runChatConsoleCmd('gateway.probe', 'Probing gateway');
        break;

      case 'audit':
        var auditCmd = args === 'deep' ? 'openclaw.security.audit.deep' : 'openclaw.security.audit';
        runChatConsoleCmd(auditCmd, 'Running security audit');
        break;

      case 'sessions':
        runChatConsoleCmd('openclaw.sessions.list', 'Getting sessions');
        break;

      case 'memory':
        runChatConsoleCmd('openclaw.memory.status', 'Getting memory status');
        break;

      case 'channels':
        runChatConsoleCmd('openclaw.channels.status', 'Getting channel status');
        break;

      case 'version':
        runChatConsoleCmd('openclaw.version', 'Getting version');
        break;

      case 'update':
        runChatConsoleCmd('openclaw.update.check', 'Checking for updates');
        break;

      case 'storage':
        runChatConsoleCmd('wrapper.storage.check', 'Running storage diagnostics');
        break;

      case 'network':
        runChatConsoleCmd('wrapper.network.check', 'Running network diagnostics');
        break;

      case 'clear':
        if (chatMessagesEl) {
          chatMessagesEl.innerHTML = '<div class="chat-message system">Chat cleared. Type /help for commands or just chat with OpenClaw!</div>';
        }
        break;

      default:
        addChatMessage('Unknown command: /' + cmd + '. Type /help for available commands.', 'error');
    }
  }

  // Wire up chat send button
  if (chatSendEl) {
    chatSendEl.onclick = sendChatMessage;
  }

  // Wire up Enter key in chat input
  if (chatInputEl) {
    chatInputEl.onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    };
  }

  // Initial load
  refreshStatus();

  // Show welcome message in chat
  if (chatMessagesEl) {
    setTimeout(function () {
      addChatMessage(
        'Welcome! Type a message to chat with OpenClaw, or use commands:\n' +
        '/help - Show all available commands\n' +
        '/troubleshoot - Run comprehensive diagnostics\n' +
        '/health - Quick health check\n' +
        '/status - Show current status',
        'system'
      );
    }, 500);
  }
})();
