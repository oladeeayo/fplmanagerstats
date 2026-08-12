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
  function formatMs(ms) { return ms == null ? '--' : ms + 'ms'; }
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
      legend: { position: 'right', labels: { color: '#8ba396', font: { family: "'JetBrains Mono'", size: 11 }, padding: 12, usePointStyle: true, pointStyleWidth: 8 } },
      tooltip: { backgroundColor: '#1a2e28', titleColor: '#fff', bodyColor: '#ccc', borderColor: '#1A2E28', borderWidth: 1, padding: 10, titleFont: { family: "'JetBrains Mono'" }, bodyFont: { family: "'JetBrains Mono'" } }
    }
  };

  const COLORS = ['#00ff85', '#37db59', '#ffa600', '#ff4d4d', '#6496ff', '#c084fc', '#f472b6', '#34d399', '#fbbf24', '#60a5fa'];

  async function api(path) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${path}${sep}key=${adminKey}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }

  function renderChart(canvasId, type, data, options = {}) {
    if (charts[canvasId]) charts[canvasId].destroy();
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    charts[canvasId] = new Chart(ctx, { type, data, options: { ...chartDefaults, ...options } });
  }

  async function loadStats() {
    const d = await api('/api/admin/stats');
    document.getElementById('pv-today').textContent = formatNum(d.pageViews.today);
    document.getElementById('pv-week').textContent = formatNum(d.pageViews.week) + ' this week';
    document.getElementById('uv-today').textContent = formatNum(d.uniqueVisitors.today);
    document.getElementById('uv-week').textContent = formatNum(d.uniqueVisitors.week) + ' this week';
    document.getElementById('uv-all').textContent = formatNum(d.uniqueVisitors.allTime);
    document.getElementById('pv-all').textContent = formatNum(d.pageViews.allTime) + ' total page views';
    document.getElementById('avg-response').textContent = d.avgResponseTimeMs ? d.avgResponseTimeMs + 'ms' : '--';

    const tbody = document.getElementById('visitors-body');
    if (d.recentVisitors.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#8ba396;padding:24px;">No visitors yet</td></tr>';
    } else {
      tbody.innerHTML = d.recentVisitors.map(v => `<tr>
        <td style="color:#8ba396">${timeAgo(v.created_at)}</td>
        <td><div class="country-cell"><span class="country-flag">${getFlag(v.country)}</span><span class="country-code">${v.country || 'XX'}</span></div></td>
        <td><span class="badge badge-${(v.device_type || '').toLowerCase()}">${v.device_type || '?'}</span></td>
        <td>${v.browser || '?'}</td>
        <td>${v.os || '?'}</td>
        <td style="color:#8ba396;max-width:200px;overflow:hidden;text-overflow:ellipsis;">${v.path || '/'}</td>
      </tr>`).join('');
    }
  }

  async function loadCountries() {
    const d = await api(`/api/admin/countries?days=${currentPeriod}`);
    if (d.countries.length === 0) {
      renderChart('chart-countries', 'doughnut', { labels: ['No data'], datasets: [{ data: [1], backgroundColor: ['#1A2E28'] }] });
      return;
    }
    const labels = d.countries.slice(0, 10).map(c => `${getFlag(c.country)} ${c.country}`);
    const values = d.countries.slice(0, 10).map(c => parseInt(c.views));
    renderChart('chart-countries', 'doughnut', {
      labels,
      datasets: [{ data: values, backgroundColor: COLORS.slice(0, values.length), borderWidth: 0 }]
    }, { plugins: { ...chartDefaults.plugins, legend: { ...chartDefaults.plugins.legend, position: 'right' } } });
  }

  async function loadDevices() {
    const d = await api(`/api/admin/devices?days=${currentPeriod}`);

    // Device type pie
    const devLabels = d.devices.map(x => x.device_type);
    const devValues = d.devices.map(x => parseInt(x.count));
    renderChart('chart-devices', 'doughnut', {
      labels: devLabels,
      datasets: [{ data: devValues, backgroundColor: ['#00ff85', '#ffa600', '#6496ff'], borderWidth: 0 }]
    });

    // Browser pie
    const brLabels = d.browsers.slice(0, 8).map(x => x.browser);
    const brValues = d.browsers.slice(0, 8).map(x => parseInt(x.count));
    renderChart('chart-browsers', 'doughnut', {
      labels: brLabels,
      datasets: [{ data: brValues, backgroundColor: COLORS.slice(0, brValues.length), borderWidth: 0 }]
    });

    // OS pie
    const osLabels = d.osList.slice(0, 8).map(x => x.os);
    const osValues = d.osList.slice(0, 8).map(x => parseInt(x.count));
    renderChart('chart-os', 'doughnut', {
      labels: osLabels,
      datasets: [{ data: osValues, backgroundColor: COLORS.slice(0, osValues.length), borderWidth: 0 }]
    });
  }

  async function loadHourly() {
    const d = await api(`/api/admin/hourly?days=${currentPeriod}`);

    // Hourly bar chart
    const hourData = new Array(24).fill(0);
    d.hourly.forEach(h => { hourData[h.hour] = parseInt(h.views); });
    const hourLabels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    renderChart('chart-hourly', 'bar', {
      labels: hourLabels,
      datasets: [{ label: 'Page Views', data: hourData, backgroundColor: '#00ff8533', borderColor: '#00ff85', borderWidth: 1, borderRadius: 4 }]
    }, {
      plugins: { ...chartDefaults.plugins, legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8ba396', font: { family: "'JetBrains Mono'", size: 10 }, maxRotation: 0 }, grid: { color: '#1A2E2811' } },
        y: { ticks: { color: '#8ba396', font: { family: "'JetBrains Mono'", size: 10 } }, grid: { color: '#1A2E2833' } }
      }
    });

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
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#8ba396;padding:24px;">No referrer data</td></tr>';
      return;
    }
    tbody.innerHTML = d.referrers.map(r => {
      const pct = total > 0 ? ((parseInt(r.views) / total) * 100).toFixed(1) : '0';
      const icons = { Direct: 'link', Google: 'search', Facebook: 'facebook', Twitter: 'tag', Reddit: 'forum', Instagram: 'photo_camera', YouTube: 'play_circle', Internal: 'home' };
      return `<tr>
        <td><span class="material-symbols-outlined" style="font-size:16px;color:#00ff85;margin-right:8px;">${icons[r.source] || 'language'}</span>${r.source}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(r.views))}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(r.unique_visitors))}</td>
        <td style="font-family:'JetBrains Mono',monospace;color:#00ff85;">${pct}%</td>
      </tr>`;
    }).join('');
  }

  async function loadFeatures() {
    const d = await api(`/api/admin/feature-usage?days=${currentPeriod}`);
    const total = d.features.reduce((s, f) => s + parseInt(f.hits), 0);
    const tbody = document.getElementById('features-body');
    if (d.features.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#8ba396;padding:24px;">No feature data</td></tr>';
      return;
    }
    tbody.innerHTML = d.features.map(f => {
      const pct = total > 0 ? ((parseInt(f.hits) / total) * 100).toFixed(1) : '0';
      return `<tr>
        <td style="font-weight:600;">${f.feature}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(f.hits))}</td>
        <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(f.unique_users))}</td>
        <td style="font-family:'JetBrains Mono',monospace;color:#00ff85;">${pct}%</td>
        <td style="font-family:'JetBrains Mono',monospace;">--</td>
      </tr>`;
    }).join('');
  }

  async function loadPages() {
    const d = await api(`/api/admin/pages?days=${currentPeriod}`);
    const tbody = document.getElementById('pages-body');
    if (d.pages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#8ba396;padding:24px;">No page data</td></tr>';
      return;
    }
    tbody.innerHTML = d.pages.slice(0, 30).map(p => `<tr>
      <td style="font-family:'JetBrains Mono',monospace;max-width:350px;overflow:hidden;text-overflow:ellipsis;" title="${p.path}">${p.path}</td>
      <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(p.views))}</td>
      <td style="font-family:'JetBrains Mono',monospace;">${formatNum(parseInt(p.unique_visitors))}</td>
      <td style="font-family:'JetBrains Mono',monospace;">${p.avg_response_ms || '--'}ms</td>
    </tr>`).join('');
  }

  async function loadVisitors() {
    const d = await api(`/api/admin/visitors?days=${currentPeriod}&page=${visitorsPage}&limit=50`);
    const tbody = document.getElementById('visitors-body');
    if (d.visitors.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#8ba396;padding:24px;">No visitors yet</td></tr>';
      document.getElementById('visitors-pagination').innerHTML = '';
      return;
    }
    tbody.innerHTML = d.visitors.map(v => `<tr>
      <td style="color:#8ba396">${timeAgo(v.created_at)}</td>
      <td><div class="country-cell"><span class="country-flag">${getFlag(v.country)}</span><span class="country-code">${v.country || 'XX'}</span><span style="color:#5a7a66;font-size:11px;">${v.city || ''}</span></div></td>
      <td><span class="badge badge-${(v.device_type || '').toLowerCase()}">${v.device_type || '?'}</span></td>
      <td>${v.browser || '?'}</td>
      <td>${v.os || '?'}</td>
      <td style="color:#8ba396;">${v.page_count} page${v.page_count !== 1 ? 's' : ''}</td>
    </tr>`).join('');

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
        loadStats(), loadCountries(), loadDevices(), loadHourly(),
        loadReferrers(), loadFeatures(), loadPages(), loadVisitors()
      ]);
    } catch (e) {
      console.error('Dashboard load error:', e);
    }
  }

  function login() {
    const input = document.getElementById('admin-key-input');
    adminKey = input.value.trim();
    if (!adminKey) return;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    loadAll();
  }

  function logout() {
    adminKey = '';
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

  // Enter key login
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') login();
  });

  return { login, logout, setPeriod, goPage };
})();
