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
        ownershipTrends: '/api/ownership/trends',
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
            case 'general': this.renderGeneral(); break;
            case 'players': this.renderPlayers(); break;
            case 'league': this.renderLeague(); break;
            case 'fixtures': this.renderFixtures(); break;
            case 'captain': this.renderCaptaincy(); break;
            case 'ownership': this.renderOwnership(); break;
            case 'zones': this.renderZones(); break;
            case 'manager': this.renderTeamAnalysis(); break;
        }
    },

    // ==================== RENDER: DASHBOARD (GENERAL) ====================
    async renderGeneral() {
        try {
            const data = await this.apiFetch('/api/dashboard/overview');
            this.state.dashboardData = data;

            const gwNumEl = document.getElementById('dash-gw-num');
            if (gwNumEl) gwNumEl.textContent = data.gw || '24';
            const gwAvgEl = document.getElementById('dash-gw-avg');
            if (gwAvgEl) gwAvgEl.innerHTML = `${data.gwAverage || 42}<span style="font-size:14px;color:#8ba396;margin-left:4px;font-weight:400;">pts</span>`;
            const highestEl = document.getElementById('dash-highest-score');
            if (highestEl) highestEl.innerHTML = `${data.highestScore || 118}<span style="font-size:14px;color:#8ba396;margin-left:4px;font-weight:400;">pts</span>`;
            const transfersEl = document.getElementById('dash-total-transfers');
            if (transfersEl) transfersEl.textContent = data.totalTransfers || '3.4M';

            const fdrColors = {
                1: 'background:#00FF85;color:#0a0f0d;',
                2: 'background:#37DB59;color:#0a0f0d;',
                3: 'background:#E1E1E1;color:#0a0f0d;',
                4: 'background:#FFA600;color:#0a0f0d;',
                5: 'background:#FF005A;color:#dfe4e0;'
            };

            const mostSelectedTbody = document.getElementById('dash-most-selected-tbody');
            if (mostSelectedTbody && data.mostSelected) {
                mostSelectedTbody.innerHTML = data.mostSelected.map((p, idx) => {
                    const barColor = idx === 0 ? '#00FF85' : idx === 1 ? '#00FF85' : idx === 2 ? '#E1E1E1' : idx === 3 ? '#FFA600' : '#FF005A';
                    return `<tr style="border-bottom:1px solid #1A2E28;transition:background 0.2s;cursor:pointer;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'" onclick="FPL.filterPlayers('${p.pos}')">
                        <td style="padding:10px 16px;display:flex;align-items:center;gap:12px;">
                            <div style="width:4px;height:28px;border-radius:999px;background:${barColor};"></div>
                            <div style="width:36px;height:36px;border-radius:50%;background:#1c211e;border:1px solid #1A2E28;overflow:hidden;flex-shrink:0;">
                                <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                            </div>
                            <div>
                                <div style="font-weight:700;color:#ffffff;font-size:14px;">${p.name}</div>
                                <div class="mono" style="font-size:11px;color:#8ba396;">${p.team} • ${p.pos}</div>
                            </div>
                        </td>
                        <td style="padding:10px 12px;text-align:right;font-weight:600;color:#dfe4e0;font-family:var(--font-mono);font-size:13px;">${p.selectedBy}</td>
                        <td style="padding:10px 16px;text-align:right;font-weight:700;color:#00ff85;font-family:var(--font-mono);font-size:14px;">${p.ppg}</td>
                    </tr>`;
                }).join('');
            }

            const fdrHeaderRow = document.getElementById('dash-fdr-header-row');
            if (fdrHeaderRow && data.nextGWs) {
                fdrHeaderRow.innerHTML = `<th style="padding:8px 16px;text-align:left;width:20%;color:#8ba396;">Team</th>` +
                    data.nextGWs.map(gw => `<th style="padding:8px;text-align:center;color:#8ba396;">GW${gw}</th>`).join('');
            }

            const fdrTbody = document.getElementById('dash-fdr-tbody');
            if (fdrTbody && data.fdrGrid) {
                fdrTbody.innerHTML = data.fdrGrid.map(row => `
                    <tr style="border-bottom:1px solid #1A2E28;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                        <td style="padding:10px 16px;text-align:left;font-weight:700;color:#ffffff;font-size:14px;font-family:var(--font-mono);">${row.team}</td>
                        ${row.fixtures.map(f => {
                            if (Array.isArray(f)) {
                                return `<td style="padding:4px;"><div style="display:flex;flex-direction:column;gap:2px;">${f.map(item => `<div class="mono" style="font-size:11px;font-weight:700;padding:3px 4px;border-radius:4px;${fdrColors[item.fdr] || fdrColors[3]}">${item.label}</div>`).join('')}</div></td>`;
                            }
                            const styleStr = fdrColors[f.fdr] || fdrColors[3];
                            return `<td style="padding:4px;">
                                <div class="mono" style="font-size:11px;font-weight:700;padding:6px 8px;border-radius:4px;display:inline-block;width:100%;${styleStr}">${f.label}</div>
                            </td>`;
                        }).join('')}
                    </tr>
                `).join('');
            }

            const transfersInContainer = document.getElementById('dash-transfers-in-list');
            if (transfersInContainer && data.topTransfersIn) {
                transfersInContainer.innerHTML = data.topTransfersIn.map(p => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
                        <div style="display:flex;align-items:center;gap:10px;">
                            <div style="width:32px;height:32px;border-radius:50%;background:#1c211e;border:1px solid #1A2E28;overflow:hidden;flex-shrink:0;">
                                <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                            </div>
                            <div>
                                <div style="font-size:13px;font-weight:700;color:#ffffff;">${p.name}</div>
                                <div class="mono" style="font-size:10px;color:#8ba396;">${p.team} • ${p.pos}</div>
                            </div>
                        </div>
                        <div class="mono" style="font-size:13px;font-weight:700;color:#00ff85;">${p.transfersCount}</div>
                    </div>
                `).join('');
            }

            const priceChangesContainer = document.getElementById('dash-price-changes-list');
            if (priceChangesContainer && data.priceChanges) {
                priceChangesContainer.innerHTML = data.priceChanges.map(pc => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">
                        <div>
                            <div style="font-size:13px;font-weight:700;color:#ffffff;">${pc.name}</div>
                            <div class="mono" style="font-size:10px;color:#8ba396;">${pc.team}</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:4px;">
                            <span class="mono" style="font-size:13px;font-weight:700;color:#ffffff;">${pc.price}</span>
                            <span class="material-symbols-outlined" style="font-size:16px;color:${pc.direction === 'up' ? '#00ff85' : '#FF005A'};">${pc.direction === 'up' ? 'arrow_upward' : 'arrow_downward'}</span>
                        </div>
                    </div>
                `).join('');
            }

        } catch (err) {
            console.error('General render error:', err);
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
        const info = m?.managerInfo;
        const team = m?.currentTeam;

        // Top Bento Stats
        const rankEl = document.getElementById('team-overall-rank');
        if (rankEl) rankEl.textContent = info?.overallRanking ? this.formatNumber(info.overallRanking) : '12,450';

        const rankChangeEl = document.getElementById('team-rank-change');
        if (rankChangeEl) rankChangeEl.textContent = info?.rankChange ? '↑ ' + this.formatNumber(info.rankChange) : '↑ 4,200';

        const totalPtsEl = document.getElementById('team-total-points');
        if (totalPtsEl) totalPtsEl.textContent = info?.managerPoints ? this.formatNumber(info.managerPoints) : '1,842';

        const gwSubEl = document.getElementById('team-gw-points-sub');
        if (gwSubEl) gwSubEl.textContent = 'GW: ' + (info?.highestPoints || '64');

        const tmplScoreEl = document.getElementById('team-template-score');
        if (tmplScoreEl) tmplScoreEl.textContent = (info?.templateScore || '84') + '%';

        const tmplBarEl = document.getElementById('team-template-score-bar');
        if (tmplBarEl) tmplBarEl.style.width = Math.min(100, (info?.templateScore || 84)) + '%';

        // Position Breakdown
        if (team && team.length > 0) {
            const posStats = {
                GKP: { pts: 0, topName: '', topPts: 0 },
                DEF: { pts: 0, topName: '', topPts: 0 },
                MID: { pts: 0, topName: '', topPts: 0 },
                FWD: { pts: 0, topName: '', topPts: 0 }
            };

            team.forEach(p => {
                const pos = p.position || 'MID';
                const pts = p.totalPoints || p.points || 0;
                if (!posStats[pos]) posStats[pos] = { pts: 0, topName: '', topPts: 0 };
                posStats[pos].pts += pts;
                if (pts >= posStats[pos].topPts) {
                    posStats[pos].topPts = pts;
                    posStats[pos].topName = p.webName || p.name || 'Player';
                }
            });

            if (document.getElementById('pos-gkp-pts')) document.getElementById('pos-gkp-pts').textContent = posStats.GKP.pts || '142';
            if (document.getElementById('pos-gkp-top')) document.getElementById('pos-gkp-top').textContent = `Top: ${posStats.GKP.topName || 'Raya'} (${posStats.GKP.topPts || 128})`;

            if (document.getElementById('pos-def-pts')) document.getElementById('pos-def-pts').textContent = posStats.DEF.pts || '486';
            if (document.getElementById('pos-def-top')) document.getElementById('pos-def-top').textContent = `Top: ${posStats.DEF.topName || 'Gabriel'} (${posStats.DEF.topPts || 145})`;

            if (document.getElementById('pos-mid-pts')) document.getElementById('pos-mid-pts').textContent = posStats.MID.pts || '892';
            if (document.getElementById('pos-mid-top')) document.getElementById('pos-mid-top').textContent = `Top: ${posStats.MID.topName || 'Palmer'} (${posStats.MID.topPts || 212})`;

            if (document.getElementById('pos-fwd-pts')) document.getElementById('pos-fwd-pts').textContent = posStats.FWD.pts || '322';
            if (document.getElementById('pos-fwd-top')) document.getElementById('pos-fwd-top').textContent = `Top: ${posStats.FWD.topName || 'Haaland'} (${posStats.FWD.topPts || 188})`;
        }

        // Squad Performance Table
        const squadTbody = document.getElementById('squad-performance-tbody');
        if (squadTbody) {
            const playersToRender = (team && team.length > 0) ? team : [
                { name: 'Palmer', points: 212, gwApps: 28, starts: 27, captPts: 48, costStr: '£10.8m', ppg: 7.6 },
                { name: 'Haaland', points: 188, gwApps: 25, starts: 25, captPts: 112, costStr: '£15.4m', ppg: 7.5 }
            ];

            squadTbody.innerHTML = playersToRender.map(p => `
                <tr style="border-bottom:1px solid #16251e;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
                    <td style="padding:14px 20px;display:flex;align-items:center;gap:12px;">
                        <div style="width:28px;height:28px;border-radius:50%;background:#1c2720;border:1px solid #28392e;flex-shrink:0;"></div>
                        <span style="font-weight:700;color:#ffffff;font-size:14px;">${p.webName || p.name}</span>
                    </td>
                    <td style="padding:14px 16px;text-align:center;color:#ffffff;font-family:var(--font-mono);">${p.totalPoints || p.points || 0}</td>
                    <td style="padding:14px 16px;text-align:center;color:#8ba396;font-family:var(--font-mono);">${p.gwApps || 28}</td>
                    <td style="padding:14px 16px;text-align:center;color:#8ba396;font-family:var(--font-mono);">${p.starts || 27}</td>
                    <td style="padding:14px 16px;text-align:center;color:#8ba396;font-family:var(--font-mono);">${p.captPts || 0}</td>
                    <td style="padding:14px 16px;text-align:center;color:#ffffff;font-family:var(--font-mono);">${p.costStr || ('£' + ((p.nowCost || 100) / 10).toFixed(1) + 'm')}</td>
                    <td style="padding:14px 20px;text-align:right;font-weight:700;color:#00FF85;font-family:var(--font-mono);font-size:14px;">${p.ppg || ( (p.totalPoints || p.points || 0) / 28 ).toFixed(1)}</td>
                </tr>
            `).join('');
        }
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
    sortByPlayerMetric(metric) {
        const select = document.getElementById('player-sort');
        if (select) select.value = metric;
        this.renderPlayers();
    },

    renderPlayers() {
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) return;

        const players = bootstrap.elements;
        const teams = bootstrap.teams;
        const tbody = document.getElementById('players-table-body');
        if (!tbody) return;

        // Position Filter
        let filtered = [...players];
        const posFilter = this.state.playerFilter || 'all';
        if (posFilter !== 'all') {
            const posMap = { 'GKP': 1, 'DEF': 2, 'MID': 3, 'FWD': 4 };
            filtered = filtered.filter(p => p.element_type === posMap[posFilter]);
        }

        // Search Filter
        const searchTerm = document.getElementById('player-search')?.value?.toLowerCase();
        if (searchTerm) {
            filtered = filtered.filter(p => p.web_name.toLowerCase().includes(searchTerm) || (p.second_name || '').toLowerCase().includes(searchTerm));
        }

        // Sorting
        const sortVal = document.getElementById('player-sort')?.value || 'pts';
        filtered.sort((a, b) => {
            switch (sortVal) {
                case 'xg':
                    return parseFloat(b.threat || 0) - parseFloat(a.threat || 0);
                case 'xa':
                    return parseFloat(b.creativity || 0) - parseFloat(a.creativity || 0);
                case 'form':
                    return parseFloat(b.form || 0) - parseFloat(a.form || 0);
                case 'defcon':
                    return (5 - parseFloat(b.form || 0)*0.4) - (5 - parseFloat(a.form || 0)*0.4);
                case 'own':
                    return parseFloat(b.selected_by_percent || 0) - parseFloat(a.selected_by_percent || 0);
                case 'ict':
                    return parseFloat(b.ict_index || 0) - parseFloat(a.ict_index || 0);
                case 'pts':
                default:
                    return (b.total_points || 0) - (a.total_points || 0);
            }
        });

        const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

        tbody.innerHTML = filtered.slice(0, 50).map((p, idx) => {
            const team = teams.find(t => t.id === p.team);
            const teamShort = team ? team.short_name : 'FPL';
            const posStr = posNames[p.element_type] || 'DEF';
            const formVal = parseFloat(p.form || 0);
            const xG = (parseFloat(p.threat || 0) / 10).toFixed(1);
            const xA = (parseFloat(p.creativity || 0) / 10).toFixed(1);

            let fdrClass = 'fdr-3';
            if (formVal >= 6.0) fdrClass = 'fdr-1';
            else if (formVal >= 4.5) fdrClass = 'fdr-2';
            else if (formVal >= 3.0) fdrClass = 'fdr-3';
            else if (formVal >= 2.0) fdrClass = 'fdr-4';
            else fdrClass = 'fdr-5';

            const xgColorClass = parseFloat(xG) >= 7.0 ? 'color:var(--fdr-1);font-weight:700;' : parseFloat(xG) >= 4.0 ? 'color:var(--fdr-2);' : parseFloat(xG) >= 2.0 ? 'color:var(--fdr-4);' : '';
            const xaColorClass = parseFloat(xA) >= 5.0 ? 'color:var(--fdr-1);font-weight:700;' : parseFloat(xA) >= 3.0 ? 'color:var(--fdr-2);' : parseFloat(xA) >= 1.5 ? 'color:var(--fdr-4);' : '';

            // DEFCON calculation
            let defconNum = Math.max(1.0, Math.min(5.0, (5.0 - formVal * 0.4))).toFixed(1);
            let defconTier = Math.round(parseFloat(defconNum));
            if (defconTier < 1) defconTier = 1;
            if (defconTier > 5) defconTier = 5;

            // Form (L5) 5 vertical bars representation
            const formBars = [
                formVal >= 5 ? 1 : 2,
                formVal >= 4 ? 2 : 3,
                formVal >= 3 ? 1 : 2,
                formVal >= 2 ? 3 : 4,
                formVal >= 1 ? 1 : 5
            ];

            const isEven = idx % 2 === 1;

            return `
                <tr class="hover:bg-tertiary transition-colors group relative ${isEven ? 'bg-surface-container-highest/30' : ''}" style="border-bottom:1px solid var(--pitch-line);transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='${isEven ? 'rgba(49,54,51,0.3)' : 'transparent'}'">
                    <td class="py-2 px-4 flex items-center gap-3" style="padding:10px 16px;display:flex;align-items:center;gap:12px;position:relative;">
                        <div style="width:4px;position:absolute;left:0;top:0;bottom:0;background:var(--${fdrClass});opacity:0;transition:opacity 0.2s;" class="group-hover:opacity-100"></div>
                        <div style="width:32px;height:32px;border-radius:50%;overflow:hidden;background:var(--md-sys-color-surface);border:1px solid var(--pitch-line);flex-shrink:0;">
                            <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                        </div>
                        <span class="font-headline-md text-sm text-on-surface" style="font-weight:600;font-size:14px;color:var(--md-sys-color-on-surface);">${p.web_name}</span>
                    </td>
                    <td class="py-2 px-4 font-body-sm text-on-surface" style="padding:10px 16px;font-size:14px;color:var(--md-sys-color-on-surface);">${teamShort}</td>
                    <td class="py-2 px-4 font-label-caps text-label-caps text-on-surface-variant" style="padding:10px 16px;font-family:var(--font-mono);font-size:12px;color:var(--md-sys-color-on-surface-variant);">${posStr}</td>
                    <td class="py-2 px-4 font-data-tabular text-data-tabular" style="padding:10px 16px;font-family:var(--font-mono);font-size:14px;color:var(--md-sys-color-on-surface);">£${(p.now_cost / 10).toFixed(1)}</td>
                    <td class="py-2 px-4 font-data-tabular text-data-tabular text-right text-primary-fixed" style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--fdr-1);">${p.total_points}</td>
                    <td class="py-2 px-4 font-data-tabular text-data-tabular text-right" style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-size:14px;${xgColorClass}">${xG}</td>
                    <td class="py-2 px-4 font-data-tabular text-data-tabular text-right" style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-size:14px;${xaColorClass}">${xA}</td>
                    <td class="py-2 px-4 font-data-tabular text-data-tabular text-right" style="padding:10px 16px;text-align:right;font-family:var(--font-mono);font-size:14px;color:var(--md-sys-color-on-surface);">${p.ict_index || '0.0'}</td>
                    <td class="py-2 px-4" style="padding:10px 16px;">
                        <div class="flex items-center justify-center gap-1" style="display:flex;align-items:center;justify-content:center;gap:4px;">
                            <div style="width:6px;height:16px;border-radius:2px;background:var(--fdr-${formBars[0]});"></div>
                            <div style="width:6px;height:16px;border-radius:2px;background:var(--fdr-${formBars[1]});"></div>
                            <div style="width:6px;height:16px;border-radius:2px;background:var(--fdr-${formBars[2]});"></div>
                            <div style="width:6px;height:16px;border-radius:2px;background:var(--fdr-${formBars[3]});"></div>
                            <div style="width:6px;height:16px;border-radius:2px;background:var(--fdr-${formBars[4]});"></div>
                        </div>
                    </td>
                    <td class="py-2 px-4 text-center" style="padding:10px 16px;text-align:center;">
                        <span class="inline-block px-2 py-0.5 rounded font-data-tabular text-[12px]" style="display:inline-block;padding:2px 8px;border-radius:4px;font-family:var(--font-mono);font-size:12px;background:var(--fdr-${defconTier})/20;color:var(--fdr-${defconTier});border:1px solid var(--fdr-${defconTier})/30;">${defconNum}</span>
                    </td>
                </tr>
            `;
        }).join('');
    },

    // ==================== RENDER: LEAGUE STANDINGS ====================
    async renderLeague() {
        const leagueId = this.state.selectedLeagueId || this.state.leagueId || 314;
        const page = this.state.standingsPage || 1;
        
        const tbody = document.getElementById('league-standings-body');
        if (!tbody) return;

        try {
            const data = await this.apiFetch(`/api/leagues-classic/${leagueId}/standings?page=${page}`);
            this.state.standingsData = data;

            // Bento Grid Card 1: League Name & ID
            const nameEl = document.getElementById('standings-league-name');
            if (nameEl) nameEl.textContent = data.leagueName || `League ${leagueId}`;

            const badgeEl = document.getElementById('standings-league-id-badge');
            if (badgeEl) badgeEl.textContent = `ID: ${data.leagueId}`;

            const typeEl = document.getElementById('standings-league-type');
            if (typeEl) typeEl.textContent = data.leagueType || 'Classic League';

            // Bento Grid Card 2: Average Points
            const avgEl = document.getElementById('standings-league-avg');
            if (avgEl) avgEl.textContent = data.leagueAvgGW || 0;

            // Bento Grid Card 3: Top Score
            const topScoreEl = document.getElementById('standings-top-score');
            if (topScoreEl) topScoreEl.textContent = data.topScoreGW || 0;

            const topTeamEl = document.getElementById('standings-top-team');
            if (topTeamEl) topTeamEl.textContent = data.topScorerTeam || data.topScorerManager || 'Leader';

            // Render Table Rows
            const managers = data.managers || [];
            if (managers.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:var(--space-lg);color:var(--md-sys-color-on-surface-variant);">No standings data available.</td></tr>`;
                return;
            }

            tbody.innerHTML = managers.map((m, idx) => {
                const isEven = idx % 2 === 1;
                const rowBg = isEven ? 'background:rgba(255,255,255,0.03);' : '';
                
                let diffArrow = '';
                if (m.rankDiff > 0) {
                    diffArrow = `<div style="display:inline-flex;align-items:center;gap:2px;color:var(--fdr-2);">
                        <span class="material-symbols-outlined" style="font-size:16px;">arrow_upward</span>
                        <span class="mono" style="font-size:0.75rem;font-weight:700;">${m.rankDiff}</span>
                    </div>`;
                } else if (m.rankDiff < 0) {
                    diffArrow = `<div style="display:inline-flex;align-items:center;gap:2px;color:var(--fdr-5);">
                        <span class="material-symbols-outlined" style="font-size:16px;">arrow_downward</span>
                        <span class="mono" style="font-size:0.75rem;font-weight:700;">${Math.abs(m.rankDiff)}</span>
                    </div>`;
                } else {
                    diffArrow = `<div style="display:inline-flex;align-items:center;gap:2px;color:var(--md-sys-color-on-surface-variant);">
                        <span class="material-symbols-outlined" style="font-size:16px;">remove</span>
                        <span class="mono" style="font-size:0.75rem;font-weight:700;">0</span>
                    </div>`;
                }

                const borderTier = m.rank === 1 ? 'fdr-1' : m.rank === 2 ? 'fdr-2' : m.rank === 3 ? 'fdr-3' : m.rank === 4 ? 'fdr-4' : 'fdr-5';

                return `<tr class="data-row" style="border-bottom:1px solid rgba(255,255,255,0.05);transition:background 0.2s;${rowBg}" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='${isEven ? 'rgba(255,255,255,0.03)' : 'transparent'}'">
                    <td class="mono" style="padding:var(--space-md);position:relative;font-weight:700;color:var(--md-sys-color-on-surface);width:60px;">
                        <div style="position:absolute;left:0;top:50%;transform:translateY(-50%);width:4px;height:75%;background:var(--${borderTier});border-radius:0 2px 2px 0;"></div>
                        ${m.rank}
                    </td>
                    <td style="padding:var(--space-md);">
                        <div style="font-weight:700;color:var(--md-sys-color-on-surface);">${m.managerName}</div>
                        <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);margin-top:2px;">${m.entryName}</div>
                    </td>
                    <td class="mono" style="padding:var(--space-md);text-align:right;color:var(--md-sys-color-on-surface);font-weight:600;">${m.eventTotal}</td>
                    <td class="mono" style="padding:var(--space-md);text-align:right;color:var(--fdr-1);font-weight:800;">${this.formatNumber(m.total)}</td>
                    <td style="padding:var(--space-md);text-align:center;">${diffArrow}</td>
                    <td style="padding:var(--space-md);text-align:right;">
                        <span class="mono" style="background:var(--md-sys-color-surface-variant);color:var(--md-sys-color-on-surface);font-size:0.75rem;padding:3px 10px;border-radius:4px;font-weight:700;display:inline-block;">${this.formatNumber(m.diffCount)}</span>
                    </td>
                </tr>`;
            }).join('');

            this.renderStandingsPagination(data);
        } catch (err) {
            console.error('League standings error:', err);
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:var(--space-lg);color:var(--md-sys-color-error);">Failed to load standings: ${err.message}</td></tr>`;
        }
    },

    renderStandingsPagination(data) {
        const page = data.page || 1;
        const totalPages = Math.min(5, data.totalPages || 1);
        const startNum = (page - 1) * 50 + 1;
        const endNum = Math.min(startNum + (data.managers?.length || 0) - 1, 250);
        
        const countEl = document.getElementById('standings-showing-count');
        if (countEl) {
            countEl.textContent = `Showing ${startNum}-${endNum} of ${Math.min(250, data.totalEntries || 250)} Managers`;
        }

        const controlsEl = document.getElementById('standings-pagination-controls');
        if (!controlsEl) return;

        let btnsHTML = '';
        
        const prevDisabled = page === 1;
        btnsHTML += `<button onclick="FPL.changeStandingsPage(${page - 1})" ${prevDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''} style="width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;border:1px solid var(--md-sys-color-outline-variant);background:transparent;color:var(--md-sys-color-on-surface);cursor:pointer;">
            <span class="material-symbols-outlined" style="font-size:18px;">chevron_left</span>
        </button>`;

        for (let p = 1; p <= totalPages; p++) {
            const isActive = p === page;
            btnsHTML += `<button onclick="FPL.changeStandingsPage(${p})" style="width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;border:1px solid ${isActive ? 'var(--fdr-1)' : 'var(--md-sys-color-outline-variant)'};background:${isActive ? 'rgba(0,255,133,0.15)' : 'transparent'};color:${isActive ? 'var(--fdr-1)' : 'var(--md-sys-color-on-surface)'};font-weight:700;font-family:var(--font-mono);cursor:pointer;">${p}</button>`;
        }

        const nextDisabled = page >= totalPages;
        btnsHTML += `<button onclick="FPL.changeStandingsPage(${page + 1})" ${nextDisabled ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''} style="width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;border:1px solid var(--md-sys-color-outline-variant);background:transparent;color:var(--md-sys-color-on-surface);cursor:pointer;">
            <span class="material-symbols-outlined" style="font-size:18px;">chevron_right</span>
        </button>`;

        controlsEl.innerHTML = btnsHTML;
    },

    changeStandingsPage(p) {
        if (p < 1 || p > 5) return;
        this.state.standingsPage = p;
        this.renderLeague();
    },

    switchLeague(leagueId) {
        if (!leagueId) return;
        this.state.selectedLeagueId = leagueId;
        this.state.standingsPage = 1;
        this.renderLeague();
    },

    loadCustomLeague() {
        const input = document.getElementById('league-id-input');
        const val = input?.value?.trim();
        if (!val || isNaN(val)) return;
        this.switchLeague(parseInt(val));
    },

    // ==================== RENDER: FIXTURES ====================
    setFixtureLookahead(n) {
        this.state.fixtureLookahead = n;
        ['3', '5', '10'].forEach(val => {
            const btn = document.getElementById(`lookahead-${val}`);
            if (btn) {
                if (parseInt(val) === n) {
                    btn.style.background = 'var(--md-sys-color-secondary-container)';
                    btn.style.color = 'var(--md-sys-color-on-secondary-container)';
                    btn.style.fontWeight = '700';
                } else {
                    btn.style.background = 'transparent';
                    btn.style.color = 'var(--md-sys-color-on-surface-variant)';
                    btn.style.fontWeight = '400';
                }
            }
        });
        this.renderFixtures();
    },

    renderFixtures() {
        const fixtures = this.state.fixtures;
        const bootstrap = this.state.bootstrapData;
        if (!fixtures || !bootstrap) return;

        const lookaheadCount = this.state.fixtureLookahead || 5;
        const currentGW = this.state.selectedGW || bootstrap.events?.find(e => e.is_current)?.id || 1;
        const teams = bootstrap.teams || [];
        const elements = bootstrap.elements || [];

        // Dynamic Gameweeks header
        const targetGWs = [];
        for (let g = currentGW; g < Math.min(39, currentGW + lookaheadCount); g++) {
            targetGWs.push(g);
        }

        const headerRow = document.getElementById('fixture-grid-header-row');
        if (headerRow) {
            headerRow.style.background = '#a7cfbc';
            headerRow.innerHTML = `<th class="p-3 font-label-caps text-label-caps uppercase sticky left-0 z-10 bg-secondary" style="padding:12px 16px;position:sticky;left:0;z-index:10;background:#a7cfbc;width:100px;font-family:var(--font-mono);font-size:12px;color:#0a0f0d;font-weight:700;">TEAM</th>` +
                targetGWs.map(gw => `<th class="p-3 font-label-caps text-label-caps text-center" style="padding:12px 16px;text-align:center;font-family:var(--font-mono);font-size:12px;color:#0a0f0d;font-weight:700;background:#a7cfbc;"><span style="color:#0a0f0d;font-weight:700;">GW${gw}</span></th>`).join('');
        }

        // Render Table Rows for all 20 teams
        const tbody = document.getElementById('fixture-grid-table-body');
        if (tbody) {
            const fdrColors = {
                1: { bg: '#00FF85', text: '#0a0f0d' },
                2: { bg: '#37DB59', text: '#0a0f0d' },
                3: { bg: '#E1E1E1', text: '#0a0f0d' },
                4: { bg: '#FFA600', text: '#0a0f0d' },
                5: { bg: '#FF005A', text: '#dfe4e0' }
            };

            tbody.innerHTML = teams.map((team, idx) => {
                const isEven = idx % 2 === 1;
                let cellHTMLs = targetGWs.map(gw => {
                    // Find fixture for this team in this GW
                    const fx = fixtures.find(f => f.event === gw && (f.team_h === team.id || f.team_a === team.id));
                    if (!fx) {
                        return `<td class="p-1" style="padding:4px;"><div class="bg-surface-variant rounded-lg p-2 flex flex-col items-center justify-center border border-pitch-line h-14 opacity-50" style="background:#313633;border-radius:8px;padding:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;height:56px;opacity:0.5;"><span class="font-bold text-sm uppercase text-on-surface-variant" style="font-size:12px;font-family:var(--font-mono);color:#b9cbb9;">BLANK</span></div></td>`;
                    }
                    const isHome = fx.team_h === team.id;
                    const oppId = isHome ? fx.team_a : fx.team_h;
                    const oppTeam = teams.find(t => t.id === oppId);
                    const oppShort = oppTeam ? oppTeam.short_name : 'TBD';
                    const diff = isHome ? (fx.team_h_difficulty || fx.difficulty || 3) : (fx.team_a_difficulty || fx.difficulty || 3);
                    const venueStr = isHome ? 'H' : 'A';
                    const colStyle = fdrColors[diff] || fdrColors[3];

                    return `<td class="p-1" style="padding:4px;">
                        <div class="rounded-lg p-2 flex flex-col items-center justify-center border border-black/10 h-14" style="background:${colStyle.bg};border-radius:8px;padding:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;height:56px;">
                            <span class="font-bold text-sm uppercase" style="font-size:13px;font-weight:700;font-family:var(--font-mono);color:${colStyle.text}">${oppShort} (${venueStr})</span>
                        </div>
                    </td>`;
                }).join('');

                const avgFDR = Math.round(targetGWs.reduce((acc, gw) => {
                    const fx = fixtures.find(f => f.event === gw && (f.team_h === team.id || f.team_a === team.id));
                    if (!fx) return acc + 3;
                    return acc + (fx.team_h === team.id ? (fx.team_h_difficulty || 3) : (fx.team_a_difficulty || 3));
                }, 0) / targetGWs.length);

                const teamAccentColor = fdrColors[avgFDR]?.bg || '#37DB59';

                return `<tr class="border-b border-pitch-line data-table-row transition-colors" style="border-bottom:1px solid #1A2E28;background:${isEven ? '#181d1a' : '#0f1412'};">
                    <td class="p-3 font-bold sticky left-0 z-10 flex items-center gap-3 text-fdr-1 text-primary-fixed" style="padding:10px 16px;position:sticky;left:0;z-index:10;background:${isEven ? '#181d1a' : '#0f1412'};display:flex;align-items:center;gap:12px;font-family:var(--font-mono);font-size:14px;font-weight:700;color:#00ff85;">
                        <div style="width:4px;height:24px;background:${teamAccentColor};border-radius:999px;"></div>
                        ${team.short_name}
                    </td>
                    ${cellHTMLs}
                </tr>`;
            }).join('');
        }

        // Sidebar: Form Leaders (Upcoming)
        const formLeadersContainer = document.getElementById('form-leaders-list');
        if (formLeadersContainer) {
            const sortedByForm = [...elements].sort((a, b) => parseFloat(b.form || 0) - parseFloat(a.form || 0)).slice(0, 5);
            formLeadersContainer.innerHTML = sortedByForm.map(p => {
                const team = teams.find(t => t.id === p.team);
                const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
                const posStr = posNames[p.element_type] || 'MID';

                return `<div class="flex items-center gap-3 p-3 rounded-lg bg-surface border border-pitch-line hover:border-fdr-1 transition-colors cursor-pointer group" style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;background:var(--md-sys-color-surface);border:1px solid var(--pitch-line);" onclick="FPL.navigateTo('players')">
                    <div style="width:40px;height:40px;border-radius:50%;overflow:hidden;background:var(--md-sys-color-surface-variant);border:1px solid var(--pitch-line);position:relative;flex-shrink:0;">
                        <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                        <div style="position:absolute;bottom:0;right:0;width:10px;height:10px;background:var(--fdr-1);border-radius:50%;border:1px solid var(--md-sys-color-surface);"></div>
                    </div>
                    <div style="flex:1;">
                        <p style="margin:0;font-weight:700;font-size:14px;color:var(--fdr-1);line-height:1.2;">${p.web_name}</p>
                        <p style="margin:2px 0 0 0;font-family:var(--font-mono);font-size:11px;color:var(--md-sys-color-on-surface-variant);">${team?.short_name || 'FPL'} • ${posStr}</p>
                    </div>
                    <div style="text-align:right;">
                        <p style="margin:0;font-family:var(--font-mono);font-size:15px;font-weight:700;color:var(--md-sys-color-primary);">${p.form}</p>
                        <p style="margin:2px 0 0 0;font-family:var(--font-mono);font-size:10px;color:var(--md-sys-color-on-surface-variant);">Form</p>
                    </div>
                </div>`;
            }).join('');
        }
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

    // ==================== RENDER: CAPTAINCY MATRIX ====================
    async renderCaptaincy() {
        try {
            const data = await this.apiFetch('/api/captaincy/matrix');
            
            // Header model update badge
            const modelUpdatedEl = document.getElementById('cap-model-updated');
            if (modelUpdatedEl && data.modelUpdated) {
                modelUpdatedEl.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px;color:var(--fdr-1);">update</span> <span>Model Updated: ${data.modelUpdated}</span>`;
            }

            // Hero Model Pick Card
            if (data.modelPick) {
                const mp = data.modelPick;
                const heroImg = document.getElementById('cap-hero-img');
                if (heroImg) heroImg.src = `https://resources.premierleague.com/premierleague/photos/players/110x140/p${mp.code}.png`;
                
                const heroName = document.getElementById('cap-hero-name');
                if (heroName) heroName.textContent = mp.name;

                const heroTeamPos = document.getElementById('cap-hero-team-pos');
                if (heroTeamPos) heroTeamPos.textContent = `${mp.team} (${mp.position})`;

                const heroDesc = document.getElementById('cap-hero-desc');
                if (heroDesc) heroDesc.textContent = mp.description || 'Unprecedented underlying stats against a vulnerable defense. High captaincy ownership expected.';

                const heroXpts = document.getElementById('cap-hero-xpts');
                if (heroXpts) heroXpts.textContent = mp.xPTS;

                const heroOpp = document.getElementById('cap-hero-opp');
                if (heroOpp) heroOpp.textContent = mp.opp;

                const heroFdr = document.getElementById('cap-hero-fdr');
                if (heroFdr) heroFdr.style.background = `var(--fdr-${mp.fdr})`;

                const heroXgi = document.getElementById('cap-hero-xgi');
                if (heroXgi) heroXgi.textContent = mp.xGI;
            }

            // Differential Card
            if (data.differentialPick) {
                const diff = data.differentialPick;
                const diffName = document.getElementById('cap-diff-name');
                if (diffName) diffName.textContent = diff.name;

                const diffTeam = document.getElementById('cap-diff-team');
                if (diffTeam) diffTeam.textContent = `${diff.team} (${diff.position})`;

                const diffXpts = document.getElementById('cap-diff-xpts');
                if (diffXpts) diffXpts.textContent = `${diff.xPTS} xPts`;
            }

            // Form Warning Card
            if (data.formWarning) {
                const warn = data.formWarning;
                const warnName = document.getElementById('cap-warn-name');
                if (warnName) warnName.textContent = warn.name;

                const warnTeam = document.getElementById('cap-warn-team');
                if (warnTeam) warnTeam.textContent = `${warn.team} (${warn.position})`;

                const warnReason = document.getElementById('cap-warn-reason');
                if (warnReason) warnReason.textContent = warn.reason || 'xG Underperf.';
            }

            // Table Title
            const tableTitle = document.getElementById('cap-table-title');
            if (tableTitle && data.gameweek) {
                tableTitle.textContent = `Top 15 Captain Picks (GW${data.gameweek})`;
            }

            // Table Rows
            const tbody = document.getElementById('captain-picks-body');
            if (!tbody) return;

            const picks = data.topPicks || [];
            if (picks.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:var(--space-lg);">No captain picks available.</td></tr>`;
                return;
            }

            tbody.innerHTML = picks.map((p) => {
                const badgeIcon = p.badge === 'differential' 
                    ? `<span class="material-symbols-outlined text-fdr-4" style="font-size:14px;color:#FFA600;margin-left:4px;" title="Differential Pick">trending_up</span>`
                    : p.badge === 'warning'
                    ? `<span class="material-symbols-outlined text-fdr-5" style="font-size:14px;color:#FF005A;margin-left:4px;" title="Form Warning">warning</span>`
                    : '';

                const rowBg = p.badge === 'differential' ? 'background:rgba(255,255,255,0.03);' : p.badge === 'warning' ? 'opacity:0.85;' : '';
                const rankColor = p.rk === 1 ? 'color:var(--fdr-1);font-size:1.125rem;' : p.rk <= 3 ? 'color:var(--md-sys-color-primary);font-size:1rem;' : 'color:var(--md-sys-color-on-surface);';

                return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);transition:background 0.2s;${rowBg}" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='${rowBg ? 'rgba(255,255,255,0.03)' : 'transparent'}'">
                    <td class="mono" style="padding:var(--space-sm) var(--space-md);text-align:center;border-left:4px solid var(--${p.borderTier});font-weight:700;">${p.rk}</td>
                    <td style="padding:var(--space-sm) var(--space-md);">
                        <div style="display:flex;align-items:center;gap:12px;">
                            <div style="width:36px;height:36px;border-radius:50%;overflow:hidden;background:var(--md-sys-color-surface);flex-shrink:0;border:1px solid var(--md-sys-color-outline-variant);">
                                <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                            </div>
                            <div>
                                <div style="font-weight:600;color:var(--md-sys-color-on-surface);display:flex;align-items:center;">
                                    ${p.name} ${badgeIcon}
                                </div>
                                <div class="mono" style="font-size:0.6875rem;color:var(--md-sys-color-on-surface-variant);">${p.team} (${p.position})</div>
                            </div>
                        </div>
                    </td>
                    <td class="mono" style="padding:var(--space-sm) var(--space-md);text-align:center;font-weight:500;">${p.opp}</td>
                    <td style="padding:var(--space-sm) var(--space-md);text-align:center;">
                        <span class="mono" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:4px;background:var(--fdr-${p.fdr});color:#0a0f0d;font-size:0.75rem;font-weight:800;">${p.fdr}</span>
                    </td>
                    <td class="mono" style="padding:var(--space-sm) var(--space-md);text-align:center;font-weight:600;color:var(--fdr-1);">${p.form}</td>
                    <td class="mono" style="padding:var(--space-sm) var(--space-md);text-align:center;font-weight:600;color:#00D1FF;">${p.xGI}</td>
                    <td class="mono" style="padding:var(--space-sm) var(--space-md);text-align:center;font-weight:800;${rankColor}">${p.xPTS}</td>
                </tr>`;
            }).join('');
        } catch (err) {
            console.error('Captaincy matrix render error:', err);
            const tbody = document.getElementById('captain-picks-body');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:var(--space-lg);color:var(--md-sys-color-error);">Failed to load captaincy matrix: ${err.message}</td></tr>`;
            }
        }
    },

    // ==================== RENDER: OWNERSHIP ====================
    // ==================== RENDER: OWNERSHIP TRENDS ====================
    async renderOwnership() {
        try {
            const data = await this.apiFetch(this.API.ownershipTrends);
            this.state.ownershipTrends = data;

            // Update last snapshot time display
            const lastSnapEl = document.getElementById('own-last-snapshot');
            if (lastSnapEl) lastSnapEl.textContent = data.lastSnapshotTime || 'Just now';

            // Render Bento Grid Cards
            this.renderOwnershipBento(data);

            // Render Table
            this.renderOwnershipTable();
        } catch (err) {
            console.error('Ownership trends render error:', err);
            const tbody = document.getElementById('ownership-trends-table-body');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:var(--space-lg);color:var(--md-sys-color-error);">Failed to load ownership trend data: ${err.message}</td></tr>`;
            }
        }
    },

    renderOwnershipBento(data) {
        const inContainer = document.getElementById('bento-in-content');
        const outContainer = document.getElementById('bento-out-content');
        const velContainer = document.getElementById('bento-velocity-content');

        const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };

        // 1. Transferred In
        if (inContainer && data.topTransferredIn) {
            const p = data.topTransferredIn;
            const ownDeltaClass = p.delta24h >= 0 ? 'color:var(--fdr-1);' : 'color:var(--fdr-5);';
            const deltaSign = p.delta24h >= 0 ? '+' : '';
            const sparklineSVG = this.generateSparklineSVG(p.sparkline, p.delta24h >= 0, 100, 32);

            inContainer.innerHTML = `
                <div style="display:flex;align-items:center;gap:var(--space-md);">
                    <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--fdr-1);background:var(--md-sys-color-surface-container-high);">
                    <div>
                        <div style="font-weight:700;font-size:0.9375rem;display:flex;align-items:center;gap:6px;">
                            ${p.name}
                            <span style="padding:1px 6px;border-radius:var(--radius-pill);font-size:0.625rem;font-weight:700;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                        </div>
                        <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">${p.team} • ${p.costStr}</div>
                        <div class="mono" style="font-size:0.8125rem;font-weight:700;color:var(--fdr-1);margin-top:2px;">+${this.formatNumber(p.netTransfers)} net</div>
                    </div>
                </div>
                <div style="text-align:right;">
                    <div class="mono" style="font-size:1.125rem;font-weight:800;${ownDeltaClass}">${p.ownership}%</div>
                    <div class="mono" style="font-size:0.75rem;font-weight:600;${ownDeltaClass}">${deltaSign}${p.delta24h}% (24h)</div>
                    <div style="margin-top:4px;">${sparklineSVG}</div>
                </div>`;
        }

        // 2. Transferred Out
        if (outContainer && data.topTransferredOut) {
            const p = data.topTransferredOut;
            const ownDeltaClass = p.delta24h >= 0 ? 'color:var(--fdr-1);' : 'color:var(--fdr-5);';
            const deltaSign = p.delta24h >= 0 ? '+' : '';
            const sparklineSVG = this.generateSparklineSVG(p.sparkline, p.delta24h >= 0, 100, 32);

            outContainer.innerHTML = `
                <div style="display:flex;align-items:center;gap:var(--space-md);">
                    <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--fdr-5);background:var(--md-sys-color-surface-container-high);">
                    <div>
                        <div style="font-weight:700;font-size:0.9375rem;display:flex;align-items:center;gap:6px;">
                            ${p.name}
                            <span style="padding:1px 6px;border-radius:var(--radius-pill);font-size:0.625rem;font-weight:700;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                        </div>
                        <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">${p.team} • ${p.costStr}</div>
                        <div class="mono" style="font-size:0.8125rem;font-weight:700;color:var(--fdr-5);margin-top:2px;">${this.formatNumber(p.netTransfers)} net</div>
                    </div>
                </div>
                <div style="text-align:right;">
                    <div class="mono" style="font-size:1.125rem;font-weight:800;${ownDeltaClass}">${p.ownership}%</div>
                    <div class="mono" style="font-size:0.75rem;font-weight:600;${ownDeltaClass}">${deltaSign}${p.delta24h}% (24h)</div>
                    <div style="margin-top:4px;">${sparklineSVG}</div>
                </div>`;
        }

        // 3. Highest Velocity Shift
        if (velContainer && data.highestVelocity) {
            const p = data.highestVelocity;
            const velSign = p.velocityShift >= 0 ? '+' : '';
            const sparklineSVG = this.generateSparklineSVG(p.sparkline, p.velocityShift >= 0, 100, 32);

            velContainer.innerHTML = `
                <div style="display:flex;align-items:center;gap:var(--space-md);">
                    <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--fdr-4);background:var(--md-sys-color-surface-container-high);">
                    <div>
                        <div style="font-weight:700;font-size:0.9375rem;display:flex;align-items:center;gap:6px;">
                            ${p.name}
                            <span style="padding:1px 6px;border-radius:var(--radius-pill);font-size:0.625rem;font-weight:700;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                        </div>
                        <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">${p.team} • ${p.costStr}</div>
                        <div class="mono" style="font-size:0.8125rem;font-weight:700;color:var(--fdr-4);margin-top:2px;">${velSign}${p.velocityShift}% Δ (7d vs 24h)</div>
                    </div>
                </div>
                <div style="text-align:right;">
                    <div class="mono" style="font-size:1.125rem;font-weight:800;color:var(--md-sys-color-primary);">${p.ownership}%</div>
                    <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Own %</div>
                    <div style="margin-top:4px;">${sparklineSVG}</div>
                </div>`;
        }
    },

    renderOwnershipTable() {
        const data = this.state.ownershipTrends;
        if (!data || !data.players) return;

        const tbody = document.getElementById('ownership-trends-table-body');
        if (!tbody) return;

        let players = [...data.players];

        // Apply position filter
        const posFilter = this.state.ownPosFilter || 'all';
        if (posFilter !== 'all') {
            players = players.filter(p => p.position === posFilter);
        }

        // Apply search query
        const searchInput = document.getElementById('own-search')?.value?.toLowerCase();
        if (searchInput) {
            players = players.filter(p => p.name.toLowerCase().includes(searchInput) || (p.teamFull || '').toLowerCase().includes(searchInput));
        }

        // Apply sort selection
        const sortKey = document.getElementById('own-sort')?.value || 'ownership';
        players.sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));

        const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };

        if (players.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:var(--space-lg);color:var(--md-sys-color-on-surface-variant);">No players match the selected filters.</td></tr>`;
            return;
        }

        tbody.innerHTML = players.map((p, i) => {
            const formatDelta = (val) => {
                const sign = val > 0 ? '+' : '';
                const bg = val > 0 ? 'background:rgba(0,255,133,0.12);color:var(--fdr-1);' :
                           val < 0 ? 'background:rgba(255,0,90,0.12);color:var(--fdr-5);' :
                           'background:var(--md-sys-color-surface-container-high);color:var(--md-sys-color-on-surface-variant);';
                return `<span class="mono" style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--radius-pill);font-size:0.75rem;font-weight:700;${bg}">${sign}${val.toFixed(2)}%</span>`;
            };

            const sparklineSVG = this.generateSparklineSVG(p.sparkline, p.delta24h >= 0, 110, 24);

            return `
            <tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);transition:background var(--transition-fast);">
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;color:var(--md-sys-color-on-surface-variant);">${i + 1}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;">
                    <div style="display:inline-flex;align-items:center;gap:var(--space-sm);text-align:left;">
                        <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" onerror="this.src='football.ico'" style="width:32px;height:32px;border-radius:50%;object-fit:cover;background:var(--md-sys-color-surface-container-high);">
                        <div>
                            <div style="font-weight:600;font-size:0.875rem;">${p.name}</div>
                            <div style="display:flex;align-items:center;gap:4px;font-size:0.6875rem;color:var(--md-sys-color-on-surface-variant);">
                                <span style="font-weight:600;">${p.team}</span> • 
                                <span style="padding:0 4px;border-radius:2px;font-weight:700;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                            </div>
                        </div>
                    </div>
                </td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);font-weight:600;">${p.costStr}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;">
                    <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
                        <span class="mono" style="font-weight:700;color:var(--md-sys-color-on-surface);">${p.ownership}%</span>
                        <div style="height:3px;width:70px;background:var(--md-sys-color-surface-container-high);border-radius:2px;overflow:hidden;">
                            <div style="height:100%;width:${Math.min(p.ownership, 100)}%;background:var(--md-sys-color-primary);"></div>
                        </div>
                    </div>
                </td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;">${formatDelta(p.delta24h)}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;">${formatDelta(p.delta3d)}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;">${formatDelta(p.delta7d)}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;">${sparklineSVG}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">${p.points}</td>
            </tr>`;
        }).join('');
    },

    filterOwnershipPos(pos, el) {
        this.state.ownPosFilter = pos;
        document.querySelectorAll('.own-pos-btn').forEach(t => t.classList.remove('active'));
        if (el) el.classList.add('active');
        this.renderOwnershipTable();
    },

    async takeOwnershipSnapshot() {
        const btn = document.getElementById('btn-take-snapshot');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner" style="width:16px;height:16px;border-width:2px;margin:0;"></span> Capturing...`;
        }

        try {
            const res = await window.fetch('/api/ownership/snapshot', { method: 'POST' });
            const data = await res.json();
            if (data.skipped) {
                this.showError('Snapshot recently captured (< 1h ago)');
            } else {
                this.showError('New ownership snapshot saved to Neon DB!');
            }
            await this.renderOwnership();
        } catch (err) {
            console.error('Take snapshot error:', err);
            this.showError('Failed to capture snapshot');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">photo_camera</span> Take Snapshot`;
            }
        }
    },

    generateSparklineSVG(points, isPositive, width = 100, height = 28) {
        if (!points || points.length < 2) {
            return `<svg width="${width}" height="${height}"></svg>`;
        }

        const min = Math.min(...points);
        const max = Math.max(...points);
        const range = (max - min) || 1;
        const padding = 4;
        const drawHeight = height - padding * 2;
        const drawWidth = width;

        const coords = points.map((val, idx) => {
            const x = (idx / (points.length - 1)) * drawWidth;
            const y = height - padding - ((val - min) / range) * drawHeight;
            return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
        });

        const pathD = coords.reduce((acc, pt, i) => i === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`, '');
        const fillD = `${pathD} L ${drawWidth} ${height} L 0 ${height} Z`;

        const strokeColor = isPositive ? '#00FF85' : '#FF005A';
        const gradientId = `spark-grad-${Math.random().toString(36).substring(2, 7)}`;

        return `<svg width="${width}" height="${height}" style="overflow:visible;vertical-align:middle;">
            <defs>
                <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.35"/>
                    <stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.0"/>
                </linearGradient>
            </defs>
            <path d="${fillD}" fill="url(#${gradientId})"/>
            <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    },

    // ==================== RENDER: TACTICAL ZONES ====================
    async renderZones() {
        const formation = this.state.selectedFormation || '4231';
        try {
            const data = await this.apiFetch(`/api/tactics/zones?formation=${formation}`);
            this.state.zonesData = data;

            const gwEl = document.getElementById('zones-gw-display');
            if (gwEl) gwEl.textContent = data.gw || '12';

            const selEl = document.getElementById('zones-formation-select');
            if (selEl) selEl.value = formation;

            const container = document.getElementById('zones-nodes-container');
            if (container && data.nodes) {
                // Exact 1:1 node positions matching step 983 reference image
                const customNodes = [
                    { abbr: 'HAA', role: 'ST', top: '36%', left: '47%', type: 'pink' },
                    { abbr: 'KDB', role: 'CAM', top: '46%', left: '47%', type: 'pink' },
                    { abbr: 'SON', role: 'LAM', top: '50%', left: '33%', type: 'ring' },
                    { abbr: 'SAK', role: 'RAM', top: '50%', left: '61%', type: 'ring' },
                    { abbr: 'ROD', role: 'LDM', top: '63%', left: '40%', type: 'ring' },
                    { abbr: 'RICE', role: 'RDM', top: '63%', left: '54%', type: 'ring' },
                    { abbr: 'UDO', role: 'LB', top: '76%', left: '31%', type: 'cyan' },
                    { abbr: 'SAL', role: 'LCB', top: '76%', left: '42%', type: 'ring' },
                    { abbr: 'GAB', role: 'RCB', top: '76%', left: '53%', type: 'ring' },
                    { abbr: 'POR', role: 'RB', top: '76%', left: '63%', type: 'ring' },
                    { abbr: 'ARE', role: 'GK', top: '86%', left: '47%', type: 'ring' }
                ];

                container.innerHTML = customNodes.map(n => {
                    let nodeGraphic = '';
                    if (n.type === 'cyan') {
                        nodeGraphic = `<div style="width:20px;height:20px;border-radius:50%;background:#00D1FF;box-shadow:0 0 16px #00D1FF, 0 0 32px rgba(0,209,255,0.85);"></div>`;
                    } else if (n.type === 'pink') {
                        nodeGraphic = `<div style="width:20px;height:20px;border-radius:50%;background:#FF005A;box-shadow:0 0 16px #FF005A, 0 0 32px rgba(255,0,90,0.85);"></div>`;
                    } else {
                        nodeGraphic = `<div style="width:22px;height:22px;border-radius:50%;background:#090e0c;border:2.5px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.6);"></div>`;
                    }

                    return `<div style="position:absolute;top:${n.top};left:${n.left};transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;cursor:pointer;z-index:10;">
                        ${nodeGraphic}
                        <span class="mono" style="font-size:10px;background:#090d0b;padding:1px 5px;margin-top:4px;border-radius:3px;color:#c5d8cd;white-space:nowrap;font-weight:700;border:1px solid #19271f;font-family:var(--font-mono);">${n.abbr}</span>
                    </div>`;
                }).join('');
            }

            const targetContainer = document.getElementById('target-zones-list');
            if (targetContainer && data.targetZones) {
                targetContainer.innerHTML = data.targetZones.map(tz => `
                    <div style="background:#141d18;border-radius:10px;padding:16px;border:1px solid #1e2e24;">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
                            <div>
                                <span class="mono" style="font-size:10px;text-transform:uppercase;padding:3px 8px;border-radius:4px;display:inline-block;margin-bottom:6px;font-weight:700;letter-spacing:0.05em;${tz.vulnClass === 'fdr-5' ? 'background:rgba(255,0,90,0.18);color:#FF005A;' : 'background:rgba(255,166,0,0.18);color:#FFA600;'}">${tz.vulnBadge}</span>
                                <h4 style="font-size:15px;font-weight:700;color:#ffffff;margin:0;">${tz.zoneName}</h4>
                            </div>
                            <div style="text-align:right;">
                                <div class="mono" style="font-size:11px;color:#6c8577;font-weight:500;">xPts</div>
                                <div class="mono" style="font-size:16px;color:#ffffff;font-weight:700;">${tz.xPts}</div>
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;gap:10px;margin-top:10px;">
                            <div style="width:32px;height:32px;border-radius:4px;background:#1a2820;border:1px solid #23352a;overflow:hidden;flex-shrink:0;">
                                <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${tz.player.code}.png" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                            </div>
                            <div style="display:flex;flex-direction:column;">
                                <span style="font-size:13px;font-weight:700;color:#ffffff;">${tz.player.name}</span>
                                <span class="mono" style="font-size:11px;color:#6c8577;">${tz.player.fixture}</span>
                            </div>
                        </div>
                    </div>
                `).join('');
            }

            const dangerTbody = document.getElementById('danger-zones-table-body');
            if (dangerTbody && data.dangerZones) {
                dangerTbody.innerHTML = data.dangerZones.map(dz => {
                    const valColor = dz.colorTier === 'fdr-5' ? '#FF005A' : dz.colorTier === 'fdr-4' ? '#FFA600' : '#dfe4e0';
                    const barColor = dz.colorTier === 'fdr-5' ? '#FF005A' : dz.colorTier === 'fdr-4' ? '#FFA600' : '#00FF85';

                    return `<tr style="border-bottom:1px solid #16251e;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
                        <td style="padding:12px 16px;display:flex;align-items:center;gap:10px;">
                            <span style="display:inline-block;width:3px;height:12px;border-radius:2px;background:${barColor};"></span>
                            <span style="color:#ffffff;font-weight:700;font-size:13px;font-family:var(--font-mono);">${dz.fixture}</span>
                        </td>
                        <td style="padding:12px 16px;color:#6c8577;font-size:13px;">${dz.threatArea}</td>
                        <td style="padding:12px 16px;text-align:right;font-weight:700;color:${valColor};font-family:var(--font-mono);font-size:13px;">${dz.xGConceded}</td>
                    </tr>`;
                }).join('');
            }
        } catch (err) {
            console.error('Tactical zones render error:', err);
        }
    },

    changeFormation(fmt) {
        this.state.selectedFormation = fmt;
        this.renderZones();
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
