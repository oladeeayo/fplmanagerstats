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

        // Update GW display
        const gwEls = document.querySelectorAll('#current-gw, #fixture-gw-display, #captain-gw-display');
        gwEls.forEach(el => { if (el) el.textContent = s.selectedGW || s.currentGW; });

        document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();

        if (!m || !m.managerInfo) {
            document.getElementById('stat-overall-rank').textContent = '--';
            document.getElementById('stat-total-points').textContent = '--';
            document.getElementById('stat-gw-rank').textContent = '--';
            document.getElementById('stat-transfer-cost').textContent = '--';
            document.getElementById('stat-team-value').textContent = '--';
            return;
        }

        const info = m.managerInfo;
        const teamVal = m.playerStats ? (m.playerStats.reduce((s, p) => s + (p.nowCost || 0), 0) / 10) : 0;

        document.getElementById('stat-overall-rank').textContent = this.formatNumber(info.overallRankRaw);
        document.getElementById('stat-total-points').textContent = this.formatNumber(info.managerPoints);
        document.getElementById('stat-gw-rank').textContent = info.lowestRank || '--';
        document.getElementById('stat-transfer-cost').textContent = info.totalTransfers || 0;
        document.getElementById('stat-team-value').textContent = '£' + teamVal.toFixed(1);

        // Rank change
        const rankChangeEl = document.getElementById('stat-overall-rank-change');
        if (rankChangeEl && info.rankTrend) {
            const cls = info.rankTrend > 0 ? 'positive' : 'negative';
            const icon = info.rankTrend > 0 ? 'trending_up' : 'trending_down';
            rankChangeEl.className = `stat-change ${cls}`;
            rankChangeEl.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px">${icon}</span> ${info.rankTrendLabel}`;
        }

        // Manager info card
        this.renderManagerInfo(info);

        // Transfer activity
        this.renderTransferActivity(m);

        // Recent form
        this.renderRecentForm(m);
    },

    renderManagerInfo(info) {
        const el = document.getElementById('manager-info-content');
        if (!el) return;
        el.innerHTML = `
            <div class="flex items-center gap-md mb-md">
                <div style="width:48px;height:48px;border-radius:var(--radius-md);background:var(--fpl-accent-dim);display:flex;align-items:center;justify-content:center;">
                    <span class="material-symbols-outlined" style="font-size:24px;color:var(--md-sys-color-primary);">person</span>
                </div>
                <div>
                    <div style="font-weight:600;font-size:1rem;">${info.name || 'Unknown'}</div>
                    <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Team: ${info.teamName || '--'}</div>
                </div>
            </div>
            <div class="divider"></div>
            <div class="grid grid-2" style="gap:var(--space-sm);margin-top:var(--space-md);">
                <div><span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Overall Rank</span><div class="mono" style="font-weight:600;">${info.overallRanking || '--'}</div></div>
                <div><span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Total Points</span><div class="mono" style="font-weight:600;">${this.formatNumber(info.managerPoints)}</div></div>
                <div><span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Captaincy Efficiency</span><div class="mono" style="font-weight:600;">${info.captaincyEfficiency || '--'}%</div></div>
                <div><span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Chips Used</span><div class="mono" style="font-weight:600;">${info.chipsUsed?.length || 0}</div></div>
                <div><span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Best GW</span><div class="mono" style="font-weight:600;color:var(--fdr-1);">${info.highestPoints} (GW${info.highestPointsGW})</div></div>
                <div><span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Worst GW</span><div class="mono" style="font-weight:600;color:var(--fdr-5);">${info.lowestPoints} (GW${info.lowestPointsGW})</div></div>
                <div><span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Bench Points Lost</span><div class="mono" style="font-weight:600;color:var(--md-sys-color-error);">${info.totalPointsLostOnBench || 0}</div></div>
                <div><span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Template Score</span><div class="mono" style="font-weight:600;">${info.templateScore || 0}</div></div>
            </div>`;
    },

    renderTransferActivity(m) {
        const el = document.getElementById('transfer-activity-content');
        if (!el) return;
        if (!m || !m.playerStats) {
            el.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">swap_horiz</span><p>No transfer data</p></div>';
            return;
        }
        const info = m.managerInfo;
        el.innerHTML = `
            <div class="flex items-center justify-between mb-sm">
                <span style="font-size:0.875rem;font-weight:600;">Total Transfers</span>
                <span class="chip">${info.totalTransfers || 0} pts spent</span>
            </div>
            <div class="flex items-center justify-between mb-sm">
                <span style="font-size:0.875rem;">Captain Points</span>
                <span class="mono" style="color:var(--md-sys-color-primary);">${info.totalCaptaincyPoints || 0}</span>
            </div>
            <div class="flex items-center justify-between">
                <span style="font-size:0.875rem;">Differential Score</span>
                <span class="mono">${info.differentialScore || 0}</span>
            </div>`;
    },

    renderRecentForm(m) {
        const el = document.getElementById('recent-form-content');
        if (!el || !m) return;
        const weeklyPts = m.weeklyPoints || [];
        if (weeklyPts.length === 0) {
            el.innerHTML = '<div class="empty-state" style="width:100%"><span class="material-symbols-outlined">show_chart</span><p>No form data</p></div>';
            return;
        }
        const last5 = weeklyPts.slice(-5);
        el.innerHTML = last5.map((pts, i) => {
            const gw = weeklyPts.length - last5.length + i + 1;
            const color = pts >= 60 ? 'var(--fdr-1)' : pts >= 40 ? 'var(--fdr-2)' : pts >= 25 ? 'var(--fdr-3)' : 'var(--fdr-5)';
            return `<div style="display:flex;flex-direction:column;align-items:center;padding:var(--space-sm) var(--space-md);background:var(--md-sys-color-surface-container);border-radius:var(--radius-md);min-width:60px;">
                <div style="font-size:0.625rem;color:var(--md-sys-color-on-surface-variant);">GW${gw}</div>
                <div class="mono" style="font-size:1.25rem;font-weight:700;color:${color};">${pts}</div>
                <div style="font-size:0.5rem;color:var(--md-sys-color-on-surface-variant);">pts</div>
            </div>`;
        }).join('');
    },

    // ==================== RENDER: TEAM ANALYSIS ====================
    renderTeamAnalysis() {
        const m = this.state.managerData;
        if (!m || !m.currentTeam) return;

        const team = m.currentTeam;
        const info = m.managerInfo;

        document.getElementById('team-name-display').textContent = info?.teamName || 'My Team';

        // Determine formation
        const posCounts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
        team.forEach(p => { posCounts[p.position] = (posCounts[p.position] || 0) + 1; });
        const formation = `${posCounts.DEF}-${posCounts.MID}-${posCounts.FWD}`;
        document.getElementById('formation-display').textContent = formation;
        document.getElementById('formation-display-2').textContent = formation;

        // Team value stats - currentTeam items use totalPoints (not totalPointsActive)
        const totalValue = team.reduce((s, p) => s + (p.nowCost || 0), 0) / 10;
        const bank = (1000 - team.reduce((s, p) => s + (p.nowCost || 0), 0)) / 10;
        document.getElementById('tv-value').textContent = '£' + totalValue.toFixed(1);
        document.getElementById('tv-bank').textContent = '£' + bank.toFixed(1);
        document.getElementById('tv-itb').textContent = '£' + bank.toFixed(1);
        document.getElementById('tv-gw-pts').textContent = info?.highestPoints || '--';

        // Pitch visualization
        this.renderPitch(team);

        // Player breakdown
        this.renderPlayerBreakdown(team);

        // Player details table
        this.renderPlayerDetails(team);
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
        const tbody = document.getElementById('player-breakdown-body');
        if (!tbody) return;

        const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };
        const breakdown = {};
        team.forEach(p => {
            if (!breakdown[p.position]) breakdown[p.position] = { count: 0, totalPts: 0, totalValue: 0 };
            breakdown[p.position].count++;
            breakdown[p.position].totalPts += p.totalPoints || 0;
            breakdown[p.position].totalValue += (p.nowCost || 0) / 10;
        });

        tbody.innerHTML = Object.entries(breakdown).map(([pos, data]) => `
            <tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <td style="padding:var(--space-sm);">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${posColors[pos]};margin-right:6px;"></span>${pos}
                </td>
                <td style="padding:var(--space-sm);text-align:center;font-family:var(--font-mono);font-weight:600;">${data.count}</td>
                <td style="padding:var(--space-sm);text-align:center;font-family:var(--font-mono);">${(data.totalPts / data.count).toFixed(1)}</td>
                <td style="padding:var(--space-sm);text-align:right;font-family:var(--font-mono);">£${data.totalValue.toFixed(1)}m</td>
            </tr>
        `).join('');
    },

    renderPlayerDetails(team) {
        const tbody = document.getElementById('player-details-body');
        if (!tbody) return;

        const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };
        const posNames = { GKP: 'GKP', DEF: 'DEF', MID: 'MID', FWD: 'FWD' };

        tbody.innerHTML = team.map(p => {
            const fixture = this.getPlayerFixture(p.elementId);
            const fdrBadge = fixture ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--radius-sm);font-size:0.625rem;font-weight:700;background:var(--fdr-${fixture.difficulty});color:white;">${fixture.difficulty}</span>` : '';
            const fixtureText = fixture ? `${fixture.opponent} (${fixture.isHome ? 'H' : 'A'})` : '--';
            const isCaptain = p.name === (this.state.managerData?.captainChoices?.[this.state.managerData.captainChoices.length - 1]?.captain?.name);

            return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);${isCaptain ? 'background:rgba(0,255,133,0.05);' : ''}">
                <td style="padding:var(--space-md);">
                    <span style="display:inline-flex;align-items:center;justify-content:center;padding:2px 8px;border-radius:var(--radius-pill);font-size:0.6875rem;font-weight:700;background:${posColors[p.position]}20;color:${posColors[p.position]};">${posNames[p.position]}</span>
                </td>
                <td style="padding:var(--space-md);">
                    <div style="display:flex;align-items:center;gap:var(--space-sm);">
                        <span style="font-weight:600;">${p.name}</span>
                        ${isCaptain ? '<span style="padding:1px 6px;border-radius:var(--radius-pill);font-size:0.625rem;font-weight:700;background:var(--md-sys-color-primary);color:#000;">C</span>' : ''}
                        <span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">${p.teamShort}</span>
                    </div>
                </td>
                <td style="padding:var(--space-md);text-align:center;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${p.totalPoints || 0}</td>
                <td style="padding:var(--space-md);text-align:center;font-family:var(--font-mono);">${p.form || '--'}</td>
                <td style="padding:var(--space-md);text-align:center;font-family:var(--font-mono);">£${((p.nowCost || 0) / 10).toFixed(1)}m</td>
                <td style="padding:var(--space-md);text-align:center;font-family:var(--font-mono);" class="${this.getOwnershipClass(parseFloat(p.selectedBy))}">${p.selectedBy || '--'}%</td>
                <td style="padding:var(--space-md);text-align:center;">
                    <span style="display:inline-flex;align-items:center;gap:4px;">${fdrBadge}<span style="font-size:0.8125rem;">${fixtureText}</span></span>
                </td>
            </tr>`;
        }).join('');
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
        const tbody = document.getElementById('league-standings-body');
        if (!tbody) return;

        if (!data || !data.standings || data.standings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:var(--space-lg);color:var(--md-sys-color-on-surface-variant);">' +
                (this.state.leagueId ?
                    'Loading league data...' :
                    'Set your League ID in Settings to view standings') + '</td></tr>';
            if (this.state.leagueId) {
                this.loadLeagueData();
            }
            return;
        }

        // Update league name
        document.getElementById('league-name-display').textContent = data.leagueName || '--';

        // Update stats
        const standings = data.standings;
        const myEntry = standings.find(s => s.entry === parseInt(this.state.managerId));
        if (myEntry) {
            document.getElementById('league-rank').textContent = myEntry.rank;
            document.getElementById('league-rank-detail').textContent = `out of ${standings.length} managers`;
        }

        // Leader stats
        const leader = standings[0];
        if (leader) {
            document.getElementById('league-leader').textContent = `Leader: ${this.formatNumber(leader.totalPoints)} pts`;
            if (myEntry) {
                const behind = leader.totalPoints - myEntry.totalPoints;
                document.getElementById('league-behind').textContent = behind;
            }
        }

        const avg = Math.round(standings.reduce((s, e) => s + (e.totalPoints || 0), 0) / standings.length);
        document.getElementById('league-avg').textContent = this.formatNumber(avg);
        document.getElementById('league-size').textContent = standings.length;

        // Render table
        tbody.innerHTML = standings.map((entry, i) => {
            const isMe = entry.entry === parseInt(this.state.managerId);
            const rankClass = entry.rank <= 3 ? this.getRankClass(entry.rank) : '';
            const chipLabels = entry.chipsUsed || 'None';
            const rankChange = entry.rankChange || 0;
            const arrow = rankChange > 0 ? '<span style="color:var(--fdr-1)">▲</span>' : rankChange < 0 ? '<span style="color:var(--fdr-5)">▼</span>' : '<span style="color:var(--md-sys-color-on-surface-variant)">—</span>';

            return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);${isMe ? 'background:rgba(0,255,133,0.06);' : ''}">
                <td style="padding:0.75rem 1rem;">
                    <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;font-weight:700;font-size:0.8125rem;${rankClass ? `background:linear-gradient(135deg,var(--fdr-${entry.rank === 1 ? '3' : entry.rank === 2 ? '2' : '4'}),var(--fdr-${entry.rank}));color:white;` : `background:var(--md-sys-color-surface-container-high);color:var(--md-sys-color-on-surface-variant);`}${isMe ? 'background:var(--md-sys-color-primary);color:#000;' : ''}">${entry.rank}</span>
                </td>
                <td style="padding:0.75rem 1rem;">
                    <div style="display:flex;align-items:center;gap:0.75rem;">
                        <div style="width:32px;height:32px;border-radius:var(--radius-sm);background:var(--md-sys-color-surface-container-high);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:var(--md-sys-color-on-surface);">${entry.teamName?.substring(0, 2).toUpperCase() || '??'}</div>
                        <div>
                            <div style="font-weight:600;${isMe ? 'color:var(--md-sys-color-primary);' : ''}">${entry.playerName || 'Unknown'}</div>
                            <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">${entry.teamName || ''}</div>
                        </div>
                    </div>
                </td>
                <td style="padding:0.75rem 1rem;text-align:right;font-family:var(--font-mono);font-weight:600;">${entry.gwPoints || '--'}</td>
                <td style="padding:0.75rem 1rem;text-align:right;font-family:var(--font-mono);font-weight:600;">${this.formatNumber(entry.totalPoints)}</td>
                <td style="padding:0.75rem 1rem;text-align:right;font-family:var(--font-mono);">${chipLabels}</td>
                <td style="padding:0.75rem 1rem;text-align:center;">${arrow}</td>
            </tr>`;
        }).join('');
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

            return `<div class="fixture-row" style="display:grid;grid-template-columns:1fr auto 1fr;gap:var(--space-md);padding:var(--space-sm) var(--space-md);border-radius:var(--radius-md);border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <div class="fixture-team home" style="display:flex;align-items:center;justify-content:flex-end;gap:var(--space-sm);">
                    <span style="font-weight:600;">${home?.name || '???'}</span>
                    <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--radius-sm);font-size:0.625rem;font-weight:700;background:var(--fdr-${fx.team_h_difficulty || fx.difficulty || 3});color:white;">${fx.team_h_difficulty || fx.difficulty || 3}</span>
                </div>
                <div class="fixture-score" style="font-family:var(--font-mono);font-weight:700;font-size:1rem;min-width:60px;text-align:center;${played ? '' : 'color:var(--md-sys-color-on-surface-variant);font-size:0.875rem;'}">${score}</div>
                <div class="fixture-team away" style="display:flex;align-items:center;gap:var(--space-sm);">
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
        container.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
            <thead><tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);"><th style="text-align:left;padding:var(--space-sm) var(--space-md);color:var(--md-sys-color-on-surface-variant);font-weight:600;">Team</th><th style="text-align:center;padding:var(--space-sm) var(--space-md);color:var(--md-sys-color-on-surface-variant);font-weight:600;">FDR</th></tr></thead>
            <tbody>${sorted.map(t => `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);"><td style="padding:6px var(--space-md);font-weight:600;">${t.name}</td><td style="text-align:center;padding:6px var(--space-md);"><span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--radius-sm);font-size:0.75rem;font-weight:700;background:var(--fdr-${t.fdr});color:white;">${t.fdr}</span></td></tr>`).join('')}</tbody>
        </table>`;
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

            const tbody = document.getElementById('captain-picks-body');
            if (!tbody) return;

            document.getElementById('cap-most').textContent = data.captainPicks?.[0]?.name || '--';
            document.getElementById('cap-vice').textContent = data.captainPicks?.[1]?.name || '--';
            document.getElementById('cap-avg').textContent = data.captainPicks?.[0]?.xpts || '--';

            tbody.innerHTML = (data.captainPicks || []).slice(0, 10).map((p, i) => {
                const fixture = this.getPlayerFixture(p.id, gw);
                const fdrBadge = fixture ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--radius-sm);font-size:0.625rem;font-weight:700;background:var(--fdr-${fixture.difficulty});color:white;">${fixture.difficulty}</span>` : '';

                return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                    <td style="padding:var(--space-sm) var(--space-md);">${i + 1}</td>
                    <td style="padding:var(--space-sm) var(--space-md);font-weight:600;">${p.name} <span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">${p.teamShort}</span></td>
                    <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${p.totalPts}</td>
                    <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">${p.xpts}</td>
                    <td style="padding:var(--space-sm) var(--space-md);text-align:center;">
                        <div class="progress" style="height:6px;width:80px;"><div class="progress-bar" style="width:${Math.min(p.xpts * 5, 100)}%"></div></div>
                    </td>
                    <td style="padding:var(--space-sm) var(--space-md);text-align:center;">
                        <span style="display:inline-flex;align-items:center;gap:4px;">${fdrBadge}<span style="font-size:0.75rem;">${fixture ? fixture.opponent + (fixture.isHome ? '(H)' : '(A)') : '--'}</span></span>
                    </td>
                </tr>`;
            }).join('');
        } catch (err) {
            console.error('Captaincy render error:', err);
        }
    },

    // ==================== RENDER: OWNERSHIP ====================
    async renderOwnership() {
        try {
            const [ownership, snapshot] = await Promise.all([
                this.apiFetch(this.API.priceChanges),
                this.apiFetch(this.API.ownershipHistory).catch(() => null)
            ]);

            this.state.ownershipData = ownership;

            // Stats
            if (ownership.risers?.length > 0) {
                document.getElementById('own-most-in').textContent = '+' + this.formatNumber(ownership.risers[0]?.netTransfers || 0);
                document.getElementById('own-most-in-detail').textContent = ownership.risers[0]?.name || '';
            }
            if (ownership.fallers?.length > 0) {
                document.getElementById('own-most-out').textContent = '-' + this.formatNumber(Math.abs(ownership.fallers[0]?.netTransfers || 0));
                document.getElementById('own-most-out-detail').textContent = ownership.fallers[0]?.name || '';
            }

            // Ownership table
            const bootstrap = this.state.bootstrapData;
            if (!bootstrap) return;

            const players = bootstrap.elements
                .sort((a, b) => parseFloat(b.selected_by_percent) - parseFloat(a.selected_by_percent))
                .slice(0, 30);

            const posColors = { 1: '#FFD700', 2: '#4FC3F7', 3: '#81C784', 4: '#E57373' };
            const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

            const tbody = document.getElementById('ownership-table-body');
            if (tbody) {
                tbody.innerHTML = players.map((p, i) => {
                    const team = bootstrap.teams.find(t => t.id === p.team);
                    return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                        <td style="padding:var(--space-sm) var(--space-md);">${i + 1}</td>
                        <td style="padding:var(--space-sm) var(--space-md);font-weight:600;">${p.web_name}</td>
                        <td style="padding:var(--space-sm) var(--space-md);">${team?.short_name || '???'}</td>
                        <td style="padding:var(--space-sm) var(--space-md);text-align:center;">
                            <span style="display:inline-flex;padding:2px 8px;border-radius:var(--radius-pill);font-size:0.6875rem;font-weight:700;background:${posColors[p.element_type]}20;color:${posColors[p.element_type]};">${posNames[p.element_type]}</span>
                        </td>
                        <td style="padding:var(--space-sm) var(--space-md);text-align:right;">
                            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
                                <span class="mono ${this.getOwnershipClass(parseFloat(p.selected_by_percent))}">${p.selected_by_percent}%</span>
                                <div class="progress" style="height:4px;width:80px;"><div class="progress-bar" style="width:${p.selected_by_percent}%;background:var(--md-sys-color-primary);"></div></div>
                            </div>
                        </td>
                        <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);">£${(p.now_cost / 10).toFixed(1)}m</td>
                        <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${p.total_points}</td>
                    </tr>`;
                }).join('');
            }
        } catch (err) {
            console.error('Ownership render error:', err);
        }
    },

    // ==================== RENDER: ZONES ====================
    async renderZones() {
        try {
            const data = await this.apiFetch(this.API.zoneAnalysis(this.state.selectedGW));
            this.state.zoneData = data;

            if (data.zoneLabels) {
                Object.entries(data.zoneLabels).forEach(([zone, label]) => {
                    const el = document.getElementById(`zone-${zone}`);
                    if (el) el.textContent = label;
                });
            }

            // Zone breakdown
            const breakdownEl = document.getElementById('zone-breakdown-content');
            if (breakdownEl && data.teamAnalysis) {
                const topTeams = data.teamAnalysis.slice(0, 5);
                breakdownEl.innerHTML = topTeams.map(t => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--space-xs) 0;border-bottom:1px solid var(--md-sys-color-outline-variant);">
                        <span style="font-weight:600;font-size:0.875rem;">${t.teamName}</span>
                        <span class="mono" style="font-weight:700;color:var(--md-sys-color-primary);">${(t.totalXG || 0).toFixed(1)} xGI</span>
                    </div>
                `).join('');
            }
        } catch (err) {
            console.error('Zones render error:', err);
        }
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
        document.querySelectorAll('#content-ownership .tabs .tab').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        document.getElementById('tab-content-ownership').style.display = tab === 'ownership' ? 'block' : 'none';
        document.getElementById('tab-content-transfers-in').style.display = tab === 'transfers-in' ? 'block' : 'none';
        document.getElementById('tab-content-transfers-out').style.display = tab === 'transfers-out' ? 'block' : 'none';
        // Render appropriate data for transfers tabs
        if (tab === 'transfers-in') this.renderTransfersIn();
        if (tab === 'transfers-out') this.renderTransfersOut();
    },

    switchZoneView(view, el) {
        document.querySelectorAll('#content-zones .tabs .tab').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
    },

    renderTransfersIn() {
        const container = document.getElementById('tab-content-transfers-in');
        if (!container) return;
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) return;
        const players = [...bootstrap.elements]
            .sort((a, b) => (b.transfers_in_event || 0) - (a.transfers_in_event || 0))
            .slice(0, 30);
        const posColors = { 1: '#FFD700', 2: '#4FC3F7', 3: '#81C784', 4: '#E57373' };
        const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        container.innerHTML = `<div class="card"><div class="table-container"><table style="width:100%;border-collapse:collapse;font-size:0.8125rem;"><thead><tr style="border-bottom:2px solid var(--md-sys-color-outline-variant);background:var(--md-sys-color-surface-container-high);">
            <th style="padding:var(--space-sm) var(--space-md);text-align:left;">#</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:left;">Player</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:left;">Team</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:center;">Pos</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:right;">Transfers In</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:right;">Price</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:right;">Points</th>
        </tr></thead><tbody>${players.map((p, i) => {
            const team = bootstrap.teams.find(t => t.id === p.team);
            return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <td style="padding:var(--space-sm) var(--space-md);">${i + 1}</td>
                <td style="padding:var(--space-sm) var(--space-md);font-weight:600;">${p.web_name}</td>
                <td style="padding:var(--space-sm) var(--space-md);">${team?.short_name || '???'}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;"><span style="padding:2px 8px;border-radius:var(--radius-pill);font-size:0.6875rem;font-weight:700;background:${posColors[p.element_type]}20;color:${posColors[p.element_type]};">${posNames[p.element_type]}</span></td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">+${this.formatNumber(p.transfers_in_event || 0)}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);">£${(p.now_cost / 10).toFixed(1)}m</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);">${p.total_points}</td>
            </tr>`;
        }).join('')}</tbody></table></div></div>`;
    },

    renderTransfersOut() {
        const container = document.getElementById('tab-content-transfers-out');
        if (!container) return;
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) return;
        const players = [...bootstrap.elements]
            .sort((a, b) => (b.transfers_out_event || 0) - (a.transfers_out_event || 0))
            .slice(0, 30);
        const posColors = { 1: '#FFD700', 2: '#4FC3F7', 3: '#81C784', 4: '#E57373' };
        const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        container.innerHTML = `<div class="card"><div class="table-container"><table style="width:100%;border-collapse:collapse;font-size:0.8125rem;"><thead><tr style="border-bottom:2px solid var(--md-sys-color-outline-variant);background:var(--md-sys-color-surface-container-high);">
            <th style="padding:var(--space-sm) var(--space-md);text-align:left;">#</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:left;">Player</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:left;">Team</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:center;">Pos</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:right;">Transfers Out</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:right;">Price</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:right;">Points</th>
        </tr></thead><tbody>${players.map((p, i) => {
            const team = bootstrap.teams.find(t => t.id === p.team);
            return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <td style="padding:var(--space-sm) var(--space-md);">${i + 1}</td>
                <td style="padding:var(--space-sm) var(--space-md);font-weight:600;">${p.web_name}</td>
                <td style="padding:var(--space-sm) var(--space-md);">${team?.short_name || '???'}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;"><span style="padding:2px 8px;border-radius:var(--radius-pill);font-size:0.6875rem;font-weight:700;background:${posColors[p.element_type]}20;color:${posColors[p.element_type]};">${posNames[p.element_type]}</span></td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-error);">-${this.formatNumber(p.transfers_out_event || 0)}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);">£${(p.now_cost / 10).toFixed(1)}m</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:right;font-family:var(--font-mono);">${p.total_points}</td>
            </tr>`;
        }).join('')}</tbody></table></div></div>`;
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
                    <small style="color:var(--md-sys-color-on-surface-variant);">Find your Manager ID in the URL when viewing your team.</small>
                </div>
                <div class="input-group mb-md">
                    <label class="input-label">League ID</label>
                    <div style="display:flex;gap:8px;">
                        <input type="number" class="input" id="settings-league-id" placeholder="Enter your League ID" value="${this.state.leagueId || ''}">
                        <button class="btn btn-primary" onclick="FPL.updateLeagueId()">Save</button>
                    </div>
                    <small style="color:var(--md-sys-color-on-surface-variant);">Classic League ID for standings view.</small>
                </div>
                <div class="divider"></div>
                <div class="flex items-center justify-between">
                    <span>Clear saved data</span>
                    <button class="btn btn-outline" onclick="FPL.clearData()" style="border-color:var(--md-sys-color-error);color:var(--md-sys-color-error);">Clear Data</button>
                </div>
            </div>
        </div>`;
    },

    updateLeagueId() {
        const input = document.getElementById('settings-league-id');
        const id = input?.value?.trim();
        if (!id) return;
        this.state.leagueId = id;
        localStorage.setItem('fplLeagueId', id);
        this.loadLeagueData();
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
