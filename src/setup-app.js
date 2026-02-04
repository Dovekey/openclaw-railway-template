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

  function setStatus(s) {
    statusEl.textContent = s;
  }

  // Filter authChoice options based on selected authGroup
  // Options are pre-rendered with data-group attribute, we just show/hide optgroups
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
        // Check if current value is in this group
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

    // If current selection is no longer visible, select the first visible option
    if (!currentValueStillVisible && firstVisibleOption) {
      authChoiceEl.value = firstVisibleOption.value;
    }
  }

  // Set up cascading behavior for auth selects
  if (authGroupEl && authChoiceEl) {
    authGroupEl.onchange = filterAuthChoices;
    // Initial filter based on pre-selected group
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

      // Options are pre-rendered in HTML, no need to call renderAuth()
      // Just ensure the cascading filter is applied
      if (authGroupEl && authChoiceEl) {
        filterAuthChoices();
      }

      // If channels are unsupported, surface it for debugging.
      if (j.channelsAddHelp && j.channelsAddHelp.indexOf('telegram') === -1) {
        logEl.textContent += '\nNote: this openclaw build does not list telegram in `channels add --help`. Telegram auto-add will be skipped.\n';
      }

      // Attempt to load config editor content if present.
      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }

    }).catch(function (e) {
      setStatus('Error: ' + String(e));
    });
  }

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

    logEl.textContent = 'Running...\n';

    fetch('/setup/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      logEl.textContent += (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      logEl.textContent += '\nError: ' + String(e) + '\n';
    });
  };

  // Command hints for the debug console
  var commandHints = {
    'gateway.restart': 'Restarts the internal gateway process',
    'gateway.stop': 'Stops the internal gateway process',
    'gateway.start': 'Starts the internal gateway process',
    'openclaw.doctor': 'Runs diagnostics and shows any issues',
    'openclaw.doctor.fix': 'Runs diagnostics and attempts to fix issues automatically',
    'openclaw.status': 'Shows current status',
    'openclaw.health': 'Health check endpoint status',
    'openclaw.logs.tail': 'Arg: number of lines (50-1000, default: 200)',
    'openclaw.security.audit': 'Arg: "deep" for thorough scan',
    'openclaw.config.get': 'Arg: config path (e.g. gateway.port, security.dmPolicy)',
    'openclaw.version': 'Shows version information',
    'wrapper.fix.dirs': 'Creates missing directories (credentials, identity, logs, sessions)',
    'wrapper.fix.permissions': 'Sets directory permissions to 700 (owner only)',
    'wrapper.env.check': 'Shows environment variables and directory status'
  };

  var consoleArgHintEl = document.getElementById('consoleArgHint');

  // Update hint when command changes
  function updateCommandHint() {
    if (!consoleCmdEl || !consoleArgHintEl) return;
    var cmd = consoleCmdEl.value;
    var hint = commandHints[cmd] || '';
    consoleArgHintEl.textContent = hint;

    // Also update placeholder based on command
    if (consoleArgEl) {
      if (cmd === 'openclaw.logs.tail') {
        consoleArgEl.placeholder = 'Lines (50-1000)';
      } else if (cmd === 'openclaw.config.get') {
        consoleArgEl.placeholder = 'Config path (e.g. gateway.port)';
      } else if (cmd === 'openclaw.security.audit') {
        consoleArgEl.placeholder = 'Optional: deep';
      } else {
        consoleArgEl.placeholder = '';
      }
    }
  }

  if (consoleCmdEl) {
    consoleCmdEl.onchange = updateCommandHint;
    updateCommandHint(); // Initial hint
  }

  // Debug console runner
  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) consoleOutEl.textContent = 'Running ' + cmd + '...\n';

    return httpJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg })
    }).then(function (j) {
      if (consoleOutEl) consoleOutEl.textContent = (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      if (consoleOutEl) consoleOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (consoleRunEl) {
    consoleRunEl.onclick = runConsole;
  }

  // Health check elements
  var healthCheckBtn = document.getElementById('healthCheck');
  var fixAllBtn = document.getElementById('fixAllIssues');
  var healthOutEl = document.getElementById('healthOut');
  var healthStatusEl = document.getElementById('healthStatus');
  var healthStatusTextEl = document.getElementById('healthStatusText');
  var healthProgressEl = document.getElementById('healthProgress');

  function showHealthStatus(text, progress, color) {
    if (healthStatusEl) {
      healthStatusEl.style.display = 'block';
      healthStatusEl.style.borderLeft = '4px solid ' + (color || '#3b82f6');
    }
    if (healthStatusTextEl) healthStatusTextEl.textContent = text;
    if (healthProgressEl) healthProgressEl.textContent = progress || '';
  }

  function hideHealthStatus() {
    if (healthStatusEl) healthStatusEl.style.display = 'none';
  }

  // Run health check
  function runHealthCheck() {
    if (healthOutEl) healthOutEl.textContent = '';
    showHealthStatus('🔍 Running health check...', 'Please wait...', '#3b82f6');

    return httpJson('/setup/api/health').then(function (j) {
      if (healthOutEl) healthOutEl.textContent = j.output || JSON.stringify(j, null, 2);

      if (j.healthy) {
        showHealthStatus('✅ System is healthy!', 'No issues detected', '#10b981');
      } else {
        var issueCount = j.issues ? j.issues.length : 0;
        showHealthStatus(
          '⚠️ Issues detected (' + issueCount + ')',
          'Click "Fix All Issues" to repair automatically',
          '#f59e0b'
        );
      }
      return refreshStatus();
    }).catch(function (e) {
      if (healthOutEl) healthOutEl.textContent = 'Error: ' + String(e);
      showHealthStatus('❌ Health check failed', String(e), '#ef4444');
    });
  }

  // Fix all issues
  function runFixAll() {
    if (!confirm('This will attempt to fix all detected issues:\n\n• Create missing directories\n• Fix directory permissions\n• Run openclaw doctor --fix\n• Restart the gateway\n\nContinue?')) {
      return;
    }

    if (healthOutEl) healthOutEl.textContent = '';
    showHealthStatus('🔧 Fixing issues...', 'Step 1/4: Creating directories...', '#8b5cf6');

    return httpJson('/setup/api/health/fix-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }).then(function (j) {
      if (healthOutEl) healthOutEl.textContent = j.output || JSON.stringify(j, null, 2);

      if (j.healthy) {
        showHealthStatus('✅ All issues fixed!', 'System is now healthy', '#10b981');
      } else if (j.ok) {
        showHealthStatus(
          '⚠️ Repairs completed with warnings',
          'Some issues may require manual attention',
          '#f59e0b'
        );
      } else {
        showHealthStatus(
          '❌ Some repairs failed',
          'Check the output below for details',
          '#ef4444'
        );
      }
      return refreshStatus();
    }).catch(function (e) {
      if (healthOutEl) healthOutEl.textContent = 'Error: ' + String(e);
      showHealthStatus('❌ Fix failed', String(e), '#ef4444');
    });
  }

  if (healthCheckBtn) healthCheckBtn.onclick = runHealthCheck;
  if (fixAllBtn) fixAllBtn.onclick = runFixAll;

  // Config raw load/save
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = '';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = 'Config file: ' + (j.path || '(unknown)') + (j.exists ? '' : ' (does not exist yet)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent = 'Error loading config: ' + String(e);
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway? A timestamped .bak backup will be created.')) return;
    if (configOutEl) configOutEl.textContent = 'Saving...\n';
    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved: ' + (j.path || '') + '\nGateway restarted.\n';
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // Import backup
  function runImport() {
    if (!importRunEl || !importFileEl) return;
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) {
      alert('Pick a .tar.gz file first');
      return;
    }
    if (!confirm('Import backup? This overwrites files under /data and restarts the gateway.')) return;

    if (importOutEl) importOutEl.textContent = 'Uploading ' + f.name + ' (' + f.size + ' bytes)...\n';

    return f.arrayBuffer().then(function (buf) {
      return fetch('/setup/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/gzip' },
        body: buf
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        if (importOutEl) importOutEl.textContent += t + '\n';
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + t);
        return refreshStatus();
      });
    }).catch(function (e) {
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (importRunEl) importRunEl.onclick = runImport;

  // Pairing approve helper
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Enter channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') {
        alert('Channel must be "telegram" or "discord"');
        return;
      }
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      logEl.textContent += '\nApproving pairing for ' + channel + '...\n';
      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { logEl.textContent += t + '\n'; })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  // List pending pairing requests
  var pairingListBtn = document.getElementById('pairingList');
  if (pairingListBtn) {
    pairingListBtn.onclick = function () {
      logEl.textContent += '\nFetching pending pairing requests...\n';
      httpJson('/setup/api/pairing/pending')
        .then(function (j) {
          if (j.pending && j.pending.length > 0) {
            logEl.textContent += 'Pending pairing requests:\n';
            for (var i = 0; i < j.pending.length; i++) {
              var p = j.pending[i];
              logEl.textContent += '  - ' + (p.channel || p.type) + ': ' + (p.code || p.pairingCode) + '\n';
            }
          } else {
            logEl.textContent += 'No pending pairing requests.\n';
            if (j.output) logEl.textContent += j.output + '\n';
          }
        })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  // Approve all pending pairing requests
  var pairingApproveAllBtn = document.getElementById('pairingApproveAll');
  if (pairingApproveAllBtn) {
    pairingApproveAllBtn.onclick = function () {
      if (!confirm('Approve ALL pending pairing requests? This grants DM access to all pending users.')) return;
      logEl.textContent += '\nApproving all pending pairing requests...\n';
      httpJson('/setup/api/pairing/approve-all', { method: 'POST' })
        .then(function (j) {
          if (j.approved > 0) {
            logEl.textContent += 'Approved ' + j.approved + ' pairing request(s).\n';
            for (var i = 0; i < j.results.length; i++) {
              var r = j.results[i];
              logEl.textContent += '  - ' + r.channel + ' (' + r.code + '): ' + (r.ok ? 'OK' : 'FAILED') + '\n';
            }
          } else {
            logEl.textContent += 'No pending pairing requests to approve.\n';
          }
        })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config file so onboarding can run again.')) return;
    logEl.textContent = 'Resetting...\n';
    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) { logEl.textContent += t + '\n'; return refreshStatus(); })
      .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
  };

  refreshStatus();
})();
