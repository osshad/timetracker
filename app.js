// ===== TimeTracker App =====
(() => {
  'use strict';

  // -- API helpers --
  async function api(path, options = {}) {
    const url = '/api/' + path;
    const token = typeof window.getIdToken === 'function' ? await window.getIdToken() : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Auth-Token'] = token;
    const opts = {
      headers: headers,
      ...options
    };
    if (opts.body && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    if (res.status === 204) return null;
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'API error');
    }
    return res.json();
  }

  // -- Local-only state --
  let projects = [];
  let entries = [];
  let currentDate = new Date();
  let currentWeekStart = getWeekStart(new Date());
  let reportWeekStart = getWeekStart(new Date());
  let timerRunning = false;
  let timerStart = null;
  let timerInterval = null;
  let editingEntryId = null;
  let syncInterval = null;
  const SYNC_INTERVAL_MS = 30000; // Poll every 30 seconds

  // Unique device ID to distinguish which device started the timer
  const deviceId = (() => {
    let id = localStorage.getItem('tt_device_id');
    if (!id) { id = genId(); localStorage.setItem('tt_device_id', id); }
    return id;
  })();

  // Running timer kept in localStorage (client-side only until stopped)
  const savedTimer = (() => {
    try { return JSON.parse(localStorage.getItem('tt_running_timer')); } catch { return null; }
  })();

  // -- Utility --
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h + ':' + String(m).padStart(2, '0');
  }

  function formatTimer(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function formatTime(date) {
    const d = new Date(date);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }

  function formatDateLabel(d) {
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const dayPart = d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short' });
    if (dateKey(d) === dateKey(today)) return 'Today: ' + dayPart;
    if (dateKey(d) === dateKey(yesterday)) return 'Yesterday: ' + dayPart;
    return dayPart;
  }

  function getWeekStart(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    date.setDate(diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function getWeekDays(start) {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // -- Load initial data from API --
  async function loadData() {
    try {
      const results = await Promise.all([api('projects'), api('entries')]);
      projects = results[0];
      entries = results[1];
    } catch (err) {
      console.error('Failed to load data:', err);
      projects = [];
      entries = [];
    }

    populateProjectSelects();
    renderEntries();

    // Restore running timer: check remote state first, then fall back to localStorage
    try {
      const remoteTimer = await api('timer-state');
      if (remoteTimer && remoteTimer.running) {
        timerStart = new Date(remoteTimer.start);
        document.getElementById('taskDesc').value = remoteTimer.desc || '';
        document.getElementById('projectSelect').value = remoteTimer.projectId || '';
        startTimerUI();
      } else if (savedTimer) {
        timerStart = new Date(savedTimer.start);
        document.getElementById('taskDesc').value = savedTimer.desc || '';
        document.getElementById('projectSelect').value = savedTimer.projectId || '';
        startTimerUI();
        syncTimerToAPI();
      }
    } catch (err) {
      // Fall back to localStorage if API fails
      if (savedTimer) {
        timerStart = new Date(savedTimer.start);
        document.getElementById('taskDesc').value = savedTimer.desc || '';
        document.getElementById('projectSelect').value = savedTimer.projectId || '';
        startTimerUI();
      }
    }

    // Start cross-device polling
    startPolling();
  }

  // Expose globally so auth.js can call it after login
  window.initTimeTracker = loadData;

  // -- Navigation --
  document.querySelectorAll('.nav-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.nav-tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
      document.getElementById('view-' + btn.dataset.view).classList.add('active');

      if (btn.dataset.view === 'timesheet') renderTimesheet();
      if (btn.dataset.view === 'reports') renderReports();
      if (btn.dataset.view === 'projects') renderProjects();
    });
  });

  // -- New Entry button (focus timer bar) --
  document.getElementById('newEntryBtn').addEventListener('click', function() {
    taskDesc.focus();
    document.getElementById('timerInputBar').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // -- Timer --
  const timerDisplay = document.getElementById('timerDisplay');
  const timerToggle = document.getElementById('timerToggle');
  const taskDesc = document.getElementById('taskDesc');
  const projectSelect = document.getElementById('projectSelect');

  timerToggle.addEventListener('click', function() {
    if (timerRunning) stopTimer();
    else startTimer();
  });

  const CLOCK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

  function startTimerUI() {
    timerRunning = true;
    timerToggle.innerHTML = CLOCK_SVG + ' Stop';
    timerToggle.className = 'timer-action-btn stop';
    document.getElementById('timerInputBar').classList.add('running');
    timerInterval = setInterval(function() {
      timerDisplay.textContent = formatTimer(Date.now() - timerStart.getTime());
    }, 1000);
    timerDisplay.textContent = formatTimer(Date.now() - timerStart.getTime());
    renderWeekBar();
  }

  function startTimer() {
    timerStart = new Date();
    localStorage.setItem('tt_running_timer', JSON.stringify({
      start: timerStart.toISOString(),
      desc: taskDesc.value,
      projectId: projectSelect.value
    }));
    startTimerUI();
    // Sync timer state to API for cross-device visibility
    syncTimerToAPI();
  }

  async function stopTimer() {
    timerRunning = false;
    clearInterval(timerInterval);
    renderWeekBar();

    const end = new Date();
    const entry = {
      desc: taskDesc.value || 'Untitled',
      projectId: projectSelect.value || '',
      start: timerStart.toISOString(),
      end: end.toISOString(),
      date: dateKey(timerStart),
      duration: end.getTime() - timerStart.getTime()
    };

    try {
      const saved = await api('entries', { method: 'POST', body: entry });
      entries.push(saved);
    } catch (err) {
      console.error('Failed to save entry:', err);
      entry.id = genId();
      entries.push(entry);
    }

    localStorage.removeItem('tt_running_timer');
    timerToggle.innerHTML = CLOCK_SVG + ' Start';
    timerToggle.className = 'timer-action-btn start';
    document.getElementById('timerInputBar').classList.remove('running');
    timerDisplay.textContent = '0:00:00';
    taskDesc.value = '';

    // Clear remote timer state
    clearTimerFromAPI();

    currentDate = new Date(timerStart);
    renderEntries();
  }

  taskDesc.addEventListener('input', saveRunningTimer);
  projectSelect.addEventListener('change', saveRunningTimer);
  function saveRunningTimer() {
    if (timerRunning) {
      localStorage.setItem('tt_running_timer', JSON.stringify({
        start: timerStart.toISOString(),
        desc: taskDesc.value,
        projectId: projectSelect.value
      }));
      syncTimerToAPI();
    }
  }

  // -- Cross-device sync --
  async function syncTimerToAPI() {
    try {
      await api('timer-state', {
        method: 'PUT',
        body: {
          start: timerStart.toISOString(),
          desc: taskDesc.value,
          projectId: projectSelect.value,
          deviceId: deviceId
        }
      });
    } catch (err) {
      console.warn('Failed to sync timer state:', err);
    }
  }

  async function clearTimerFromAPI() {
    try {
      await api('timer-state', { method: 'DELETE' });
    } catch (err) {
      console.warn('Failed to clear remote timer state:', err);
    }
  }

  async function pollSync() {
    try {
      // 1. Check remote timer state
      const remoteTimer = await api('timer-state');

      if (remoteTimer && remoteTimer.running) {
        // Timer is running remotely
        if (!timerRunning) {
          // Start the timer locally to match remote state
          timerStart = new Date(remoteTimer.start);
          taskDesc.value = remoteTimer.desc || '';
          projectSelect.value = remoteTimer.projectId || '';
          localStorage.setItem('tt_running_timer', JSON.stringify({
            start: timerStart.toISOString(),
            desc: remoteTimer.desc || '',
            projectId: remoteTimer.projectId || ''
          }));
          startTimerUI();
          showSyncNotice('Timer synced from another device');
        } else if (remoteTimer.deviceId !== deviceId) {
          // Update description/project if changed on another device
          if (remoteTimer.desc !== taskDesc.value || remoteTimer.projectId !== projectSelect.value) {
            taskDesc.value = remoteTimer.desc || '';
            projectSelect.value = remoteTimer.projectId || '';
          }
          // Sync start time if different (timer was restarted on other device)
          const remoteStart = new Date(remoteTimer.start).getTime();
          if (Math.abs(remoteStart - timerStart.getTime()) > 2000) {
            timerStart = new Date(remoteTimer.start);
            localStorage.setItem('tt_running_timer', JSON.stringify({
              start: timerStart.toISOString(),
              desc: remoteTimer.desc || '',
              projectId: remoteTimer.projectId || ''
            }));
          }
        }
      } else if (!remoteTimer.running && timerRunning) {
        // Timer was stopped on another device — stop locally too
        timerRunning = false;
        clearInterval(timerInterval);
        localStorage.removeItem('tt_running_timer');
        timerToggle.innerHTML = CLOCK_SVG + ' Start';
        timerToggle.className = 'timer-action-btn start';
        document.getElementById('timerInputBar').classList.remove('running');
        timerDisplay.textContent = '0:00:00';
        taskDesc.value = '';
        showSyncNotice('Timer stopped from another device');
      }

      // 2. Refresh entries for the current view
      const freshEntries = await api('entries?date=' + dateKey(currentDate));
      const key = dateKey(currentDate);
      const oldDayEntries = entries.filter(function(e) { return e.date === key; });
      const changed = freshEntries.length !== oldDayEntries.length ||
        JSON.stringify(freshEntries.map(function(e) { return e.id; }).sort()) !==
        JSON.stringify(oldDayEntries.map(function(e) { return e.id; }).sort());
      if (changed) {
        entries = entries.filter(function(e) { return e.date !== key; }).concat(freshEntries);
        renderEntries();
      }
    } catch (err) {
      // Silent fail — don't disrupt the user
      console.warn('Sync poll failed:', err);
    }
  }

  function showSyncNotice(msg) {
    let notice = document.getElementById('syncNotice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'syncNotice';
      notice.style.cssText = 'position:fixed;top:16px;right:16px;background:#4c6ef5;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:9999;opacity:0;transition:opacity 0.3s;box-shadow:0 2px 12px rgba(0,0,0,0.15)';
      document.body.appendChild(notice);
    }
    notice.textContent = msg;
    notice.style.opacity = '1';
    setTimeout(function() { notice.style.opacity = '0'; }, 3000);
  }

  function startPolling() {
    if (syncInterval) return;
    syncInterval = setInterval(pollSync, SYNC_INTERVAL_MS);
  }

  function stopPolling() {
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  }

  // Pause polling when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      stopPolling();
    } else {
      pollSync(); // Immediate sync when returning to tab
      startPolling();
    }
  });

  // -- Date Navigation --
  document.getElementById('prevDay').addEventListener('click', function() {
    currentDate.setDate(currentDate.getDate() - 1);
    loadEntriesForDate();
  });
  document.getElementById('nextDay').addEventListener('click', function() {
    currentDate.setDate(currentDate.getDate() + 1);
    loadEntriesForDate();
  });

  async function loadEntriesForDate() {
    try {
      const dayEntries = await api('entries?date=' + dateKey(currentDate));
      entries = entries.filter(function(e) { return e.date !== dateKey(currentDate); }).concat(dayEntries);
    } catch (err) {
      console.error('Failed to load entries:', err);
    }
    renderEntries();
  }

  // -- Render Entries (Harvest-style) --
  function renderEntries() {
    document.getElementById('currentDateLabel').textContent = formatDateLabel(currentDate);

    const key = dateKey(currentDate);
    const dayEntries = entries.filter(function(e) { return e.date === key; }).sort(function(a, b) { return new Date(b.start) - new Date(a.start); });
    const totalMs = dayEntries.reduce(function(sum, e) { return sum + e.duration; }, 0);
    document.getElementById('dailyTotal').textContent = formatDuration(totalMs);

    const list = document.getElementById('entriesList');
    if (dayEntries.length === 0) {
      list.innerHTML = '<div class="no-entries"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><p>No time entries for this day</p><p style="font-size:13px">Start the timer above to track your work</p></div>';
      renderWeekBar();
      return;
    }

    list.innerHTML = dayEntries.map(function(e) {
      const project = projects.find(function(p) { return p.id === e.projectId; });
      const projLabel = project ? '<span class="entry-project-inline">(' + escapeHtml(project.name) + ')</span>' : '';
      return '<div class="entry-row" data-id="' + e.id + '">' +
        '<div class="entry-info">' +
          '<div class="entry-title"><strong>' + escapeHtml(e.desc) + '</strong> ' + projLabel + '</div>' +
          '<div class="entry-meta">' + formatTime(e.start) + ' \u2013 ' + formatTime(e.end) + '</div>' +
        '</div>' +
        '<span class="entry-duration">' + formatDuration(e.duration) + '</span>' +
        '<div class="entry-actions">' +
          '<button class="entry-start-btn" data-desc="' + escapeHtml(e.desc).replace(/"/g, '&quot;') + '" data-project="' + (e.projectId || '') + '">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
            ' Start</button>' +
          '<button class="entry-edit-btn" data-id="' + e.id + '">Edit</button>' +
        '</div>' +
        '</div>';
    }).join('');

    // Edit button opens modal
    list.querySelectorAll('.entry-edit-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        openEditModal(btn.dataset.id);
      });
    });

    // Start button restarts timer with same desc/project
    list.querySelectorAll('.entry-start-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        restartEntry(btn.dataset.desc, btn.dataset.project);
      });
    });

    renderWeekBar();
  }

  // -- Restart entry (like Harvest Start button) --
  function restartEntry(desc, projectId) {
    if (timerRunning) {
      // Stop and save current timer first
      stopTimer().then(function() {
        taskDesc.value = desc;
        projectSelect.value = projectId || '';
        startTimer();
      });
    } else {
      taskDesc.value = desc;
      projectSelect.value = projectId || '';
      startTimer();
    }
  }

  // -- Render Week Bar --
  function renderWeekBar() {
    const weekStart = getWeekStart(currentDate);
    const days = getWeekDays(weekStart);
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const today = new Date();
    const todayKey = dateKey(today);
    const selectedKey = dateKey(currentDate);
    let weekTotalMs = 0;

    const html = days.map(function(d, i) {
      const dk = dateKey(d);
      const dayEntries = entries.filter(function(e) { return e.date === dk; });
      const totalMs = dayEntries.reduce(function(s, e) { return s + e.duration; }, 0);
      weekTotalMs += totalMs;
      const isToday = dk === todayKey;
      const isSelected = dk === selectedKey;
      const hasTimer = isToday && timerRunning;
      const cls = 'week-day-col' + (isToday ? ' today' : '') + (isSelected ? ' selected' : '');

      return '<div class="' + cls + '" data-date="' + dk + '">' +
        '<div class="week-day-name">' + dayNames[i] + (hasTimer ? ' \u23F1' : '') + '</div>' +
        '<div class="week-day-hours">' + (totalMs > 0 ? formatDuration(totalMs) : '0:00') + '</div>' +
        '</div>';
    }).join('');

    document.getElementById('weekDaysBar').innerHTML = html;
    document.getElementById('weekTotalDisplay').textContent = formatDuration(weekTotalMs);

    // Click a day to navigate
    document.querySelectorAll('.week-day-col').forEach(function(col) {
      col.addEventListener('click', function() {
        var parts = col.dataset.date.split('-');
        currentDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        loadEntriesForDate();
      });
    });
  }

  // -- Edit Modal --
  const editModal = document.getElementById('editModal');
  const editDesc = document.getElementById('editDesc');
  const editProject = document.getElementById('editProject');
  const editStart = document.getElementById('editStart');
  const editEnd = document.getElementById('editEnd');

  function openEditModal(id) {
    const entry = entries.find(function(e) { return e.id === id; });
    if (!entry) return;
    editingEntryId = id;
    editDesc.value = entry.desc;
    populateProjectSelect(editProject, entry.projectId);
    editStart.value = formatTime(entry.start);
    editEnd.value = formatTime(entry.end);
    editModal.classList.remove('hidden');
  }

  document.getElementById('saveEdit').addEventListener('click', async function() {
    const entry = entries.find(function(e) { return e.id === editingEntryId; });
    if (!entry) return;

    const startDate = new Date(entry.start);
    const sParts = editStart.value.split(':').map(Number);
    startDate.setHours(sParts[0], sParts[1], 0, 0);

    const endDate = new Date(entry.end);
    const eParts = editEnd.value.split(':').map(Number);
    endDate.setHours(eParts[0], eParts[1], 0, 0);

    const updates = {
      desc: editDesc.value || 'Untitled',
      projectId: editProject.value,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      duration: Math.max(0, endDate.getTime() - startDate.getTime())
    };

    try {
      const updated = await api('entries/' + editingEntryId, { method: 'PUT', body: updates });
      Object.assign(entry, updated);
    } catch (err) {
      console.error('Failed to update entry:', err);
      Object.assign(entry, updates);
    }

    editModal.classList.add('hidden');
    renderEntries();
  });

  document.getElementById('deleteEntry').addEventListener('click', async function() {
    try {
      await api('entries/' + editingEntryId, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to delete entry:', err);
    }
    entries = entries.filter(function(e) { return e.id !== editingEntryId; });
    editModal.classList.add('hidden');
    renderEntries();
  });

  document.getElementById('cancelEdit').addEventListener('click', function() {
    editModal.classList.add('hidden');
  });

  editModal.addEventListener('click', function(e) {
    if (e.target === editModal) editModal.classList.add('hidden');
  });

  // -- Timesheet View --
  document.getElementById('prevWeek').addEventListener('click', function() {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    loadWeekEntries().then(renderTimesheet);
  });
  document.getElementById('nextWeek').addEventListener('click', function() {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    loadWeekEntries().then(renderTimesheet);
  });

  async function loadWeekEntries() {
    const days = getWeekDays(currentWeekStart);
    const from = dateKey(days[0]);
    const to = dateKey(days[6]);
    try {
      const weekEntries = await api('entries?from=' + from + '&to=' + to);
      const dayKeys = new Set(days.map(function(d) { return dateKey(d); }));
      entries = entries.filter(function(e) { return !dayKeys.has(e.date); }).concat(weekEntries);
    } catch (err) {
      console.error('Failed to load week entries:', err);
    }
  }

  function renderTimesheet() {
    const days = getWeekDays(currentWeekStart);
    const weekEnd = new Date(days[6]);

    document.getElementById('weekLabel').textContent =
      days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' \u2013 ' + weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const projectIds = new Set();
    const dayKeys = days.map(function(d) { return dateKey(d); });
    entries.forEach(function(e) {
      if (dayKeys.includes(e.date)) projectIds.add(e.projectId || '__none__');
    });

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let weekTotal = 0;

    let html = '<table class="timesheet-table"><thead><tr><th style="text-align:left">Project</th>' +
      days.map(function(d, i) { return '<th>' + dayNames[i] + '<br><span style="font-weight:400">' + d.getDate() + '</span></th>'; }).join('') +
      '<th>Total</th></tr></thead><tbody>';

    var pids = Array.from(projectIds);
    pids.forEach(function(pid) {
      const project = projects.find(function(p) { return p.id === pid; });
      const name = project ? project.name : 'No Project';
      let rowTotal = 0;

      const cells = days.map(function(d) {
        const dk = dateKey(d);
        const dayEntries = entries.filter(function(e) { return e.date === dk && (e.projectId || '__none__') === pid; });
        const totalHrs = dayEntries.reduce(function(s, e) { return s + e.duration; }, 0) / 3600000;
        rowTotal += totalHrs;
        weekTotal += totalHrs;
        return '<td>' + (totalHrs > 0 ? totalHrs.toFixed(1) : '\u2013') + '</td>';
      }).join('');

      html += '<tr><td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (project ? project.color : '#ccc') + ';margin-right:8px"></span>' + escapeHtml(name) + '</td>' + cells + '<td><strong>' + rowTotal.toFixed(1) + '</strong></td></tr>';
    });

    const dayTotals = days.map(function(d) {
      const dk = dateKey(d);
      return entries.filter(function(e) { return e.date === dk; }).reduce(function(s, e) { return s + e.duration; }, 0) / 3600000;
    });

    html += '</tbody><tfoot><tr><td>Daily Total</td>' +
      dayTotals.map(function(t) { return '<td>' + (t > 0 ? t.toFixed(1) : '\u2013') + '</td>'; }).join('') +
      '<td>' + weekTotal.toFixed(1) + '</td></tr></tfoot></table>';

    document.getElementById('timesheetGrid').innerHTML = html;
    document.getElementById('weeklyTotal').textContent = formatDuration(weekTotal * 3600000);
  }

  // -- Reports View --
  document.getElementById('prevReportWeek').addEventListener('click', function() {
    reportWeekStart.setDate(reportWeekStart.getDate() - 7);
    loadReportWeekEntries().then(renderReports);
  });
  document.getElementById('nextReportWeek').addEventListener('click', function() {
    reportWeekStart.setDate(reportWeekStart.getDate() + 7);
    loadReportWeekEntries().then(renderReports);
  });

  async function loadReportWeekEntries() {
    const days = getWeekDays(reportWeekStart);
    const from = dateKey(days[0]);
    const to = dateKey(days[6]);
    try {
      const weekEntries = await api('entries?from=' + from + '&to=' + to);
      const dayKeys = new Set(days.map(function(d) { return dateKey(d); }));
      entries = entries.filter(function(e) { return !dayKeys.has(e.date); }).concat(weekEntries);
    } catch (err) {
      console.error('Failed to load report entries:', err);
    }
  }

  function renderReports() {
    const days = getWeekDays(reportWeekStart);
    const weekEnd = new Date(days[6]);

    document.getElementById('reportWeekLabel').textContent =
      days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' \u2013 ' + weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const dayKeys = days.map(function(d) { return dateKey(d); });
    const weekEntries = entries.filter(function(e) { return dayKeys.includes(e.date); });

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const dailyHours = days.map(function(d) {
      const dk = dateKey(d);
      return entries.filter(function(e) { return e.date === dk; }).reduce(function(s, e) { return s + e.duration; }, 0) / 3600000;
    });

    drawBarChart('dailyChart', dayNames, dailyHours, '#4c6ef5');

    const projectHrs = {};
    weekEntries.forEach(function(e) {
      const pid = e.projectId || '__none__';
      projectHrs[pid] = (projectHrs[pid] || 0) + e.duration / 3600000;
    });

    const pLabels = [];
    const pValues = [];
    const pColors = [];
    Object.entries(projectHrs).sort(function(a, b) { return b[1] - a[1]; }).forEach(function(pair) {
      const p = projects.find(function(pr) { return pr.id === pair[0]; });
      pLabels.push(p ? p.name : 'No Project');
      pValues.push(pair[1]);
      pColors.push(p ? p.color : '#ccc');
    });

    drawBarChart('projectChart', pLabels, pValues, pColors);

    const totalHrs = weekEntries.reduce(function(s, e) { return s + e.duration; }, 0) / 3600000;
    const daysWorked = new Set(weekEntries.map(function(e) { return e.date; })).size;
    const avgPerDay = daysWorked > 0 ? totalHrs / daysWorked : 0;
    const totalEntries = weekEntries.length;

    document.getElementById('reportSummary').innerHTML =
      '<div class="summary-grid">' +
      '<div class="summary-stat"><div class="value">' + totalHrs.toFixed(1) + '</div><div class="label">Total Hours</div></div>' +
      '<div class="summary-stat"><div class="value">' + daysWorked + '</div><div class="label">Days Worked</div></div>' +
      '<div class="summary-stat"><div class="value">' + avgPerDay.toFixed(1) + '</div><div class="label">Avg Hours/Day</div></div>' +
      '<div class="summary-stat"><div class="value">' + totalEntries + '</div><div class="label">Time Entries</div></div>' +
      '</div>';
  }

  // -- Simple Canvas Bar Chart --
  function drawBarChart(canvasId, labels, values, colors) {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = (rect.width - 48) * dpr;
    canvas.height = 220 * dpr;
    canvas.style.width = (rect.width - 48) + 'px';
    canvas.style.height = '220px';
    ctx.scale(dpr, dpr);

    const w = rect.width - 48;
    const h = 220;
    const padding = { top: 10, right: 20, bottom: 40, left: 40 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';

    const maxVal = Math.max.apply(null, values.concat([1]));

    const gridLines = 4;
    ctx.strokeStyle = '#e9ecef';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#636e72';
    ctx.textAlign = 'right';

    for (let i = 0; i <= gridLines; i++) {
      const y = padding.top + chartH - (chartH / gridLines) * i;
      const val = (maxVal / gridLines * i).toFixed(1);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
      ctx.fillText(val, padding.left - 6, y + 4);
    }

    const barCount = labels.length || 1;
    const gap = 8;
    const barW = Math.min(40, (chartW - gap * (barCount + 1)) / barCount);
    const totalBarsWidth = barCount * barW + (barCount - 1) * gap;
    const startX = padding.left + (chartW - totalBarsWidth) / 2;

    labels.forEach(function(label, i) {
      const barH = (values[i] / maxVal) * chartH;
      const x = startX + i * (barW + gap);
      const y = padding.top + chartH - barH;

      const color = Array.isArray(colors) ? colors[i] : colors;
      ctx.fillStyle = color;
      ctx.beginPath();
      roundRect(ctx, x, y, barW, barH, 4);
      ctx.fill();

      if (values[i] > 0) {
        ctx.fillStyle = '#2d3436';
        ctx.textAlign = 'center';
        ctx.fillText(values[i].toFixed(1), x + barW / 2, y - 6);
      }

      ctx.fillStyle = '#636e72';
      ctx.textAlign = 'center';
      ctx.fillText(label, x + barW / 2, h - padding.bottom + 16);
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (h < 1) return;
    r = Math.min(r, h / 2, w / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // -- Projects View --
  const addProjectBtn = document.getElementById('addProjectBtn');
  const projectForm = document.getElementById('projectForm');
  const projectNameInput = document.getElementById('projectName');
  let selectedColor = '#4c6ef5';

  addProjectBtn.addEventListener('click', function() {
    projectForm.classList.remove('hidden');
    projectNameInput.focus();
  });

  document.querySelectorAll('.color-dot').forEach(function(dot) {
    dot.addEventListener('click', function() {
      document.querySelectorAll('.color-dot').forEach(function(d) { d.classList.remove('selected'); });
      dot.classList.add('selected');
      selectedColor = dot.dataset.color;
    });
  });

  document.getElementById('saveProject').addEventListener('click', async function() {
    const name = projectNameInput.value.trim();
    if (!name) return;

    try {
      const saved = await api('projects', { method: 'POST', body: { name: name, color: selectedColor } });
      projects.push(saved);
    } catch (err) {
      console.error('Failed to save project:', err);
      projects.push({ id: genId(), name: name, color: selectedColor });
    }

    projectNameInput.value = '';
    projectForm.classList.add('hidden');
    renderProjects();
    populateProjectSelects();
  });

  document.getElementById('cancelProject').addEventListener('click', function() {
    projectNameInput.value = '';
    projectForm.classList.add('hidden');
  });

  function renderProjects() {
    const list = document.getElementById('projectsList');
    list.innerHTML = projects.map(function(p) {
      const totalMs = entries.filter(function(e) { return e.projectId === p.id; }).reduce(function(s, e) { return s + e.duration; }, 0);
      return '<div class="project-card">' +
        '<div class="project-color-bar" style="background:' + p.color + '"></div>' +
        '<div class="project-info"><h4>' + escapeHtml(p.name) + '</h4><span>' + formatDuration(totalMs) + ' total tracked</span></div>' +
        '<button class="delete-project" data-id="' + p.id + '">Delete</button></div>';
    }).join('');

    list.querySelectorAll('.delete-project').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (confirm('Delete this project? Time entries will keep their data.')) {
          try {
            await api('projects/' + id, { method: 'DELETE' });
          } catch (err) {
            console.error('Failed to delete project:', err);
          }
          projects = projects.filter(function(p) { return p.id !== id; });
          renderProjects();
          populateProjectSelects();
        }
      });
    });
  }

  // -- Populate project selects --
  function populateProjectSelect(select, selectedId) {
    selectedId = selectedId || '';
    select.innerHTML = '<option value="">\u2014 Project \u2014</option>' +
      projects.map(function(p) { return '<option value="' + p.id + '"' + (p.id === selectedId ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>'; }).join('');
  }

  function populateProjectSelects() {
    populateProjectSelect(projectSelect, projectSelect.value);
  }

  // -- Export CSV --
  document.getElementById('exportBtn').addEventListener('click', function() {
    if (entries.length === 0) { alert('No entries to export.'); return; }

    const rows = [['Date', 'Description', 'Project', 'Start', 'End', 'Duration (hours)']];
    entries.sort(function(a, b) { return new Date(a.start) - new Date(b.start); }).forEach(function(e) {
      const project = projects.find(function(p) { return p.id === e.projectId; });
      rows.push([
        e.date,
        '"' + e.desc.replace(/"/g, '""') + '"',
        project ? '"' + project.name.replace(/"/g, '""') + '"' : '',
        formatTime(e.start),
        formatTime(e.end),
        (e.duration / 3600000).toFixed(2)
      ]);
    });

    const csv = rows.map(function(r) { return r.join(','); }).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'timetracker-export-' + dateKey(new Date()) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  // -- Keyboard shortcut --
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      timerToggle.click();
    }
  });

})();
