// FPL Goals Projections Tab Renderers
// These functions are injected into the FPL object in common.js

async function renderGoalsScoredProjections() {
    const container = document.getElementById('fixture-goals-container');
    if (!container) return;

    const currentGW = this.state.bootstrapData?.events?.find(e => e.is_current)?.id ||
                      this.state.bootstrapData?.events?.find(e => e.is_next)?.id || 1;
    const horizon = this.state.fixtureGoalsHorizon || 6;

    const select = document.getElementById('fixture-goals-horizon-select');
    if (select && select.options.length === 0) {
        [3, 5, 6, 8, 10].forEach(function(h) {
            var opt = document.createElement('option');
            opt.value = h;
            opt.textContent = h + ' GWs';
            select.appendChild(opt);
        });
    }
    if (select) select.value = horizon;

    container.innerHTML = '<div style="padding:32px 16px;text-align:center;color:#b9cbb9;font-family:var(--font-mono);"><span class="material-symbols-outlined" style="font-size:36px;animation:spin 1s linear infinite;">sync</span><p style="margin-top:8px;">Calculating goals scored projections (' + horizon + ' GW horizon)...</p></div>';

    var self = this;
    var data = null;
    try {
        data = await this.apiFetch(this.API.goalsProjections(currentGW, horizon));
    } catch (e) {
        console.error('Goals projections API error:', e);
        container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>Failed to load goals projections.</p></div>';
        return;
    }

    if (!data || !data.ranked || data.ranked.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">event_busy</span><p>No goals projection data available.</p></div>';
        return;
    }

    var gwList = [];
    for (var i = 0; i < Math.min(horizon, 15); i++) gwList.push(data.startGW + i);
    var topTeams = data.ranked.slice(0, 10);
    var bottomTeams = data.ranked.slice(-10).reverse();

    var html = '<div class="solio-container">' +
        '<div class="solio-header"><div class="solio-title-wrap">' +
        '<h2 class="solio-title">Goals Scored Projections <span class="solio-gw-badge">' + horizon + ' GWs from GW' + data.startGW + '</span></h2>' +
        '<p class="solio-subtitle">Poisson/Dixon-Coles model · ' + horizon + ' gameweek horizon · ' + data.modelVersion + '</p>' +
        '</div></div>' +

        '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));gap:16px;margin-bottom:24px;">' +
        '<div style="background:#121824;border:1px solid #1e2738;border-radius:12px;padding:16px;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;"><span class="material-symbols-outlined" style="color:#4caf50;font-size:20px;">sports_soccer</span><span style="font-family:var(--font-mono);font-size:12px;font-weight:800;color:#94a3b8;">TOP ATTACKING TEAMS</span></div>' +
        topTeams.slice(0, 5).map(function(t, idx) {
            var medal = idx === 0 ? '#FFD700' : idx === 1 ? '#C0C0C0' : '#CD7F32';
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#172030;border-radius:6px;border:1px solid #233047;margin-bottom:4px;">' +
                '<div style="display:flex;align-items:center;gap:8px;"><span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:' + medal + ';">#' + (idx + 1) + '</span>' + self.teamBadge(t.team, 16) + '<span style="font-family:var(--font-mono);font-weight:700;font-size:13px;color:#fff;">' + self.escapeHTML(t.team) + '</span></div>' +
                '<span style="font-family:var(--font-mono);font-weight:900;font-size:13px;color:#4caf50;background:rgba(76,175,80,0.15);padding:3px 8px;border-radius:5px;">' + t.totalXG.toFixed(1) + ' xG</span></div>';
        }).join('') +
        '</div>' +
        '<div style="background:#121824;border:1px solid #1e2738;border-radius:12px;padding:16px;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;"><span class="material-symbols-outlined" style="color:#ff5722;font-size:20px;">trending_down</span><span style="font-family:var(--font-mono);font-size:12px;font-weight:800;color:#94a3b8;">WEAKEST ATTACKS</span></div>' +
        bottomTeams.slice(0, 5).map(function(t, idx) {
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#172030;border-radius:6px;border:1px solid #233047;margin-bottom:4px;">' +
                '<div style="display:flex;align-items:center;gap:8px;"><span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:#ef5350;">#' + (20 - idx) + '</span>' + self.teamBadge(t.team, 16) + '<span style="font-family:var(--font-mono);font-weight:700;font-size:13px;color:#fff;">' + self.escapeHTML(t.team) + '</span></div>' +
                '<span style="font-family:var(--font-mono);font-weight:900;font-size:13px;color:#ff5722;background:rgba(255,87,34,0.15);padding:3px 8px;border-radius:5px;">' + t.totalXG.toFixed(1) + ' xG</span></div>';
        }).join('') +
        '</div></div>' +

        '<div style="background:#1c211e;border:1px solid #1A2E28;border-radius:12px;overflow:hidden;margin-bottom:24px;">' +
        '<div style="background:#a7cfbc;padding:14px 16px;border-bottom:1px solid #1A2E28;display:flex;align-items:center;gap:8px;"><span class="material-symbols-outlined" style="font-size:18px;color:#0a0f0d;">sports_soccer</span><h3 style="font-family:var(--font-mono);font-size:13px;margin:0;color:#0a0f0d;">ALL TEAMS — EXPECTED GOALS (' + horizon + ' GWs)</h3></div>' +
        '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:12px;"><thead><tr style="border-bottom:1px solid #34453b;background:#202722;">' +
        '<th style="padding:8px 12px;text-align:left;color:#dfe4e0;font-weight:700;">#</th>' +
        '<th style="padding:8px 12px;text-align:left;color:#dfe4e0;font-weight:700;">Team</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#4caf50;font-weight:700;">Total xG</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#4caf50;font-weight:700;">Avg xG/GW</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#94a3b8;font-weight:700;">FDR (3GW)</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#94a3b8;font-weight:700;">FDR (5GW)</th>' +
        gwList.map(function(gw) { return '<th style="padding:8px 12px;text-align:center;color:#dfe4e0;font-weight:700;min-width:60px;">GW' + gw + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        data.ranked.map(function(team, idx) {
            var isEven = idx % 2 === 1;
            var cells = gwList.map(function(gw) {
                var gwData = team.gameweeks.find(function(g) { return g.gw === gw; });
                if (!gwData) return '<td style="padding:8px 12px;text-align:center;color:#4a5568;">—</td>';
                var barWidth = Math.min(100, Math.max(15, Math.round((gwData.xg / 3.0) * 100)));
                return '<td style="padding:6px 8px;text-align:center;"><div style="display:flex;flex-direction:column;align-items:center;gap:2px;">' +
                    '<span style="font-weight:700;color:#4caf50;font-size:11px;">' + gwData.xg.toFixed(2) + '</span>' +
                    '<div style="width:100%;height:4px;background:#1a2233;border-radius:2px;overflow:hidden;"><div style="width:' + barWidth + '%;height:100%;background:#4caf50;border-radius:2px;"></div></div>' +
                    '<span style="font-size:9px;color:#64748b;">' + (gwData.isHome ? 'H' : 'A') + ' ' + self.escapeHTML(gwData.opponent) + '</span></div></td>';
            }).join('');
            return '<tr style="border-bottom:1px solid #1A2E28;background:' + (isEven ? '#181d1a' : '#0f1412') + ';">' +
                '<td style="padding:8px 12px;color:#94a3b8;font-weight:700;">' + (idx + 1) + '</td>' +
                '<td style="padding:8px 12px;"><div style="display:flex;align-items:center;gap:8px;">' + self.teamBadge(team.team, 18) + '<span style="font-weight:700;color:#fff;">' + self.escapeHTML(team.team) + '</span></div></td>' +
                '<td style="padding:8px 12px;text-align:center;font-weight:900;color:#4caf50;">' + team.totalXG.toFixed(1) + '</td>' +
                '<td style="padding:8px 12px;text-align:center;font-weight:700;color:#81c784;">' + team.avgXG.toFixed(2) + '</td>' +
                '<td style="padding:8px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:20px;border-radius:4px;font-size:11px;font-weight:700;background:var(--fdr-' + Math.round(team.fdr3gw) + ');color:white;">' + team.fdr3gw.toFixed(1) + '</span></td>' +
                '<td style="padding:8px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:20px;border-radius:4px;font-size:11px;font-weight:700;background:var(--fdr-' + Math.round(team.fdr5gw) + ');color:white;">' + team.fdr5gw.toFixed(1) + '</span></td>' +
                cells + '</tr>';
        }).join('') +
        '</tbody></table></div></div>' +
        '<div class="solio-footer">Expected goals calculated using Poisson distribution with Dixon-Coles tau correction, team xG/xGA ratings, and home advantage adjustments.</div>' +
        '</div>';

    container.innerHTML = html;
}

async function renderGoalsConcededProjections() {
    var container = document.getElementById('fixture-conceded-container');
    if (!container) return;

    var currentGW = this.state.bootstrapData?.events?.find(function(e) { return e.is_current; })?.id ||
                    this.state.bootstrapData?.events?.find(function(e) { return e.is_next; })?.id || 1;
    var horizon = this.state.fixtureGoalsHorizon || 6;

    var select = document.getElementById('fixture-goals-horizon-select');
    if (select && select.options.length === 0) {
        [3, 5, 6, 8, 10].forEach(function(h) {
            var opt = document.createElement('option');
            opt.value = h;
            opt.textContent = h + ' GWs';
            select.appendChild(opt);
        });
    }
    if (select) select.value = horizon;

    container.innerHTML = '<div style="padding:32px 16px;text-align:center;color:#b9cbb9;font-family:var(--font-mono);"><span class="material-symbols-outlined" style="font-size:36px;animation:spin 1s linear infinite;">sync</span><p style="margin-top:8px;">Calculating goals conceded projections (' + horizon + ' GW horizon)...</p></div>';

    var self = this;
    var data = null;
    try {
        data = await this.apiFetch(this.API.goalsConceded(currentGW, horizon));
    } catch (e) {
        console.error('Goals conceded API error:', e);
        container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">error</span><p>Failed to load goals conceded projections.</p></div>';
        return;
    }

    if (!data || !data.ranked || data.ranked.length === 0) {
        container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">event_busy</span><p>No goals conceded data available.</p></div>';
        return;
    }

    var gwList = [];
    for (var i = 0; i < Math.min(horizon, 15); i++) gwList.push(data.startGW + i);
    var bestDefences = data.ranked.slice(0, 10);
    var worstDefences = data.ranked.slice(-10).reverse();

    var html = '<div class="solio-container">' +
        '<div class="solio-header"><div class="solio-title-wrap">' +
        '<h2 class="solio-title">Goals Conceded Projections <span class="solio-gw-badge">' + horizon + ' GWs from GW' + data.startGW + '</span></h2>' +
        '<p class="solio-subtitle">Poisson/Dixon-Coles model · ' + horizon + ' gameweek horizon · Fewest conceded first</p>' +
        '</div></div>' +

        '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));gap:16px;margin-bottom:24px;">' +
        '<div style="background:#121824;border:1px solid #1e2738;border-radius:12px;padding:16px;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;"><span class="material-symbols-outlined" style="color:#4caf50;font-size:20px;">shield</span><span style="font-family:var(--font-mono);font-size:12px;font-weight:800;color:#94a3b8;">BEST DEFENCES</span></div>' +
        bestDefences.slice(0, 5).map(function(t, idx) {
            var medal = idx === 0 ? '#FFD700' : idx === 1 ? '#C0C0C0' : '#CD7F32';
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#172030;border-radius:6px;border:1px solid #233047;margin-bottom:4px;">' +
                '<div style="display:flex;align-items:center;gap:8px;"><span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:' + medal + ';">#' + (idx + 1) + '</span>' + self.teamBadge(t.team, 16) + '<span style="font-family:var(--font-mono);font-weight:700;font-size:13px;color:#fff;">' + self.escapeHTML(t.team) + '</span></div>' +
                '<div style="display:flex;gap:6px;"><span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:#4caf50;background:rgba(76,175,80,0.15);padding:3px 8px;border-radius:5px;">' + t.totalXGA.toFixed(1) + ' xGA</span><span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:#ffcc80;background:rgba(255,204,128,0.1);padding:3px 8px;border-radius:5px;">' + t.totalCS.toFixed(0) + '% CS</span></div></div>';
        }).join('') +
        '</div>' +
        '<div style="background:#121824;border:1px solid #1e2738;border-radius:12px;padding:16px;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;"><span class="material-symbols-outlined" style="color:#ff5722;font-size:20px;">warning</span><span style="font-family:var(--font-mono);font-size:12px;font-weight:800;color:#94a3b8;">WORST DEFENCES</span></div>' +
        worstDefences.slice(0, 5).map(function(t, idx) {
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#172030;border-radius:6px;border:1px solid #233047;margin-bottom:4px;">' +
                '<div style="display:flex;align-items:center;gap:8px;"><span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:#ef5350;">#' + (20 - idx) + '</span>' + self.teamBadge(t.team, 16) + '<span style="font-family:var(--font-mono);font-weight:700;font-size:13px;color:#fff;">' + self.escapeHTML(t.team) + '</span></div>' +
                '<div style="display:flex;gap:6px;"><span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:#ff5722;background:rgba(255,87,34,0.15);padding:3px 8px;border-radius:5px;">' + t.totalXGA.toFixed(1) + ' xGA</span><span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:#ef9a9a;background:rgba(239,83,80,0.1);padding:3px 8px;border-radius:5px;">' + t.totalCS.toFixed(0) + '% CS</span></div></div>';
        }).join('') +
        '</div></div>' +

        '<div style="background:#1c211e;border:1px solid #1A2E28;border-radius:12px;overflow:hidden;margin-bottom:24px;">' +
        '<div style="background:#a7cfbc;padding:14px 16px;border-bottom:1px solid #1A2E28;display:flex;align-items:center;gap:8px;"><span class="material-symbols-outlined" style="font-size:18px;color:#0a0f0d;">shield</span><h3 style="font-family:var(--font-mono);font-size:13px;margin:0;color:#0a0f0d;">ALL TEAMS — EXPECTED GOALS CONCEDED (' + horizon + ' GWs)</h3></div>' +
        '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:12px;"><thead><tr style="border-bottom:1px solid #34453b;background:#202722;">' +
        '<th style="padding:8px 12px;text-align:left;color:#dfe4e0;font-weight:700;">#</th>' +
        '<th style="padding:8px 12px;text-align:left;color:#dfe4e0;font-weight:700;">Team</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#ff5722;font-weight:700;">Total xGA</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#ff5722;font-weight:700;">Avg xGA/GW</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#ffcc80;font-weight:700;">Total CS%</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#94a3b8;font-weight:700;">FDR (3GW)</th>' +
        '<th style="padding:8px 12px;text-align:center;color:#94a3b8;font-weight:700;">FDR (5GW)</th>' +
        gwList.map(function(gw) { return '<th style="padding:8px 12px;text-align:center;color:#dfe4e0;font-weight:700;min-width:70px;">GW' + gw + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        data.ranked.map(function(team, idx) {
            var isEven = idx % 2 === 1;
            var cells = gwList.map(function(gw) {
                var gwData = team.gameweeks.find(function(g) { return g.gw === gw; });
                if (!gwData) return '<td style="padding:8px 12px;text-align:center;color:#4a5568;">—</td>';
                var barWidth = Math.min(100, Math.max(15, Math.round((gwData.xga / 3.0) * 100)));
                var csColor = gwData.csPct >= 35 ? '#4caf50' : gwData.csPct >= 20 ? '#ffcc80' : '#ef5350';
                return '<td style="padding:6px 8px;text-align:center;"><div style="display:flex;flex-direction:column;align-items:center;gap:2px;">' +
                    '<span style="font-weight:700;color:#ff5722;font-size:11px;">' + gwData.xga.toFixed(2) + '</span>' +
                    '<div style="width:100%;height:4px;background:#1a2233;border-radius:2px;overflow:hidden;"><div style="width:' + barWidth + '%;height:100%;background:#ff5722;border-radius:2px;"></div></div>' +
                    '<span style="font-size:9px;color:' + csColor + ';">' + gwData.csPct + '% CS · ' + (gwData.isHome ? 'H' : 'A') + ' ' + self.escapeHTML(gwData.opponent) + '</span></div></td>';
            }).join('');
            return '<tr style="border-bottom:1px solid #1A2E28;background:' + (isEven ? '#181d1a' : '#0f1412') + ';">' +
                '<td style="padding:8px 12px;color:#94a3b8;font-weight:700;">' + (idx + 1) + '</td>' +
                '<td style="padding:8px 12px;"><div style="display:flex;align-items:center;gap:8px;">' + self.teamBadge(team.team, 18) + '<span style="font-weight:700;color:#fff;">' + self.escapeHTML(team.team) + '</span></div></td>' +
                '<td style="padding:8px 12px;text-align:center;font-weight:900;color:#ff5722;">' + team.totalXGA.toFixed(1) + '</td>' +
                '<td style="padding:8px 12px;text-align:center;font-weight:700;color:#ff8a65;">' + team.avgXGA.toFixed(2) + '</td>' +
                '<td style="padding:8px 12px;text-align:center;font-weight:700;color:#ffcc80;">' + team.totalCS.toFixed(0) + '%</td>' +
                '<td style="padding:8px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:20px;border-radius:4px;font-size:11px;font-weight:700;background:var(--fdr-' + Math.round(team.fdr3gw) + ');color:white;">' + team.fdr3gw.toFixed(1) + '</span></td>' +
                '<td style="padding:8px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:20px;border-radius:4px;font-size:11px;font-weight:700;background:var(--fdr-' + Math.round(team.fdr5gw) + ');color:white;">' + team.fdr5gw.toFixed(1) + '</span></td>' +
                cells + '</tr>';
        }).join('') +
        '</tbody></table></div></div>' +
        '<div class="solio-footer">Goals conceded calculated using Poisson distribution with Dixon-Coles tau correction, team defensive ratings, and opponent attacking strength.</div>' +
        '</div>';

    container.innerHTML = html;
}
