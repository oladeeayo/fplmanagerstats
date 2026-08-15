const Admin = (() => {
  let adminKey = '';
  let currentPeriod = 7;
  let visitorsPage = 1;
  let charts = {};

  const COUNTRY_FLAGS = {
    GB: '\u{1F1EC}\u{1F1E7}', US: '\u{1F1FA}\u{1F1F8}', IN: '\u{1F1EE}\u{1F1F3}', DE: '\u{1F1E9}\u{1F1EA}',
    FR: '\u{1F1EB}\u{1F1F7}', ES: '\u{1F1EA}\u{1F1F8}', IT: '\u{1F1EE}\u{1F1F9}', BR: '\u{1F1E7}\u{1F1F7}',
    CA: '\u{1F1E8}\u{1F1E6}', AU: '\u{1F1E6}\u{1F1FA}', NL: '\u{1F1F3}\u{1F1F1}', JP: '\u{1F1EF}\u{1F1F5}',
    PT: '\u{1F1F5}\u{1F1F9}', IE: '\u{1F1EE}\u{1F1EA}', SG: '\u{1F1F8}\u{1F1EC}', MY: '\u{1F1F2}\u{1F1FE}',
    NZ: '\u{1F1F3}\u{1F1FF}', ZA: '\u{1F1FF}\u{1F1E6}', NG: '\u{1F1F3}\u{1F1EC}', KE: '\u{1F1F0}\u{1F1EA}',
    Local: '\u{1F3E0}'
  };

  function getFlag(code) { return COUNTRY_FLAGS[code] || '\u{1F30D}'; }
  function formatNum(n) { return n == null ? '--' : n.toLocaleString(); }
  function timeAgo(date) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right', labels: { color: '#8ba396', font: { family: "'JetBrains Mono'", size: 10 }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } },
      tooltip: { backgroundColor: '#1a2e28', titleColor: '#fff', bodyColor: '#ccc', borderColor: '#1A2E28', borderWidth: 1, padding: 8, titleFont: { family: "'JetBrains Mono'" }, bodyFont: { family: "'JetBrains Mono'" } }
    }
  };

  const COLORS = ['#00ff85', '#37db59', '#ffa600', '#ff4d4d', '#6496ff', '#c084fc', '#f472b6', '#34d399', '#fbbf24', '#60a5fa'];

  async function api(path) {
    const res = await fetch(path, { headers: adminKey ? { 'x-admin-key': adminKey } : {} });
    if (!res.ok) {
      let message = `API error: ${res.status}`;
      try { const body = await res.json(); if (body.error) message = body.error; } catch (_) {}
      throw new Error(message);
    }
    return res.json();
  }

  function renderChart(canvasId, type, data, options = {}) {
    if (charts[canvasId]) charts[canvasId].destroy();
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    charts[canvasId] = new Chart(ctx, { type, data, options: { ...chartDefaults, ...options } });
  }

  function renderList(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items.length) { el.innerHTML = '<div class="device-item"><span style="color:#5a7a66">No data</span></div>'; return; }
    el.innerHTML = items.map(i => `<div class="device-item"><span>${i.label}</span><span>${formatNum(parseInt(i.count))}</span></div>`).join('');
  }

  async function loadStats() {
    const d = await api('/api/admin/stats');
    document.getElementById('pv-today').textContent = formatNum(d.pageViews.today);
    document.getElementById('pv-week').textContent = formatNum(d.pageViews.week) + ' this week';
    document.getElementById('uv-today').textContent = formatNum(d.uniqueVisitors.today);
    document.getElementById('uv-week').textContent = formatNum(d.uniqueVisitors.week) + ' this week';
    document.getElementById('uv-all').textContent = formatNum(d.uniqueVisitors.allTime);
    document.getElementById('pv-all').textContent = formatNum(d.pageViews.allTime) + ' page views';
    document.getElementById('avg-response').textContent = d.avgResponseTimeMs ? d.avgResponseTimeMs + 'ms' : '--';

    // Recent visitors with referrer
    const tbody = document.getElementById('visitors-body');
    if (d.recentVisitors.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#8ba396;padding:20px;">No visitors yet</td></tr>';
    } else {
      tbody.innerHTML = d.recentVisitors.map(v => {
        const refDisplay = v.referrer ? (() => { try { return new URL(v.referrer).hostname.replace('www.', ''); } catch(e) { return 'Direct'; } })() : 'Direct';
        return `<tr>
          <td style="color:#8ba396">${timeAgo(v.created_at)}</td>
          <td><div class="country-cell"><span class="country-flag">${getFlag(v.country)}</span>${v.country || 'XX'}</div></td>
          <td><span class="badge badge-${(v.device_type || '').toLowerCase()}">${v.device_type || '?'}</span></td>
          <td>${v.browser || '?'}</td>
          <td style="text-align:center;">1x</td>
          <td style="text-align:center;color:#00ff85;">1d</td>
          <td style="color:#5a7a66;max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="${v.referrer || ''}">${refDisplay}</td>
        </tr>`;
      }).join('');
    }
  }

  async function loadCountries() {
    const d = await api(`/api/admin/countries?days=${currentPeriod}`);
    if (d.countries.length === 0) {
      renderChart('chart-countries', 'doughnut', { labels: ['No data'], datasets: [{ data: [1], backgroundColor: ['#1A2E28'] }] });
      return;
    }
    const labels = d.countries.slice(0, 8).map(c => `${getFlag(c.country)} ${c.country}`);
    const values = d.countries.slice(0, 8).map(c => parseInt(c.views));
    renderChart('chart-countries', 'doughnut', {
      labels,
      datasets: [{ data: values, backgroundColor: COLORS.slice(0, values.length), borderWidth: 0 }]
    });
  }

  async function loadDevices() {
    const d = await api(`/api/admin/devices?days=${currentPeriod}`);

    // Device type chart
    const devLabels = d.devices.map(x => x.device_type);
    const devValues = d.devices.map(x => parseInt(x.count));
    renderChart('chart-devices', 'doughnut', {
      labels: devLabels,
      datasets: [{ data: devValues, backgroundColor: ['#00ff85', '#ffa600', '#6496ff'], borderWidth: 0 }]
    });

    // Device details lists
    renderList('device-type-list', d.devices.map(x => ({ label: x.device_type, count: x.count })));
    renderList('browser-list', d.browsers.slice(0, 6).map(x => ({ label: x.browser, count: x.count })));
    renderList('os-list', d.osList.slice(0, 6).map(x => ({ label: x.os, count: x.count })));
  }

  async function loadDaily() {
    const d = await api(`/api/admin/hourly?days=${currentPeriod}`);

    // Daily line chart
    const dayLabels = d.daily.map(x => new Date(x.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));
    const dayViews = d.daily.map(x => parseInt(x.views));
    const dayUV = d.daily.map(x => parseInt(x.unique_visitors));
    renderChart('chart-daily', 'line', {
      labels: dayLabels,
      datasets: [
        { label: 'Page Views', data: dayViews, borderColor: '#00ff85', backgroundColor: '#00ff8511', fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#00ff85' },
        { label: 'Unique Visitors', data: dayUV, borderColor: '#ffa600', backgroundColor: '#ffa60011', fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#ffa600' }
      ]
    }, {
      scales: {
        x: { ticks: { color: '#8ba396', font: { family: "'JetBrains Mono'", size: 10 } }, grid: { color: '#1A2E2811' } },
        y: { ticks: { color: '#8ba396', font: { family: "'JetBrains Mono'", size: 10 } }, grid: { color: '#1A2E2833' } }
      }
    });
  }

  async function loadReferrers() {
    const d = await api(`/api/admin/referrers?days=${currentPeriod}`);
    const total = d.referrers.reduce((s, r) => s + parseInt(r.views), 0);
    const tbody = document.getElementById('referrers-body');
    if (d.referrers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#8ba396;padding:20px;">No referrer data</td></tr>';
      return;
    }
    const icons = { Direct: 'link', Google: 'search', Facebook: 'facebook', Twitter: 'tag', Reddit: 'forum', Instagram: 'photo_camera', YouTube: 'play_circle', Internal: 'home' };
    tbody.innerHTML = d.referrers.map(r => {
      const pct = total > 0 ? ((parseInt(r.views) / total) * 100).toFixed(1) : '0';
      return `<tr>
        <td><span class="material-symbols-outlined" style="font-size:14px;color:#00ff85;margin-right:6px;">${icons[r.source] || 'language'}</span>${r.source}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(r.views))}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(r.unique_visitors))}</td>
        <td style="font-family:'JetBrains Mono',monospace;color:#00ff85;">${pct}%</td>
      </tr>`;
    }).join('');
  }

  async function loadPages() {
    const d = await api(`/api/admin/pages?days=${currentPeriod}`);
    const tbody = document.getElementById('pages-body');
    if (d.pages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#8ba396;padding:20px;">No page data</td></tr>';
      return;
    }
    tbody.innerHTML = d.pages.slice(0, 20).map(p => `<tr>
      <td style="font-family:'JetBrains Mono',monospace;max-width:300px;overflow:hidden;text-overflow:ellipsis;" title="${p.path}">${p.path}</td>
      <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(p.views))}</td>
      <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(p.unique_visitors))}</td>
      <td style="font-family:'JetBrains Mono',monospace;">${p.avg_response_ms || '--'}ms</td>
    </tr>`).join('');
  }

  async function loadVisitors() {
    const d = await api(`/api/admin/visitors?days=${currentPeriod}&page=${visitorsPage}&limit=50`);
    const tbody = document.getElementById('visitors-body');
    if (d.visitors.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#8ba396;padding:20px;">No visitors yet</td></tr>';
      document.getElementById('visitors-pagination').innerHTML = '';
      return;
    }
    tbody.innerHTML = d.visitors.map(v => {
      const refDisplay = v.last_referrer ? (() => { try { return new URL(v.last_referrer).hostname.replace('www.', ''); } catch(e) { return 'Direct'; } })() : 'Direct';
      const visitBadge = v.visit_count > 1 ? `<span style="color:#ffa600;font-weight:700;">${v.visit_count}x</span>` : '1x';
      return `<tr>
        <td style="color:#8ba396">${timeAgo(v.last_active_at || v.created_at)}</td>
        <td><div class="country-cell"><span class="country-flag">${getFlag(v.country)}</span>${v.country || 'XX'}</div></td>
        <td><span class="badge badge-${(v.device_type || '').toLowerCase()}">${v.device_type || '?'}</span></td>
        <td>${v.browser || '?'}</td>
        <td style="text-align:center;">${visitBadge}</td>
        <td style="text-align:center;color:#00ff85;">${v.unique_visit_days || 1}d</td>
        <td style="color:#5a7a66;max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="${v.last_referrer || ''}">${refDisplay}</td>
      </tr>`;
    }).join('');

    const pag = document.getElementById('visitors-pagination');
    if (d.totalPages <= 1) { pag.innerHTML = ''; return; }
    let btns = '';
    for (let i = 1; i <= Math.min(d.totalPages, 10); i++) {
      btns += `<button class="page-btn ${i === d.page ? 'active' : ''}" onclick="Admin.goPage(${i})">${i}</button>`;
    }
    pag.innerHTML = btns;
  }

  async function loadAll() {
    try {
      await Promise.all([
        loadStats(), loadCountries(), loadDevices(), loadDaily(),
        loadReferrers(), loadPages(), loadVisitors()
      ]);
    } catch (e) {
      console.error('Dashboard load error:', e);
      const error = document.getElementById('dashboard-error');
      if (error) { error.textContent = e.message || 'Failed to load analytics'; error.style.display = 'block'; }
    }
  }

  function showDashboard() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    loadAll();
  }

  async function login() {
    const input = document.getElementById('admin-key-input');
    const key = input.value.trim();
    if (!key) return;
    adminKey = key;
    localStorage.setItem('fpl_admin_key', key);
    document.getElementById('login-error').style.display = 'none';
    showDashboard();
  }

  function logout() {
    adminKey = '';
    localStorage.removeItem('fpl_admin_key');
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('admin-key-input').value = '';
    Object.values(charts).forEach(c => c.destroy());
    charts = {};
  }

  function setPeriod(days) {
    currentPeriod = days;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.days) === days));
    loadAll();
  }

  function goPage(p) { visitorsPage = p; loadVisitors(); }

  // Auto-login if key is stored
  adminKey = localStorage.getItem('fpl_admin_key') || '';
  if (adminKey) {
    showDashboard();
  }

  // Enter key login
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') login();
  });

  return { login, logout, setPeriod, goPage };
})();
