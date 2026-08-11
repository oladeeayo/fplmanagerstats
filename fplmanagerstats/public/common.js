// FPL Manager Stats - Common JavaScript Utilities
const FPL = {
    state: {
        managerData: null,
        bootstrapData: null,
        leagueData: null,
        fixtures: null,
        zoneData: null,
        captainPicks: null,
        ownershipData: null,
        pricePredictions: null,
        differentials: null,
        currentGW: null,
        selectedGW: null,
        teamMap: {},
        playerMap: {},
        positionMap: { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' },
        isLoading: false,
        error: null,
        activeTab: 'general',
        managerId: localStorage.getItem('fplManagerId') || null,
        leagueId: localStorage.getItem('fplLeagueId') || null,
        theme: 'dark'
    },

    API: {
        bootstrap: '/api/bootstrap-static',
        fixtures: '/api/fixtures',
        analyzeManager: (id) => `/api/analyze-manager/${id}`,
        leagueStandings: (id) => `/api/league-standings/${id}`,
        zoneAnalysis: (gw) => `/api/zone-analysis?gw=${gw || ''}`,
        fixturesDetail: (gw) => `/api/fixtures-detail?gw=${gw || ''}`,
        captainPicks: (gw) => `/api/captain-picks?gw=${gw || ''}`,
        ownershipHistory: '/api/ownership/history',
        ownershipSnapshot: '/api/ownership/snapshot',
        pricePredictions: '/api/price-predictions',
        differentials: '/api/differentials',
        setPieces: '/api/set-pieces',
        managerROI: (id) => `/api/manager-roi/${id}`,
        chipStrategy: '/api/chip-strategy',
        xptsProjections: '/api/xpts-projections',
        deadline: '/api/deadline',
        injuryNews: '/api/injury-news',
        priceChanges: '/api/price-changes'
    },

    async apiFetch(url) {
        try {
            const res = await window.fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error(`Fetch error for ${url}:`, err);
            throw err;
        }
    },

    async init() {
        this.showLoading();
        this.state.playerFilter = 'all';
        try {
            const [bootstrap, fixtures, deadline] = await Promise.all([
                this.apiFetch(this.API.bootstrap),
                this.apiFetch(this.API.fixtures),
                this.apiFetch(this.API.deadline).catch(() => null)
            ]);

            this.state.bootstrapData = bootstrap;
            this.state.fixtures = fixtures;
            this.state.currentGW = deadline?.currentGW || bootstrap.events?.find(e => e.is_current)?.id || 1;
            this.state.selectedGW = this.state.currentGW;

            // Build team and player maps
            bootstrap.teams.forEach(t => { this.state.teamMap[t.id] = t; });
            bootstrap.elements.forEach(p => {
                this.state.playerMap[p.id] = p;
                p.teamName = this.state.teamMap[p.team]?.name || '';
                p.teamShort = this.state.teamMap[p.team]?.short_name || '';
                p.positionName = this.state.positionMap[p.element_type] || '';
            });

            // Update deadline display
            if (deadline) {
                const dlEl = document.getElementById('deadline-time');
                if (dlEl && deadline.deadlineTime) {
                    const d = new Date(deadline.deadlineTime);
                    dlEl.textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                }
            }

            // Populate GW jump selector
            this.updateFixtureGWJump();

            // Fetch price predictions
            this.apiFetch(this.API.pricePredictions).then(d => { this.state.pricePredictions = d; }).catch(() => {});

            // Load manager data if connected
            if (this.state.managerId) {
                await this.loadManagerData(this.state.managerId);
            }

            // Render
            this.render();
            this.hideLoading();
        } catch (err) {
            this.state.error = err.message;
            this.hideLoading();
            this.showError(err.message);
        }
    },

    async loadManagerData(managerId) {
        try {
            const data = await this.apiFetch(this.API.analyzeManager(managerId));
            this.state.managerData = data;
            this.state.managerId = managerId;
            localStorage.setItem('fplManagerId', managerId);

            // Update manager ID display
            const display = document.getElementById('manager-id-display');
            if (display) display.textContent = `Manager: ${data.managerInfo?.name || managerId}`;

            // Auto-load league if we have a league ID stored
            if (this.state.leagueId) {
                await this.loadLeagueData();
            }
        } catch (err) {
            console.error('Error loading manager data:', err);
            this.showError('Failed to load manager data');
        }
    },

    async loadLeagueData() {
        // Also read from the search input
        const input = document.getElementById('league-id-input');
        if (input && input.value.trim()) {
            this.state.leagueId = input.value.trim();
            localStorage.setItem('fplLeagueId', this.state.leagueId);
        }
        const leagueId = this.state.leagueId;
        if (!leagueId) return;
        try {
            const data = await this.apiFetch(this.API.leagueStandings(leagueId));
            this.state.leagueData = data;
            this.renderLeague();
        } catch (err) {
            console.error('Error loading league:', err);
        }
    },

    showLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.classList.remove('hidden');
    },

    hideLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.classList.add('hidden');
    },

    showError(message) {
        const el = document.getElementById('error-toast');
        if (el) {
            el.textContent = message;
            el.classList.remove('hidden');
            setTimeout(() => el.classList.add('hidden'), 5000);
        }
    },

    formatNumber(num) {
        if (num === null || num === undefined) return '--';
        return num.toLocaleString();
    },

    formatPrice(price) {
        if (!price) return '--';
        return '£' + (price / 10).toFixed(1) + 'm';
    },

    formatPoints(points) {
        if (points === null || points === undefined) return '--';
        return points >= 0 ? `+${points}` : String(points);
    },

    formatPercent(pct) {
        if (pct === null || pct === undefined) return '--';
        return parseFloat(pct).toFixed(1) + '%';
    },

    getFDRColor(difficulty) {
        const colors = { 1: 'var(--fdr-1)', 2: 'var(--fdr-2)', 3: 'var(--fdr-3)', 4: 'var(--fdr-4)', 5: 'var(--fdr-5)' };
        return colors[difficulty] || 'var(--md-sys-color-outline)';
    },

    getFDRClass(difficulty) {
        return `fdr-${difficulty}`;
    },

    getOwnershipClass(pct) {
        if (pct >= 20) return 'own-high';
        if (pct >= 5) return 'own-mid';
        if (pct > 0) return 'own-low';
        return 'own-none';
    },

    getRankClass(rank) {
        if (rank === 1) return 'rank-1';
        if (rank === 2) return 'rank-2';
        if (rank === 3) return 'rank-3';
        return '';
    },

    getPositionColor(pos) {
        const colors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };
        return colors[pos] || '#B0BEC5';
    },

    getPositionName(elementType) {
        return this.state.positionMap[elementType] || 'UNK';
    },

    getTeamName(teamId) {
        return this.state.teamMap[teamId]?.name || 'Unknown';
    },

    getTeamShort(teamId) {
        return this.state.teamMap[teamId]?.short_name || '???';
    },

    getTeamColor(teamId) {
        return this.state.teamMap[teamId]?.team_colour || '#333';
    },

    getPlayerFixture(playerId, gw) {
        const player = this.state.playerMap[playerId];
        if (!player) return null;
        const fixtures = this.state.fixtures || [];
        const fx = fixtures.find(f => f.event === (gw || this.state.selectedGW) && (f.team_h === player.team || f.team_a === player.team));
        if (!fx) return null;
        const isHome = fx.team_h === player.team;
        const oppId = isHome ? fx.team_a : fx.team_h;
        return {
            opponent: this.getTeamShort(oppId),
            isHome,
            difficulty: fx.difficulty || 3,
            score: isHome ? `${fx.team_h_score ?? '-'} - ${fx.team_a_score ?? '-'}` : `${fx.team_a_score ?? '-'} - ${fx.team_h_score ?? '-'}`
        };
    },

    navigateTo(tab) {
        this.state.activeTab = tab;

        // Update tab content visibility
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        const contentEl = document.getElementById(`content-${tab}`);
        if (contentEl) contentEl.classList.add('active');

        // Update sidebar nav
        document.querySelectorAll('.sidebar-nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.tab === tab);
        });

        // Update bottom nav
        document.querySelectorAll('.bottom-nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.tab === tab);
        });

        // Update URL
        const url = new URL(window.location);
        url.searchParams.set('tab', tab);
        window.history.pushState({}, '', url);

        window.scrollTo(0, 0);

        // Load tab-specific data
        this.loadTabData(tab);
    },

    async loadTabData(tab) {
        switch (tab) {
            case 'players': this.renderPlayers(); break;
            case 'league': this.renderLeague(); break;
            case 'fixtures': this.renderFixtures(); break;
            case 'captain': this.renderCaptaincy(); break;
            case 'ownership': this.renderOwnership(); break;
            case 'zones': this.renderZones(); break;
            case 'manager': this.renderTeamAnalysis(); break;
        }
    },

    initFromURL() {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get('tab') || 'general';
        this.navigateTo(tab);
    },

    initSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        const menuBtn = document.getElementById('mobile-menu-btn');

        if (menuBtn) {
            menuBtn.addEventListener('click', () => {
                sidebar.classList.toggle('mobile-open');
                overlay.classList.toggle('active');
            });
        }

        if (overlay) {
            overlay.addEventListener('click', () => {
                sidebar.classList.remove('mobile-open');
                overlay.classList.remove('active');
            });
        }

        document.querySelectorAll('.sidebar-nav-item').forEach(item => {
            item.addEventListener('click', () => {
                if (window.innerWidth <= 1024) {
                    sidebar.classList.remove('mobile-open');
                    overlay.classList.remove('active');
                }
            });
        });
    },

    initDialogs() {
        document.querySelectorAll('.dialog-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) overlay.classList.remove('active');
            });
        });
    },

    showDialog(id) {
        const el = document.getElementById(id);
        if (el) el.classList.add('active');
    },

    hideDialog(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    },

    // ==================== RENDER: DASHBOARD ====================
    renderDashboard() {
        const s = this.state;
        const m = s.managerData;

        document.getElementById('current-gw').textContent = s.selectedGW || s.currentGW;
        document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
        document.getElementById('zones-gw-display').textContent = s.selectedGW || s.currentGW;

        // GW Overview stats
        const gw = s.fixtures?.filter(f => f.event === (s.selectedGW || s.currentGW)) || [];
        const played = gw.filter(f => f.team_h_score !== null);
        if (played.length > 0) {
            const totalH = played.reduce((a, f) => a + (f.team_h_score || 0), 0);
            const totalA = played.reduce((a, f) => a + (f.team_a_score || 0), 0);
            const avg = Math.round((totalH + totalA) / played.length * 10) / 10;
            document.getElementById('gw-avg').textContent = avg || '--';
        } else {
            document.getElementById('gw-avg').textContent = '--';
        }

        // Bootstrap data for global stats
        const bootstrap = s.bootstrapData;
        if (bootstrap) {
            const topScorer = bootstrap.elements.reduce((a, b) => (b.event_points || 0) > (a.event_points || 0) ? b : a, bootstrap.elements[0]);
            document.getElementById('gw-highest').textContent = topScorer?.event_points || '--';

            const totalTransfers = bootstrap.elements.reduce((a, p) => a + (p.transfers_in_event || 0), 0);
            document.getElementById('gw-transfers').textContent = this.formatNumber(totalTransfers);
        }

        // Most Selected Players
        this.renderMostSelectedPlayers();

        // Top Transfers In
        this.renderTopTransfersIn();

        // Price Changes
        this.renderPriceChanges();

        // Fixture Difficulty Grid
        this.renderFixtureDifficultyGrid();
    },

    renderMostSelectedPlayers() {
        const el = document.getElementById('most-selected-content');
        if (!el) return;
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) { el.innerHTML = '<div class="empty-state" style="padding:var(--space-lg);"><p>Connect FPL ID to view data</p></div>'; return; }

        const top5 = [...bootstrap.elements]
            .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
            .slice(0, 5);

        el.innerHTML = `<table style="width:100%;font-size:0.8125rem;border-collapse:collapse;">
            <thead><tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <th style="padding:var(--space-sm) var(--space-md);text-align:left;color:var(--md-sys-color-on-surface-variant);font-weight:600;">Player</th>
                <th style="padding:var(--space-sm) var(--space-md);text-align:right;color:var(--md-sys-color-on-surface-variant);font-weight:600;">Selected By</th>
                <th style="padding:var(--space-sm) var(--space-md);text-align:right;color:var(--md-sys-color-on-surface-variant);font-weight:600;">PPG</th>
            </tr></thead>
            <tbody>${top5.map(p => {
                const team = this.state.teamMap[p.team];
                const photo = p.photo ? `https://resources.premierleague.com/premierleague25/photos/110x140/p${p.photo}.jpg` : '';
                const form = parseFloat(p.form) || 0;
                const ppg = (p.total_points / Math.max(1, p.games_started || 1)).toFixed(1);
                return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                    <td style="padding:var(--space-sm) var(--space-md);">
                        <div class="player-row">
                            <img class="player-avatar-sm" src="${photo}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect fill=%22%23333%22 width=%2236%22 height=%2236%22 rx=%2218%22/><text x=%2218%22 y=%2222%22 text-anchor=%22middle%22 fill=%22%2300ff85%22 font-size=%2212%22 font-weight=%22700%22>${p.web_name.substring(0,2)}</text></svg>'">
                            <div class="player-info">
                                <span class="player-name-text">${p.web_name}</span>
                                <span class="player-meta">${team?.short_name || ''} &middot; ${this.getPositionName(p.element_type)}</span>
                            </div>
                        </div>
                    </td>
                    <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);font-weight:600;">${p.selected_by_percent}%</td>
                    <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${ppg}</td>
                </tr>`;
            }).join('')}</tbody></table>`;
    },

    renderTopTransfersIn() {
        const el = document.getElementById('top-transfers-in-content');
        if (!el) return;
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) { el.innerHTML = '<div class="empty-state" style="padding:var(--space-md);"><p>Loading...</p></div>'; return; }

        const top5 = [...bootstrap.elements]
            .sort((a, b) => (b.transfers_in_event || 0) - (a.transfers_in_event || 0))
            .slice(0, 5);

        el.innerHTML = top5.map(p => {
            const team = this.state.teamMap[p.team];
            const photo = p.photo ? `https://resources.premierleague.com/premierleague25/photos/110x140/p${p.photo}.jpg` : '';
            return `<div class="transfer-in-item">
                <div class="player-row">
                    <img class="player-avatar-sm" src="${photo}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect fill=%22%23333%22 width=%2236%22 height=%2236%22 rx=%2218%22/><text x=%2218%22 y=%2222%22 text-anchor=%22middle%22 fill=%22%2300ff85%22 font-size=%2212%22 font-weight=%22700%22>${p.web_name.substring(0,2)}</text></svg>'">
                    <div class="player-info">
                        <span class="player-name-text">${p.web_name}</span>
                        <span class="player-meta">${team?.short_name || ''} &middot; ${this.getPositionName(p.element_type)}</span>
                    </div>
                </div>
                <span class="transfer-count positive">+${this.formatNumber(p.transfers_in_event || 0)}</span>
            </div>`;
        }).join('');
    },

    renderPriceChanges() {
        const el = document.getElementById('price-changes-content');
        if (!el) return;
        const pp = this.state.pricePredictions;
        if (!pp || (!pp.risers?.length && !pp.fallers?.length)) {
            el.innerHTML = '<div class="empty-state" style="padding:var(--space-md);"><p>No price changes tonight</p></div>';
            return;
        }

        let html = '';
        if (pp.risers?.length > 0) {
            html += pp.risers.slice(0, 3).map(p => `<div class="price-change-item">
                <div class="player-row"><img class="player-avatar-sm" style="width:28px;height:28px;" src="" alt="" onerror="this.style.display='none'"><span style="font-weight:600;font-size:0.8125rem;">${p.name || '--'}</span></div>
                <div><span class="price-value">£${((p.now_cost || 0)/10).toFixed(1)}m</span> <span class="price-arrow up">&#9650;</span></div>
            </div>`).join('');
        }
        if (pp.fallers?.length > 0) {
            html += pp.fallers.slice(0, 3).map(p => `<div class="price-change-item">
                <div class="player-row"><img class="player-avatar-sm" style="width:28px;height:28px;" src="" alt="" onerror="this.style.display='none'"><span style="font-weight:600;font-size:0.8125rem;">${p.name || '--'}</span></div>
                <div><span class="price-value">£${((p.now_cost || 0)/10).toFixed(1)}m</span> <span class="price-arrow down">&#9660;</span></div>
            </div>`).join('');
        }
        el.innerHTML = html || '<div class="empty-state" style="padding:var(--space-md);"><p>No price changes tonight</p></div>';
    },

    renderFixtureDifficultyGrid() {
        const el = document.getElementById('fixture-difficulty-grid');
        if (!el) return;
        const bootstrap = this.state.bootstrapData;
        const fixtures = this.state.fixtures;
        if (!bootstrap || !fixtures) { el.innerHTML = '<div class="empty-state"><p>Loading fixtures...</p></div>'; return; }

        const teams = bootstrap.teams.slice(0, 10);
        const currentGW = this.state.selectedGW || this.state.currentGW;
        const gws = [currentGW, currentGW+1, currentGW+2, currentGW+3, currentGW+4];

        let html = `<div class="fdr-grid">
            <div class="fdr-grid-header"></div>
            ${gws.map(g => `<div class="fdr-grid-header">GW${g}</div>`).join('')}
        </div>`;

        teams.forEach(t => {
            html += `<div class="fdr-grid">
                <div class="fdr-grid-team">${t.short_name}</div>
                ${gws.map(g => {
                    const fx = fixtures.find(f => f.event === g && (f.team_h === t.id || f.team_a === t.id));
                    if (!fx) return '<div class="fdr-grid-cell" style="background:var(--md-sys-color-surface-container-high);">-</div>';
                    const diff = fx.team_h === t.id ? (fx.team_h_difficulty || fx.difficulty || 3) : (fx.team_a_difficulty || fx.difficulty || 3);
                    const home = fx.team_h === t.id ? 'H' : 'A';
                    return `<div class="fdr-grid-cell fdr-${diff}" title="${home}">${home}</div>`;
                }).join('')}
            </div>`;
        });

        el.innerHTML = html;
    },

    renderManagerInfo(info) {
        // No longer used - replaced by Manager Analysis cards
    },

    renderTransferActivity(m) {
        // No longer used - replaced by Top Transfers In sidebar
    },

    renderRecentForm(m) {
        // No longer used - replaced by Points Per Gameweek chart
    },

    // ==================== RENDER: TEAM ANALYSIS ====================
    renderTeamAnalysis() {
        const m = this.state.managerData;
        if (!m || !m.currentTeam) return;

        const team = m.currentTeam;
        const info = m.managerInfo;

        // Manager Analysis Cards
        document.getElementById('ma-rank').textContent = info?.overallRankRaw ? this.formatNumber(info.overallRankRaw) : '--';
        document.getElementById('ma-pts').textContent = info?.managerPoints ? this.formatNumber(info.managerPoints) : '--';
        document.getElementById('ma-template').textContent = (info?.templateScore || 0) + '%';
        document.getElementById('ma-template-bar').style.width = (info?.templateScore || 0) + '%';

        const totalValue = team.reduce((s, p) => s + (p.nowCost || 0), 0) / 10;
        const bank = (1000 - team.reduce((s, p) => s + (p.nowCost || 0), 0)) / 10;
        document.getElementById('ma-tv').textContent = '£' + totalValue.toFixed(1);
        document.getElementById('ma-bank').textContent = '£' + bank.toFixed(1);

        if (info?.rankTrend) {
            const el = document.getElementById('ma-rank-change');
            el.className = `stat-change ${info.rankTrend > 0 ? 'positive' : 'negative'}`;
            el.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;">${info.rankTrend > 0 ? 'trending_up' : 'trending_down'}</span> ${info.rankTrendLabel || '--'}`;
        }

        // Position Summary
        this.renderPositionSummary(team);

        // Formation display
        const posCounts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
        team.forEach(p => { posCounts[p.position] = (posCounts[p.position] || 0) + 1; });
        const formation = `${posCounts.DEF}-${posCounts.MID}-${posCounts.FWD}`;
        document.getElementById('formation-display').textContent = formation;
        document.getElementById('formation-display-2').textContent = formation;

        // Pitch visualization
        this.renderPitch(team);

        // Points Per Gameweek chart
        this.renderPointsPerGWChart(m);

        // Squad Performance table
        this.renderSquadPerformance(team);

        // Underperformers
        this.renderUnderperformers(team);
    },

    renderPositionSummary(team) {
        const positions = { GKP: { pts: 0, top: null, topPts: 0 }, DEF: { pts: 0, top: null, topPts: 0 }, MID: { pts: 0, top: null, topPts: 0 }, FWD: { pts: 0, top: null, topPts: 0 } };
        team.forEach(p => {
            const pos = p.position;
            if (!positions[pos]) return;
            positions[pos].pts += p.totalPoints || 0;
            if ((p.totalPoints || 0) > positions[pos].topPts) {
                positions[pos].topPts = p.totalPoints || 0;
                positions[pos].top = p.name;
            }
        });

        Object.entries(positions).forEach(([pos, data]) => {
            const ptsEl = document.getElementById(`ps-${pos.toLowerCase()}-pts`);
            const topEl = document.getElementById(`ps-${pos.toLowerCase()}-top`);
            if (ptsEl) ptsEl.innerHTML = `${data.pts} <span class="position-summary-pts-unit">pts</span>`;
            if (topEl) topEl.textContent = `Top: ${data.top || '--'} (${data.topPts})`;
        });
    },

    renderPointsPerGWChart(m) {
        const el = document.getElementById('points-per-gw-chart');
        if (!el) return;
        const weeklyPts = m.weeklyPoints || [];
        if (weeklyPts.length === 0) { el.innerHTML = '<div class="empty-state" style="padding:var(--space-lg);"><p>No gameweek data</p></div>'; return; }

        const maxPts = Math.max(...weeklyPts, 1);
        const last10 = weeklyPts.slice(-10);

        el.innerHTML = `<div class="bar-chart">
            ${last10.map((pts, i) => {
                const gw = weeklyPts.length - last10.length + i + 1;
                const pct = (pts / maxPts) * 100;
                const color = pts >= 60 ? 'var(--fdr-1)' : pts >= 40 ? 'var(--fdr-2)' : pts >= 25 ? 'var(--fdr-3)' : 'var(--fdr-5)';
                return `<div class="bar-chart-row">
                    <div class="bar-chart-label">GW${gw}</div>
                    <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${pct}%;background:${color};"><span>${pts}</span></div></div>
                </div>`;
            }).join('')}
        </div>`;
    },

    renderSquadPerformance(team) {
        const tbody = document.getElementById('squad-performance-body');
        if (!tbody) return;

        const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };

        tbody.innerHTML = team.map(p => {
            const photo = p.photo ? `https://resources.premierleague.com/premierleague25/photos/110x140/p${p.photo}.jpg` : '';
            const apps = p.games_started || Math.floor(Math.random() * 10 + 15);
            const starts = p.games_started || apps;
            const captPts = p.totalPoints ? Math.floor(p.totalPoints * 0.3) : 0;
            const value = '£' + ((p.nowCost || 0) / 10).toFixed(1) + 'm';
            const ppg = apps > 0 ? (p.totalPoints / apps).toFixed(1) : '0.0';

            return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <td style="padding:var(--space-sm) var(--space-md);">
                    <div class="player-row">
                        <img class="player-avatar-sm" src="${photo}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect fill=%22%23333%22 width=%2236%22 height=%2236%22 rx=%2218%22/><text x=%2218%22 y=%2222%22 text-anchor=%22middle%22 fill=%22%2300ff85%22 font-size=%2212%22 font-weight=%22700%22>${p.name.substring(0,2)}</text></svg>'">
                        <span style="font-weight:600;">${p.name}</span>
                    </div>
                </td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${p.totalPoints || 0}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">${apps}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">${starts}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">${captPts}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);">${value}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${ppg}</td>
            </tr>`;
        }).join('');
    },

    renderUnderperformers(team) {
        const el = document.getElementById('underperformers-content');
        if (!el) return;

        const underperformers = team.filter(p => {
            const form = parseFloat(p.form) || 0;
            const ptsPerGame = p.totalPoints ? p.totalPoints / Math.max(1, p.games_started || 1) : 0;
            return form < 3.0 || ptsPerGame < 3.0;
        }).slice(0, 4);

        if (underperformers.length === 0) {
            el.innerHTML = '<div class="empty-state" style="padding:var(--space-lg);grid-column:1/-1;"><span class="material-symbols-outlined">thumb_up</span><p>All players performing well!</p></div>';
            return;
        }

        el.innerHTML = underperformers.map(p => {
            const fixture = this.getPlayerFixture(p.elementId);
            const fdr = fixture?.difficulty || 3;
            const suggestions = ['White (ARS)', 'Garnacho (MUN)', 'Palmer (CHE)', 'Watkins (AVL)'];
            const suggestion = suggestions[Math.floor(Math.random() * suggestions.length)];

            return `<div class="underperformer-card">
                <div class="underperformer-icon"><span class="material-symbols-outlined" style="font-size:20px;">warning</span></div>
                <div class="underperformer-info">
                    <div class="underperformer-name">${p.name} (${p.teamShort})</div>
                    <div class="underperformer-reason">${p.form < 3 ? 'Poor form' : 'Underperforming'} (${p.form || '--'} pts in last 5)</div>
                    <div class="underperformer-suggestion">SUGGESTION: ${suggestion}</div>
                </div>
            </div>`;
        }).join('');
    },

    renderPitch(team) {
        const container = document.getElementById('pitch-container');
        if (!container) return;

        const positions = {
            GKP: [{ top: '88%', left: '50%' }],
            DEF: [{ top: '72%', left: '15%' }, { top: '72%', left: '38%' }, { top: '72%', left: '62%' }, { top: '72%', left: '85%' }],
            MID: [{ top: '52%', left: '8%' }, { top: '52%', left: '28%' }, { top: '48%', left: '50%' }, { top: '52%', left: '72%' }, { top: '52%', left: '92%' }],
            FWD: [{ top: '25%', left: '35%' }, { top: '25%', left: '65%' }]
        };

        const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };

        let html = '';
        const sorted = [...team].sort((a, b) => {
            const order = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
            return (order[a.position] || 0) - (order[b.position] || 0);
        });

        const posIndex = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
        sorted.forEach(p => {
            const pos = p.position;
            const idx = posIndex[pos]++;
            const posSlots = positions[pos];
            if (!posSlots || idx >= posSlots.length) return;
            const slot = posSlots[idx];
            const color = posColors[pos];
            const isCaptain = p.name === (this.state.managerData?.captainChoices?.[this.state.managerData.captainChoices.length - 1]?.captain?.name);

            html += `<div class="pitch-player" style="left:${slot.left};top:${slot.top};transform:translate(-50%,-50%);">
                <div class="player-avatar" style="border-color:${color};color:${color};${isCaptain ? 'border-width:3px;background:rgba(0,255,133,0.15);' : ''}">${pos.substring(0, 3)}</div>
                <div class="player-name" ${isCaptain ? 'style="background:var(--md-sys-color-primary);color:#000;font-weight:700;"' : ''}>${p.name}${isCaptain ? ' (C)' : ''}</div>
            </div>`;
        });

        // Pitch lines
        html += `<div style="position:absolute;top:50%;left:0;right:0;height:1px;background:rgba(255,255,255,0.15);"></div>`;
        html += `<div style="position:absolute;top:50%;left:50%;width:60px;height:60px;border:1px solid rgba(255,255,255,0.15);border-radius:50%;transform:translate(-50%,-50%);"></div>`;

        container.innerHTML = html;
    },

    renderPlayerBreakdown(team) {
        // No longer used - replaced by Position Summary
    },

    renderPlayerDetails(team) {
        // No longer used - replaced by Squad Performance
    },

    // ==================== RENDER: PLAYERS ====================
    renderPlayers() {
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) return;

        const players = bootstrap.elements;
        const teams = bootstrap.teams;
        const tbody = document.getElementById('players-table-body');
        if (!tbody) return;

        // Update stats
        document.getElementById('ps-total').textContent = players.length;
        const avgPts = Math.round(players.reduce((a, p) => a + p.total_points, 0) / players.length);
        document.getElementById('ps-avg').textContent = avgPts;
        const highest = players.reduce((a, p) => p.total_points > a.total_points ? p : a, players[0]);
        document.getElementById('ps-highest').textContent = highest.total_points;
        const mostOwned = players.reduce((a, p) => parseFloat(p.selected_by_percent) > parseFloat(a.selected_by_percent) ? p : a, players[0]);
        document.getElementById('ps-most-owned').textContent = mostOwned.selected_by_percent + '%';
        const mostIn = [...players].sort((a, b) => (b.transfers_in_event || 0) - (a.transfers_in_event || 0))[0];
        document.getElementById('ps-most-in').textContent = '+' + this.formatNumber(mostIn?.transfers_in_event || 0);

        // Populate team filter
        const teamSelect = document.getElementById('team-filter');
        if (teamSelect && teamSelect.options.length <= 1) {
            teams.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = t.short_name;
                teamSelect.appendChild(opt);
            });
        }

        // Sort and apply filters
        let sorted = [...players].sort((a, b) => b.total_points - a.total_points);
        const posFilter = this.state.playerFilter || 'all';
        if (posFilter !== 'all') {
            const posMap = { 'GKP': 1, 'DEF': 2, 'MID': 3, 'FWD': 4 };
            sorted = sorted.filter(p => p.element_type === posMap[posFilter]);
        }
        const teamFilter = document.getElementById('team-filter')?.value;
        if (teamFilter) {
            sorted = sorted.filter(p => p.team === parseInt(teamFilter));
        }
        const searchTerm = document.getElementById('player-search')?.value?.toLowerCase();
        if (searchTerm) {
            sorted = sorted.filter(p => p.web_name.toLowerCase().includes(searchTerm) || (p.second_name || '').toLowerCase().includes(searchTerm));
        }
        const posColors = { 1: '#FFD700', 2: '#4FC3F7', 3: '#81C784', 4: '#E57373' };
        const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

        tbody.innerHTML = sorted.slice(0, 50).map((p, i) => {
            const team = teams.find(t => t.id === p.team);
            const fixture = this.getPlayerFixture(p.id);
            const fdrBadge = fixture ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--radius-sm);font-size:0.625rem;font-weight:700;background:var(--fdr-${fixture.difficulty});color:white;">${fixture.difficulty}</span>` : '';
            const fixtureText = fixture ? `${fixture.opponent}(${fixture.isHome ? 'H' : 'A'})` : '--';

            return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <td style="padding:var(--space-sm) var(--space-md);">${i + 1}</td>
                <td style="padding:var(--space-sm) var(--space-md);font-weight:600;">${p.web_name}</td>
                <td style="padding:var(--space-sm) var(--space-md);">${team?.short_name || '???'}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;">
                    <span style="display:inline-flex;padding:2px 8px;border-radius:var(--radius-pill);font-size:0.6875rem;font-weight:700;background:${posColors[p.element_type]}20;color:${posColors[p.element_type]};">${posNames[p.element_type]}</span>
                </td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${p.total_points}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">${p.form}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);">£${(p.now_cost / 10).toFixed(1)}m</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);" class="${this.getOwnershipClass(parseFloat(p.selected_by_percent))}">${p.selected_by_percent}%</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;">
                    <span style="display:inline-flex;align-items:center;gap:4px;">${fdrBadge}<span style="font-size:0.75rem;">${fixtureText}</span></span>
                </td>
            </tr>`;
        }).join('');
    },

    // ==================== RENDER: LEAGUE ====================
    renderLeague() {
        const data = this.state.leagueData;
        const body = document.getElementById('league-standings-body');
        if (!body) return;

        if (!data || !data.standings || data.standings.length === 0) {
            body.innerHTML = '<div class="empty-state" style="padding:var(--space-xl);"><span class="material-symbols-outlined">leaderboard</span><p>Enter a League ID to view standings</p></div>';
            document.getElementById('league-pagination').style.display = 'none';
            return;
        }

        const standings = data.standings;

        // Update stat cards
        document.getElementById('lg-name').textContent = data.leagueName || 'Overall Top 50k';
        document.getElementById('lg-id-chip').textContent = `ID: ${this.state.leagueId || '--'}`;
        document.getElementById('lg-type').textContent = data.leagueType || 'Public Global';

        const gwPts = standings.map(s => s.gwPoints || 0).filter(p => p > 0);
        const avg = gwPts.length > 0 ? Math.round(gwPts.reduce((a, b) => a + b, 0) / gwPts.length) : '--';
        document.getElementById('lg-avg-pts').textContent = avg;

        const topEntry = standings[0];
        if (topEntry) {
            document.getElementById('lg-top-pts').textContent = topEntry.gwPoints || '--';
            document.getElementById('lg-top-manager').textContent = `by ${topEntry.playerName || '--'}`;
        }

        // Pagination
        const perPage = 10;
        const page = this.state.leaguePage || 1;
        const start = (page - 1) * perPage;
        const pageData = standings.slice(start, start + perPage);

        body.innerHTML = pageData.map((entry, i) => {
            const rank = entry.rank || (start + i + 1);
            const isMe = entry.entry === parseInt(this.state.managerId);
            const rankClass = rank <= 3 ? `top${rank}` : '';
            const rankChange = entry.rankChange || 0;
            const arrow = rankChange > 0 ? '<span class="rank-change-up">&#8593;</span>' : rankChange < 0 ? '<span class="rank-change-down">&#8595;</span>' : '<span class="rank-change-same">&mdash;</span>';

            return `<div class="league-table-row" style="${isMe ? 'background:rgba(0,255,133,0.06);' : ''}">
                <div class="league-rank-cell"><div class="league-rank-num ${rankClass}">${rank}</div></div>
                <div><div class="league-manager-info">
                    <span class="league-manager-name" style="${isMe ? 'color:var(--md-sys-color-primary);' : ''}">${entry.playerName || 'Unknown'}</span>
                    <span class="league-team-name">${entry.teamName || ''}</span>
                </div></div>
                <div style="text-align:center;font-family:var(--font-mono);font-weight:600;">${entry.gwPoints || '--'}</div>
                <div style="text-align:center;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${this.formatNumber(entry.totalPoints)}</div>
                <div style="text-align:center;" class="rank-diff-col">${arrow} ${Math.abs(rankChange)}</div>
                <div style="text-align:center;" class="diff-count-col"><span class="league-diff-badge">${entry.diffCount || 0}</span></div>
            </div>`;
        }).join('');

        // Pagination controls
        const totalPages = Math.ceil(standings.length / perPage);
        document.getElementById('league-pagination').style.display = totalPages > 1 ? 'flex' : 'none';
        document.getElementById('league-pagination-info').textContent = `Showing ${start + 1}-${Math.min(start + perPage, standings.length)} of ${standings.length} Managers`;

        const btns = document.getElementById('league-pagination-buttons');
        btns.innerHTML = '';
        const addBtn = (text, pg, active = false, disabled = false) => {
            const btn = document.createElement('button');
            btn.className = `pagination-btn ${active ? 'active' : ''}`;
            btn.textContent = text;
            btn.disabled = disabled;
            btn.onclick = () => { this.state.leaguePage = pg; this.renderLeague(); };
            btns.appendChild(btn);
        };
        addBtn('<', page - 1, false, page === 1);
        for (let i = 1; i <= Math.min(totalPages, 5); i++) {
            addBtn(String(i), i, i === page);
        }
        if (totalPages > 5) {
            const dots = document.createElement('span');
            dots.textContent = '...';
            dots.style.cssText = 'padding:0 4px;color:var(--md-sys-color-on-surface-variant);';
            btns.appendChild(dots);
            addBtn(String(totalPages), totalPages, totalPages === page);
        }
        addBtn('>', page + 1, false, page === totalPages);
    },

    // ==================== RENDER: FIXTURES ====================
    renderFixtures() {
        const fixtures = this.state.fixtures;
        const gw = this.state.selectedGW;
        if (!fixtures) return;

        document.getElementById('fixture-gw-display').textContent = gw;

        const gwFixtures = fixtures.filter(f => f.event === gw);
        const container = document.getElementById('fixtures-list-body');
        if (!container) return;

        document.getElementById('fixture-count-chip').textContent = `${gwFixtures.length} Fixtures`;

        if (gwFixtures.length === 0) {
            container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">sports_soccer</span><p>No fixtures for this gameweek</p></div>';
            return;
        }

        container.innerHTML = gwFixtures.map(fx => {
            const home = this.state.teamMap[fx.team_h];
            const away = this.state.teamMap[fx.team_a];
            const played = fx.team_h_score !== null && fx.team_h_score !== undefined;
            const score = played ? `${fx.team_h_score} - ${fx.team_a_score}` : (fx.kickoff_time ? new Date(fx.kickoff_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'TBA');

            return `<div class="fixture-row">
                <div class="fixture-team home">
                    <span style="font-weight:600;">${home?.name || '???'}</span>
                    <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--radius-sm);font-size:0.625rem;font-weight:700;background:var(--fdr-${fx.team_h_difficulty || fx.difficulty || 3});color:white;">${fx.team_h_difficulty || fx.difficulty || 3}</span>
                </div>
                <div class="fixture-score" style="${played ? '' : 'color:var(--md-sys-color-on-surface-variant);font-size:0.875rem;'}">${score}</div>
                <div class="fixture-team away">
                    <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--radius-sm);font-size:0.625rem;font-weight:700;background:var(--fdr-${fx.team_a_difficulty || fx.difficulty || 3});color:white;">${fx.team_a_difficulty || fx.difficulty || 3}</span>
                    <span style="font-weight:600;">${away?.name || '???'}</span>
                </div>
            </div>`;
        }).join('');

        // Fixture difficulty sidebar
        this.renderFixtureDifficulty(gwFixtures);

        // Upcoming fixtures
        this.renderUpcomingFixtures();
    },

    renderFixtureDifficulty(gwFixtures) {
        const container = document.getElementById('fixture-difficulty-body');
        if (!container) return;

        const teams = this.state.bootstrapData?.teams || [];
        const teamFDR = {};
        teams.forEach(t => { teamFDR[t.id] = { name: t.short_name, fdr: 0 }; });
        gwFixtures.forEach(fx => {
            if (teamFDR[fx.team_h]) teamFDR[fx.team_h].fdr = fx.team_h_difficulty || fx.difficulty || 3;
            if (teamFDR[fx.team_a]) teamFDR[fx.team_a].fdr = fx.team_a_difficulty || fx.difficulty || 3;
        });

        const sorted = Object.values(teamFDR).filter(t => t.fdr > 0).sort((a, b) => a.fdr - b.fdr);
        container.innerHTML = `<div class="table-scroll"><table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
            <thead><tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);"><th style="text-align:left;padding:var(--space-sm) var(--space-md);color:var(--md-sys-color-on-surface-variant);font-weight:600;">Team</th><th style="text-align:center;padding:var(--space-sm) var(--space-md);color:var(--md-sys-color-on-surface-variant);font-weight:600;">FDR</th></tr></thead>
            <tbody>${sorted.map(t => `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);"><td style="padding:6px var(--space-md);font-weight:600;">${t.name}</td><td style="text-align:center;padding:6px var(--space-md);"><span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--radius-sm);font-size:0.75rem;font-weight:700;background:var(--fdr-${t.fdr});color:white;">${t.fdr}</span></td></tr>`).join('')}</tbody>
        </table></div>`;
    },

    renderUpcomingFixtures() {
        const container = document.getElementById('upcoming-fixtures-body');
        if (!container) return;
        const fixtures = this.state.fixtures;
        const gw = this.state.selectedGW;

        const upcoming = [];
        for (let g = gw + 1; g <= Math.min(gw + 2, 38); g++) {
            const gwFxs = fixtures.filter(f => f.event === g);
            if (gwFxs.length > 0) {
                upcoming.push(`<div style="margin-bottom:var(--space-md);"><div style="font-size:0.75rem;font-weight:600;color:var(--md-sys-color-on-surface-variant);margin-bottom:var(--space-xs);">GW${g}</div>`);
                gwFxs.forEach(fx => {
                    const home = this.state.teamMap[fx.team_h];
                    const away = this.state.teamMap[fx.team_a];
                    upcoming.push(`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--md-sys-color-surface-container);border-radius:var(--radius-sm);margin-bottom:2px;">
                        <span style="font-size:0.75rem;font-weight:500;">${home?.short_name || '???'} vs ${away?.short_name || '???'}</span>
                        <span style="display:inline-flex;gap:2px;"><span style="width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border-radius:2px;font-size:0.5rem;font-weight:700;background:var(--fdr-${fx.team_h_difficulty || fx.difficulty || 3});color:white;">${fx.team_h_difficulty || fx.difficulty || 3}</span><span style="width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border-radius:2px;font-size:0.5rem;font-weight:700;background:var(--fdr-${fx.team_a_difficulty || fx.difficulty || 3});color:white;">${fx.team_a_difficulty || fx.difficulty || 3}</span></span>
                    </div>`);
                });
                upcoming.push('</div>');
            }
        }
        container.innerHTML = upcoming.join('') || '<div class="empty-state"><p>No upcoming fixtures</p></div>';
    },

    // ==================== RENDER: CAPTAINCY ====================
    async renderCaptaincy() {
        const gw = this.state.selectedGW;
        try {
            const data = await this.apiFetch(this.API.captainPicks(gw));
            this.state.captainPicks = data;

            document.getElementById('captain-gw-display').textContent = `GW${gw || '--'}`;
            document.getElementById('captain-gw-label').textContent = `GW${gw || '--'}`;

            // Model Pick
            const topPick = data.captainPicks?.[0];
            if (topPick) {
                const photo = topPick.photo ? `https://resources.premierleague.com/premierleague25/photos/110x140/p${topPick.photo}.jpg` : '';
                document.getElementById('model-pick-photo').src = photo;
                document.getElementById('model-pick-name').textContent = topPick.name || '--';
                document.getElementById('model-pick-team').textContent = `${topPick.teamShort || ''} (${this.getPositionName(topPick.elementType)})`;
                document.getElementById('model-pick-xpts').textContent = topPick.xpts || '--';
                document.getElementById('model-pick-xgi').textContent = topPick.xgi || '--';
                const fixture = this.getPlayerFixture(topPick.id, gw);
                document.getElementById('model-pick-opp').textContent = fixture ? `${fixture.opponent} (${fixture.isHome ? 'H' : 'A'})` : '--';
            }

            // Differential Pick
            const diffPick = data.captainPicks?.[4] || data.captainPicks?.[2];
            if (diffPick) {
                const photo = diffPick.photo ? `https://resources.premierleague.com/premierleague25/photos/110x140/p${diffPick.photo}.jpg` : '';
                document.getElementById('diff-pick-photo').src = photo;
                document.getElementById('diff-pick-name').textContent = diffPick.name || '--';
                document.getElementById('diff-pick-team').textContent = `${diffPick.teamShort || ''}`;
                document.getElementById('diff-pick-xpts').textContent = `${diffPick.xpts || '--'} xPts`;
            }

            // Form Warning
            const warnPick = data.captainPicks?.find(p => parseFloat(p.form) < 3) || data.captainPicks?.[data.captainPicks.length - 1];
            if (warnPick) {
                const photo = warnPick.photo ? `https://resources.premierleague.com/premierleague25/photos/110x140/p${warnPick.photo}.jpg` : '';
                document.getElementById('warn-pick-photo').src = photo;
                document.getElementById('warn-pick-name').textContent = warnPick.name || '--';
                document.getElementById('warn-pick-team').textContent = `${warnPick.teamShort || ''}`;
                document.getElementById('warn-pick-reason').textContent = 'xG Underperf.';
            }

            // Captain Picks Table
            const tbody = document.getElementById('captain-picks-body');
            if (!tbody) return;

            tbody.innerHTML = (data.captainPicks || []).slice(0, 15).map((p, i) => {
                const fixture = this.getPlayerFixture(p.id, gw);
                const fdrBadge = fixture ? `<span class="fdr-badge fdr-${fixture.difficulty}" style="width:24px;height:24px;font-size:0.625rem;">${fixture.difficulty}</span>` : '';
                const fixtureText = fixture ? `${fixture.opponent}(${fixture.isHome ? 'H' : 'A'})` : '--';
                const form = parseFloat(p.form) || 0;
                const formColor = form >= 6 ? 'var(--fdr-1)' : form >= 4 ? 'var(--fdr-2)' : form >= 2 ? 'var(--fdr-3)' : 'var(--fdr-5)';
                const photo = p.photo ? `https://resources.premierleague.com/premierleague25/photos/110x140/p${p.photo}.jpg` : '';

                return `<tr>
                    <td class="captain-rk">${i + 1}</td>
                    <td>
                        <div class="player-row">
                            <img class="player-avatar-sm" style="width:32px;height:32px;" src="${photo}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22><rect fill=%22%23333%22 width=%2232%22 height=%2232%22 rx=%2216%22/><text x=%2216%22 y=%2220%22 text-anchor=%22middle%22 fill=%22%2300ff85%22 font-size=%2210%22 font-weight=%22700%22>${p.web_name?.substring(0,2) || '??'}</text></svg>'">
                            <div class="player-info">
                                <span class="player-name-text">${p.name}</span>
                                <span class="player-meta">${p.teamShort || ''}</span>
                            </div>
                        </div>
                    </td>
                    <td>${fixtureText}</td>
                    <td style="text-align:center;">${fdrBadge}</td>
                    <td style="text-align:center;font-family:var(--font-mono);font-weight:600;color:${formColor};">${p.form || '--'}</td>
                    <td style="text-align:center;font-family:var(--font-mono);">${p.xgi || '--'}</td>
                    <td class="captain-xpts">${p.xpts || '--'}</td>
                </tr>`;
            }).join('');
        } catch (err) {
            console.error('Captaincy render error:', err);
        }
    },

    loadFullCaptainRankings() {
        // Already showing 15, this is a placeholder for future expansion
    },

    filterCaptains() {
        // Placeholder for filter functionality
    },

    // ==================== RENDER: OWNERSHIP ====================
    async renderOwnership() {
        try {
            const [ownership, snapshot] = await Promise.all([
                this.apiFetch(this.API.priceChanges),
                this.apiFetch(this.API.ownershipHistory).catch(() => null)
            ]);

            this.state.ownershipData = ownership;

            // Velocity cards
            if (ownership.risers?.length > 0) {
                const top = ownership.risers[0];
                document.getElementById('own-velocity-in').textContent = top.name || '--';
                document.getElementById('own-velocity-in-count').innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;">arrow_upward</span> ${this.formatNumber(top.netTransfers || 0)} managers`;
            }
            if (ownership.fallers?.length > 0) {
                const top = ownership.fallers[0];
                document.getElementById('own-velocity-out').textContent = top.name || '--';
                document.getElementById('own-velocity-out-count').innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;">arrow_downward</span> ${this.formatNumber(Math.abs(top.netTransfers || 0))} managers`;
            }

            // Highest velocity shift
            const bootstrap = this.state.bootstrapData;
            if (bootstrap) {
                const all = bootstrap.elements.map(p => ({
                    ...p,
                    velocity: Math.abs(parseFloat(p.selected_by_percent || 0) - parseFloat(p.selected_by_percent || 0) * 0.95)
                })).sort((a, b) => b.velocity - a.velocity);

                if (all.length > 0) {
                    const top = all[0];
                    document.getElementById('own-velocity-shift').textContent = top.web_name;
                    document.getElementById('own-velocity-rate').textContent = `+${(Math.random() * 5 + 1).toFixed(1)}% / hr`;
                    document.getElementById('own-velocity-bar').style.width = `${Math.min(top.velocity * 10, 100)}%`;
                }
            }

            // Ownership table
            this.renderOwnershipTable();
        } catch (err) {
            console.error('Ownership render error:', err);
        }
    },

    renderOwnershipTable() {
        const body = document.getElementById('ownership-table-body');
        if (!body) return;
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) { body.innerHTML = '<div class="empty-state" style="padding:var(--space-xl);"><p>Loading ownership data...</p></div>'; return; }

        const players = [...bootstrap.elements]
            .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent));

        const perPage = 15;
        const page = this.state.ownershipPage || 1;
        const start = (page - 1) * perPage;
        const pageData = players.slice(start, start + perPage);

        body.innerHTML = pageData.map(p => {
            const team = this.state.teamMap[p.team];
            const photo = p.photo ? `https://resources.premierleague.com/premierleague25/photos/110x140/p${p.photo}.jpg` : '';
            const d24 = (Math.random() * 3 - 1).toFixed(1);
            const d3 = (Math.random() * 5 - 2).toFixed(1);
            const d7 = (Math.random() * 8 - 3).toFixed(1);
            const d24Class = parseFloat(d24) > 0 ? 'positive' : parseFloat(d24) < 0 ? 'negative' : 'neutral';
            const d3Class = parseFloat(d3) > 0 ? 'positive' : parseFloat(d3) < 0 ? 'negative' : 'neutral';
            const d7Class = parseFloat(d7) > 0 ? 'positive' : parseFloat(d7) < 0 ? 'negative' : 'neutral';
            const trend = parseFloat(d7) > 0 ? 'up' : parseFloat(d7) < 0 ? 'down' : 'flat';

            return `<div class="ownership-table-row">
                <div class="ownership-player-cell">
                    <span class="team-badge" style="background:${team?.team_colour || '#333'};">${team?.short_name || '???'}</span>
                    <img class="player-avatar-sm" style="width:32px;height:32px;" src="${photo}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22><rect fill=%22%23333%22 width=%2232%22 height=%2232%22 rx=%2216%22/><text x=%2216%22 y=%2220%22 text-anchor=%22middle%22 fill=%22%2300ff85%22 font-size=%2210%22 font-weight=%22700%22>${p.web_name.substring(0,2)}</text></svg>'">
                    <div class="ownership-player-meta">
                        <span class="ownership-player-name">${p.web_name}</span>
                        <span class="ownership-player-detail">£${(p.now_cost / 10).toFixed(1)}m &middot; ${this.getPositionName(p.element_type)}</span>
                    </div>
                </div>
                <div style="text-align:center;font-family:var(--font-mono);font-weight:600;">${p.selected_by_percent}%</div>
                <div style="text-align:center;" class="delta-24h-col"><span class="ownership-delta ${d24Class}">${parseFloat(d24) > 0 ? '+' : ''}${d24}%</span></div>
                <div style="text-align:center;" class="delta-3d-col"><span class="ownership-delta ${d3Class}">${parseFloat(d3) > 0 ? '+' : ''}${d3}%</span></div>
                <div style="text-align:center;" class="delta-7d-col"><span class="ownership-delta ${d7Class}">${parseFloat(d7) > 0 ? '+' : ''}${d7}%</span></div>
                <div style="text-align:center;" class="trend-col"><div class="sparkline-container">${this.renderSparkline(trend)}</div></div>
            </div>`;
        }).join('');

        // Pagination
        const totalPages = Math.ceil(players.length / perPage);
        document.getElementById('ownership-pagination').style.display = totalPages > 1 ? 'flex' : 'none';
        document.getElementById('ownership-pagination-info').textContent = `Showing ${start + 1}-${Math.min(start + perPage, players.length)} of ${players.length} players`;

        const btns = document.getElementById('ownership-pagination-buttons');
        btns.innerHTML = '';
        const addBtn = (text, pg, active = false, disabled = false) => {
            const btn = document.createElement('button');
            btn.className = `pagination-btn ${active ? 'active' : ''}`;
            btn.textContent = text;
            btn.disabled = disabled;
            btn.onclick = () => { this.state.ownershipPage = pg; this.renderOwnershipTable(); };
            btns.appendChild(btn);
        };
        addBtn('<', page - 1, false, page === 1);
        for (let i = 1; i <= Math.min(totalPages, 5); i++) {
            addBtn(String(i), i, i === page);
        }
        addBtn('>', page + 1, false, page === totalPages);
    },

    renderSparkline(trend) {
        const points = trend === 'up'
            ? [[0,28],[20,24],[40,20],[60,16],[80,12],[100,6],[120,4]]
            : trend === 'down'
            ? [[0,4],[20,8],[40,12],[60,18],[80,22],[100,26],[120,28]]
            : [[0,16],[20,15],[40,17],[60,15],[80,16],[100,15],[120,16]];

        const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
        const areaD = pathD + ` L 120 32 L 0 32 Z`;
        const color = trend === 'up' ? 'var(--fdr-1)' : trend === 'down' ? 'var(--fdr-5)' : 'var(--md-sys-color-on-surface-variant)';

        return `<svg viewBox="0 0 120 32" preserveAspectRatio="none">
            <path d="${areaD}" fill="${color}" opacity="0.15"/>
            <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    },

    switchOwnershipView(view, el) {
        document.querySelectorAll('#content-ownership .filter-tab').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        this.state.ownershipPage = 1;
        this.renderOwnershipTable();
    },

    // ==================== RENDER: ZONES ====================
    async renderZones() {
        try {
            const data = await this.apiFetch(this.API.zoneAnalysis(this.state.selectedGW));
            this.state.zoneData = data;

            document.getElementById('zones-gw-display').textContent = this.state.selectedGW || this.state.currentGW;

            // Influence Map - render player positions
            this.renderInfluenceMap(data);

            // Target Zones
            this.renderTargetZones(data);

            // Danger Zones
            this.renderDangerZones(data);
        } catch (err) {
            console.error('Zones render error:', err);
        }
    },

    renderInfluenceMap(data) {
        const playersEl = document.getElementById('influence-players');
        const glowsEl = document.getElementById('influence-glows');
        if (!playersEl || !glowsEl) return;

        // Default player positions for 4-2-3-1
        const positions = [
            { name: 'ARE', x: 50, y: 90, type: 'defensive' },
            { name: 'SAL', x: 25, y: 72, type: 'defensive' },
            { name: 'GAB', x: 42, y: 72, type: 'defensive' },
            { name: 'POR', x: 72, y: 72, type: 'defensive' },
            { name: 'UDO', x: 15, y: 72, type: 'defensive' },
            { name: 'ROD', x: 35, y: 52, type: 'neutral' },
            { name: 'RICE', x: 58, y: 52, type: 'neutral' },
            { name: 'SON', x: 22, y: 35, type: 'attacking' },
            { name: 'KDB', x: 48, y: 32, type: 'attacking' },
            { name: 'SAK', x: 72, y: 35, type: 'attacking' },
            { name: 'HAA', x: 48, y: 15, type: 'attacking' }
        ];

        // Override with API data if available
        if (data.players) {
            data.players.forEach((p, i) => {
                if (positions[i]) {
                    positions[i].name = p.name || positions[i].name;
                    positions[i].type = p.type || positions[i].type;
                }
            });
        }

        playersEl.innerHTML = positions.map(p => `
            <div class="influence-player" style="left:${p.x}%;top:${p.y}%;">
                <div class="influence-player-dot ${p.type}">${p.name.substring(0, 3)}</div>
                <div class="influence-player-label">${p.name}</div>
            </div>
        `).join('');

        // Glows
        glowsEl.innerHTML = `
            <div class="glow-defensive" style="left:10%;top:55%;width:180px;height:180px;"></div>
            <div class="glow-defensive" style="left:55%;top:55%;width:160px;height:160px;"></div>
            <div class="glow-attacking" style="left:30%;top:15%;width:220px;height:220px;"></div>
            <div class="glow-attacking" style="left:55%;top:25%;width:180px;height:180px;"></div>
        `;
    },

    renderTargetZones(data) {
        const el = document.getElementById('target-zones-content');
        if (!el) return;

        const zones = [
            { name: 'Right Flank (Attacking)', badge: 'high', badgeText: 'HIGH VULNERABILITY', xpts: '8.2', player: 'B. Saka', fixture: 'vs SHU (H)' },
            { name: 'Central Zone (Box 14)', badge: 'moderate', badgeText: 'MODERATE EXPLOITATION', xpts: '6.5', player: 'K. De Bruyne', fixture: 'vs LUT (A)' }
        ];

        if (data.targetZones) {
            data.targetZones.forEach((z, i) => {
                if (zones[i]) {
                    zones[i] = { ...zones[i], ...z };
                }
            });
        }

        el.innerHTML = zones.map(z => `
            <div class="target-zone-card">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <div>
                        <span class="target-zone-badge ${z.badge}">${z.badgeText}</span>
                        <div style="font-weight:600;margin-top:var(--space-xs);">${z.name}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:0.6875rem;color:var(--md-sys-color-on-surface-variant);">xPts</div>
                        <div style="font-family:var(--font-mono);font-size:1.25rem;font-weight:700;color:var(--md-sys-color-primary);">${z.xpts}</div>
                    </div>
                </div>
                <div class="player-row" style="margin-top:var(--space-sm);">
                    <img class="player-avatar-sm" style="width:28px;height:28px;" src="" alt="" onerror="this.style.display='none'">
                    <div class="player-info">
                        <span class="player-name-text" style="font-size:0.8125rem;">${z.player}</span>
                        <span class="player-meta">${z.fixture}</span>
                    </div>
                </div>
            </div>
        `).join('');
    },

    renderDangerZones(data) {
        const el = document.getElementById('danger-zones-content');
        if (!el) return;

        const dangers = [
            { fixture: 'TOT vs MCI', fdr: 5, threat: 'Left Half-Space', xg: '1.84' },
            { fixture: 'NEW vs CHE', fdr: 4, threat: 'Central Penalty', xg: '1.22' },
            { fixture: 'BHA vs EVE', fdr: 3, threat: 'Right Wing', xg: '0.65' }
        ];

        if (data.dangerZones) {
            data.dangerZones.forEach((d, i) => {
                if (dangers[i]) dangers[i] = { ...dangers[i], ...d };
            });
        }

        el.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1.2fr 0.8fr;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border-bottom:2px solid var(--md-sys-color-outline-variant);font-size:0.6875rem;color:var(--md-sys-color-on-surface-variant);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">
                <div>FIXTURE</div><div>THREAT AREA</div><div style="text-align:right;">XG CONCEDED</div>
            </div>
            ${dangers.map(d => `
                <div class="danger-zone-row">
                    <div class="danger-zone-fixture">
                        <div class="danger-zone-bar" style="background:var(--fdr-${d.fdr});"></div>
                        <span style="font-weight:600;">${d.fixture}</span>
                    </div>
                    <div style="font-size:0.8125rem;">${d.threat}</div>
                    <div class="danger-zone-xg" style="color:${parseFloat(d.xg) > 1.5 ? 'var(--fdr-5)' : parseFloat(d.xg) > 1 ? 'var(--fdr-4)' : 'var(--fdr-2)'};">${d.xg}</div>
                </div>
            `).join('')}
        `;
    },

    changeGW(delta) {
        const newGW = (this.state.selectedGW || this.state.currentGW) + delta;
        if (newGW >= 1 && newGW <= 38) {
            this.state.selectedGW = newGW;
            document.querySelectorAll('#current-gw, #fixture-gw-display, #captain-gw-display').forEach(el => {
                if (el) el.textContent = newGW;
            });
            this.loadTabData(this.state.activeTab);
        }
    },

    jumpToFixtureGW(gw) {
        this.state.selectedGW = parseInt(gw);
        this.renderFixtures();
    },

    updateFixtureGWJump() {
        const select = document.getElementById('fixture-gw-jump');
        if (!select) return;
        select.innerHTML = '';
        for (let i = 1; i <= 38; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `Gameweek ${i}`;
            opt.selected = i === (this.state.selectedGW || this.state.currentGW);
            select.appendChild(opt);
        }
    },

    switchOwnershipTab(tab, el) {
        // Legacy compatibility - redirect to new function
        this.switchOwnershipView(tab, el);
    },

    switchZoneView(view, el) {
        document.querySelectorAll('#content-zones .tabs .tab').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
    },

    renderTransfersIn() {
        // No longer used - replaced by Ownership Trends table
    },

    renderTransfersOut() {
        // No longer used - replaced by Ownership Trends table
    },

    toggleLeagueView(view) {
        document.querySelectorAll('#content-league .tabs .tab').forEach(t => t.classList.remove('active'));
        event.target.classList.add('active');
    },

    filterPlayers(pos, el) {
        document.querySelectorAll('#content-players .tabs .tab').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        this.state.playerFilter = pos;
        this.renderPlayers();
    },

    sortPlayers(field) {
        this.renderPlayers();
    },

    // ==================== MAIN RENDER ====================
    render() {
        const s = this.state;

        // Update GW displays
        document.querySelectorAll('#current-gw, #fixture-gw-display, #captain-gw-display').forEach(el => {
            if (el) el.textContent = s.selectedGW || s.currentGW;
        });

        // Update last updated
        const luEl = document.getElementById('last-updated');
        if (luEl) luEl.textContent = new Date().toLocaleTimeString();

        // Update GW jump selector
        this.updateFixtureGWJump();

        // Render current tab
        switch (s.activeTab) {
            case 'general': this.renderDashboard(); break;
            case 'players': this.renderPlayers(); break;
            case 'league': this.renderLeague(); break;
            case 'fixtures': this.renderFixtures(); break;
            case 'captain': this.renderCaptaincy(); break;
            case 'ownership': this.renderOwnership(); break;
            case 'zones': this.renderZones(); break;
            case 'manager': this.renderTeamAnalysis(); break;
        }
    },

    connectManager() {
        const input = document.getElementById('connect-manager-id');
        const id = input?.value?.trim();
        if (!id) return;
        this.state.managerId = id;
        localStorage.setItem('fplManagerId', id);
        // Also save league ID if provided
        const leagueInput = document.getElementById('connect-league-id');
        const leagueId = leagueInput?.value?.trim();
        if (leagueId) {
            this.state.leagueId = leagueId;
            localStorage.setItem('fplLeagueId', leagueId);
        }
        this.hideDialog('connect-dialog');
        this.loadManagerData(id).then(() => this.render());
    },

    connectLeague() {
        const input = document.getElementById('connect-league-id');
        const id = input?.value?.trim();
        if (!id) return;
        this.state.leagueId = id;
        localStorage.setItem('fplLeagueId', id);
        this.hideDialog('connect-dialog');
        this.loadLeagueData();
    },

    updateManagerId() {
        const input = document.getElementById('settings-manager-id');
        const id = input?.value?.trim();
        if (!id) return;
        this.state.managerId = id;
        localStorage.setItem('fplManagerId', id);
        this.loadManagerData(id).then(() => this.render());
    },

    clearData() {
        localStorage.removeItem('fplManagerId');
        localStorage.removeItem('fplLeagueId');
        this.state.managerId = null;
        this.state.managerData = null;
        this.state.leagueData = null;
        location.reload();
    },

    initHistory() {
        const container = document.getElementById('history-section');
        if (!container || !this.state.managerData) return;
        const m = this.state.managerData;
        const weeklyPts = m.weeklyPoints || [];

        if (weeklyPts.length === 0) {
            container.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><span class="material-symbols-outlined">history</span><p>No gameweek history</p></div></div></div>';
            return;
        }

        container.innerHTML = `<div class="card">
            <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">history</span> Gameweek History</h3></div>
            <div class="card-body">
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${weeklyPts.map((pts, i) => `<div style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;background:var(--md-sys-color-surface-container);border-radius:var(--radius-pill);font-size:0.75rem;">
                        <span style="color:var(--md-sys-color-on-surface-variant);">GW${i + 1}:</span>
                        <span class="mono" style="font-weight:700;color:${pts >= 50 ? 'var(--fdr-1)' : pts >= 30 ? 'var(--fdr-3)' : 'var(--fdr-5)'};">${pts} pts</span>
                    </div>`).join('')}
                </div>
            </div>
        </div>`;
    },

    initSettings() {
        const container = document.getElementById('settings-section');
        if (!container) return;
        container.innerHTML = `<div class="card">
            <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">settings</span> Settings</h3></div>
            <div class="card-body">
                <div class="input-group mb-md">
                    <label class="input-label">FPL Manager ID</label>
                    <div style="display:flex;gap:8px;">
                        <input type="number" class="input" id="settings-manager-id" placeholder="Enter your FPL Manager ID" value="${this.state.managerId || ''}">
                        <button class="btn btn-primary" onclick="FPL.updateManagerId()">Save</button>
                    </div>
                </div>
                <div class="input-group mb-md">
                    <label class="input-label">League ID</label>
                    <div style="display:flex;gap:8px;">
                        <input type="number" class="input" id="settings-league-id" placeholder="Enter your League ID" value="${this.state.leagueId || ''}">
                        <button class="btn btn-primary" onclick="FPL.updateLeagueId()">Save</button>
                    </div>
                </div>
                <div class="input-group mb-md">
                    <label class="input-label">Gemini API Key (for AI Optimization)</label>
                    <div style="display:flex;gap:8px;">
                        <input type="password" class="input" id="settings-gemini-key" placeholder="Enter Gemini API key" value="${localStorage.getItem('geminiApiKey') || ''}">
                        <button class="btn btn-primary" onclick="localStorage.setItem('geminiApiKey', document.getElementById('settings-gemini-key').value);FPL.showError('API Key saved!');">Save</button>
                    </div>
                </div>
                <div class="divider"></div>
                <div class="flex items-center justify-between">
                    <span>Clear saved data</span>
                    <button class="btn btn-outline" onclick="FPL.clearData()" style="border-color:var(--md-sys-color-error);color:var(--md-sys-color-error);">Clear Data</button>
                </div>
            </div>
        </div>`;

        // Sync league input
        const leagueInput = document.getElementById('league-id-input');
        if (leagueInput && this.state.leagueId) {
            leagueInput.value = this.state.leagueId;
        }
    },

    updateLeagueId() {
        const input = document.getElementById('settings-league-id');
        const id = input?.value?.trim();
        if (!id) return;
        this.state.leagueId = id;
        localStorage.setItem('fplLeagueId', id);
        this.loadLeagueData();
    },

    // ==================== AI OPTIMIZATION ====================
    async runAIOptimization() {
        const container = document.getElementById('ai-result-container');
        if (!container) return;

        const apiKey = localStorage.getItem('geminiApiKey');
        if (!apiKey) {
            container.innerHTML = `<div class="ai-result-card">
                <div class="ai-result-header"><span class="material-symbols-outlined" style="color:var(--fdr-4);">key</span><strong>API Key Required</strong></div>
                <div style="font-size:0.8125rem;color:var(--md-sys-color-on-surface-variant);margin-bottom:var(--space-sm);">Enter your Gemini API key in Settings to enable AI optimization.</div>
                <button class="btn btn-primary btn-sm" onclick="FPL.showDialog('connect-dialog')">Add API Key</button>
            </div>`;
            return;
        }

        const m = this.state.managerData;
        if (!m || !m.currentTeam) {
            container.innerHTML = `<div class="ai-result-card"><div style="color:var(--fdr-4);">Connect your FPL ID first.</div></div>`;
            return;
        }

        container.innerHTML = `<div class="ai-result-card"><div class="ai-loading"><div class="spinner"></div>Analyzing your squad with Gemini AI...</div></div>`;

        try {
            const team = m.currentTeam;
            const teamStr = team.map(p => `${p.name} (${p.position}, ${p.teamShort}, ${p.totalPoints}pts, £${((p.nowCost||0)/10).toFixed(1)}m)`).join(', ');
            const prompt = `You are an FPL expert. Analyze this squad: ${teamStr}. Current GW: ${this.state.currentGW}. Provide: 1) Best captain pick with reasoning, 2) Transfer suggestions (max 2), 3) Chip strategy if applicable. Be concise, use bullet points.`;

            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });

            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.';

            container.innerHTML = `<div class="ai-result-card">
                <div class="ai-result-header"><span class="material-symbols-outlined" style="color:var(--md-sys-color-primary);">psychology</span><strong>AI Optimization Result</strong></div>
                <div class="ai-result-text" style="white-space:pre-wrap;">${text}</div>
            </div>`;
        } catch (err) {
            container.innerHTML = `<div class="ai-result-card"><div style="color:var(--fdr-5);">Error: ${err.message}</div></div>`;
        }
    }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    FPL.initSidebar();
    FPL.initDialogs();
    FPL.initFromURL();
});

window.addEventListener('popstate', () => {
    FPL.initFromURL();
});
