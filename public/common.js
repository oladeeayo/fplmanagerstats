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

            // Update deadline display and start countdown
            const setupDeadlineCountdown = (dl) => {
                if (!dl || !dl.deadlineTime) return false;
                const dlEl = document.getElementById('deadline-time');
                if (dlEl) {
                    const d = new Date(dl.deadlineTime);
                    dlEl.textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                }
                this.startCountdown(new Date(dl.deadlineTime));
                return true;
            };

            if (!setupDeadlineCountdown(deadline)) {
                // Fallback: fetch deadline independently if initial load failed
                this.apiFetch(this.API.deadline).then(dl => setupDeadlineCountdown(dl)).catch(() => {});
            }

            // Refresh deadline every 5 minutes to stay accurate
            if (this._deadlineRefreshInterval) clearInterval(this._deadlineRefreshInterval);
            this._deadlineRefreshInterval = setInterval(() => {
                this.apiFetch(this.API.deadline).then(dl => setupDeadlineCountdown(dl)).catch(() => {});
            }, 5 * 60 * 1000);

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

            // Update manager ID display in sidebar
            const display = document.getElementById('manager-id-display');
            if (display) {
                display.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#00FF85;box-shadow:0 0 6px #00FF85;"></span> ${data.managerInfo?.name || 'Manager ' + managerId}</span>`;
            }

            // Update topbar connect button to show connected state
            const topbarBtn = document.querySelector('.topbar-right .btn-primary');
            if (topbarBtn) {
                topbarBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;color:#00FF85;">check_circle</span> Connected`;
                topbarBtn.onclick = () => this.showDialog('connect-dialog');
                topbarBtn.style.background = 'rgba(0,255,133,0.12)';
                topbarBtn.style.border = '1px solid rgba(0,255,133,0.3)';
                topbarBtn.style.color = '#00FF85';
            }

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

        loaderInterval: null,
    loaderStartTime: 0,

    showLoading(label = 'Loading FPL data...') {
        const el = document.getElementById('loading-overlay');
        if (el) {
            const labelEl = el.querySelector('.pixel-loader-label');
            if (labelEl) labelEl.textContent = label;
            el.classList.remove('hidden');
        }

        const timerEl = document.getElementById('main-overlay-timer');
        if (timerEl) {
            this.loaderStartTime = Date.now();
            if (this.loaderInterval) clearInterval(this.loaderInterval);
            this.loaderInterval = setInterval(() => {
                const ds = Math.floor((Date.now() - this.loaderStartTime) / 100);
                const total = ds / 10;
                if (total < 60) {
                    timerEl.textContent = total.toFixed(1) + 's';
                } else {
                    timerEl.textContent = Math.floor(total / 60) + 'm ' + (total % 60).toFixed(1) + 's';
                }
            }, 100);
        }
    },

    hideLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.classList.add('hidden');
        if (this.loaderInterval) {
            clearInterval(this.loaderInterval);
            this.loaderInterval = null;
        }
    },

    startCountdown(deadlineDate) {
        const countdownEl = document.getElementById('dash-countdown');
        const dateEl = document.getElementById('dash-deadline-date');
        if (!countdownEl) return;

        if (dateEl && deadlineDate) {
            dateEl.textContent = deadlineDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        }

        const update = () => {
            const now = new Date();
            const diff = deadlineDate - now;
            if (diff <= 0) {
                countdownEl.textContent = 'LIVE';
                countdownEl.style.color = '#FF005A';
                countdownEl.style.textShadow = '0 0 10px rgba(255, 0, 90, 0.5)';
                if (this._countdownInterval) clearInterval(this._countdownInterval);
                return;
            }
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);

            if (days > 0) {
                countdownEl.textContent = days + 'd ' + String(hours).padStart(2, '0') + 'h ' + String(minutes).padStart(2, '0') + 'm ' + String(seconds).padStart(2, '0') + 's';
            } else {
                countdownEl.textContent = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
            }
        };

        update();
        if (this._countdownInterval) clearInterval(this._countdownInterval);
        this._countdownInterval = setInterval(update, 1000);
    },

    createPixelLoader(label = 'Loading FPL data...') {
        const id = 'loader-timer-' + Math.random().toString(36).substring(2, 7);
        setTimeout(() => {
            const timerEl = document.getElementById(id);
            if (!timerEl) return;
            const startTime = Date.now();
            const interval = setInterval(() => {
                const currentEl = document.getElementById(id);
                if (!currentEl) {
                    clearInterval(interval);
                    return;
                }
                const ds = Math.floor((Date.now() - startTime) / 100);
                const total = ds / 10;
                if (total < 60) {
                    currentEl.textContent = total.toFixed(1) + 's';
                } else {
                    currentEl.textContent = Math.floor(total / 60) + 'm ' + (total % 60).toFixed(1) + 's';
                }
            }, 100);
        }, 50);

        return '<div class="pixel-loader-container"><span class="pixel-grid" aria-hidden="true"><span class="pixel-dot"></span><span class="pixel-dot"></span><span class="pixel-dot"></span><span class="pixel-dot"></span><span class="pixel-dot"></span><span class="pixel-dot"></span><span class="pixel-dot"></span><span class="pixel-dot"></span><span class="pixel-dot"></span></span><span class="pixel-loader-label">' + label + '</span><span id="' + id + '" class="pixel-loader-timer">0.0s</span></div>';
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
            if (gwAvgEl) gwAvgEl.textContent = data.gwAverage || '--';
            const highestEl = document.getElementById('dash-highest-score');
            if (highestEl) highestEl.textContent = data.highestScore || '--';
            const transfersEl = document.getElementById('dash-total-transfers');
            if (transfersEl) transfersEl.textContent = data.totalTransfers || '--';

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
                                <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || p.web_name || 'FPL Player'} photo" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
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
                                <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || p.web_name || 'FPL Player'} photo" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                            </div>
                            <div>
                                <div style="font-size:13px;font-weight:700;color:#ffffff;">${p.name}</div>
                                <div class="mono" style="font-size:10px;color:#8ba396;">${p.team} • ${p.pos} • £${p.price || '?'}m</div>
                            </div>
                        </div>
                        <div class="mono" style="font-size:13px;font-weight:700;color:#00ff85;">${p.transfersCount}</div>
                    </div>
                `).join('');
            }

            const priceChangesContainer = document.getElementById('dash-price-changes-list');
            if (priceChangesContainer && data.priceChanges) {
                priceChangesContainer.innerHTML = data.priceChanges.length > 0 ? data.priceChanges.map(pc => `
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
                `).join('') : '<div style="text-align:center;padding:12px;font-size:13px;color:#8ba396;">No price changes yet</div>';
            }

            const transfersOutContainer = document.getElementById('dash-transfers-out-list');
            if (transfersOutContainer && data.topTransfersOut) {
                transfersOutContainer.innerHTML = data.topTransfersOut.length > 0 ? data.topTransfersOut.map((p, idx) => `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;${idx < data.topTransfersOut.length - 1 ? 'border-bottom:1px solid #19261f;' : ''}">
                        <div style="display:flex;align-items:center;gap:10px;">
                            <div style="width:32px;height:32px;border-radius:50%;background:#1c2720;border:1px solid #28392e;display:flex;align-items:center;justify-content:center;font-weight:700;color:#FF005A;font-size:12px;">${idx + 1}</div>
                            <div>
                                <div style="font-size:14px;font-weight:700;color:#ffffff;">${p.name}</div>
                                <div style="font-size:11px;color:#8ba396;font-family:var(--font-mono);">${p.team} • ${p.pos} • £${p.price || '?'}m</div>
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:13px;font-weight:700;color:#FF005A;font-family:var(--font-mono);">${p.transfersCount}</div>
                        </div>
                    </div>
                `).join('') : '<div style="text-align:center;padding:12px;font-size:13px;color:#8ba396;">No transfer data yet</div>';
            }

            const injuryContainer = document.getElementById('dash-injury-list');
            if (injuryContainer && data.injuryNews) {
                injuryContainer.innerHTML = data.injuryNews.length > 0 ? data.injuryNews.map(p => {
                    const statusColor = p.statusKey === 'i' ? '#FF4D4D' : p.statusKey === 's' ? '#FFA600' : p.statusKey === 'd' ? '#FFD700' : '#8ba396';
                    const statusBg = p.statusKey === 'i' ? 'rgba(255,77,77,0.15)' : p.statusKey === 's' ? 'rgba(255,166,0,0.15)' : p.statusKey === 'd' ? 'rgba(255,215,0,0.15)' : 'rgba(139,163,150,0.15)';
                    return `
                    <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #19261f;">
                        <div style="width:32px;height:32px;border-radius:50%;background:${statusBg};border:1px solid ${statusColor}40;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <span class="material-symbols-outlined" style="color:${statusColor};font-size:18px;">${p.statusKey === 'i' ? 'healing' : p.statusKey === 's' ? 'block' : 'help_outline'}</span>
                        </div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:13px;font-weight:700;color:#ffffff;">${p.name} <span style="font-size:10px;color:#8ba396;font-family:var(--font-mono);">${p.team} • ${p.pos}</span></div>
                            <div style="font-size:11px;color:${statusColor};margin-top:2px;">${p.status}: ${p.news}</div>
                        </div>
                    </div>`;
                }).join('') : '<div style="text-align:center;padding:16px;font-size:13px;color:#8ba396;">No injury or suspension news</div>';
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

        // Top Bento Stats - use real data only, show '--' if unavailable
        const rankEl = document.getElementById('team-overall-rank');
        if (rankEl) rankEl.textContent = info?.overallRanking ? this.formatNumber(info.overallRanking) : '--';

        const rankChangeEl = document.getElementById('team-rank-change');
        if (rankChangeEl) rankChangeEl.textContent = info?.rankChange ? (info.rankChange > 0 ? '↑ ' : '↓ ') + this.formatNumber(Math.abs(info.rankChange)) : '--';

        const totalPtsEl = document.getElementById('team-total-points');
        if (totalPtsEl) totalPtsEl.textContent = info?.managerPoints ? this.formatNumber(info.managerPoints) : '--';

        const gwSubEl = document.getElementById('team-gw-points-sub');
        if (gwSubEl) gwSubEl.textContent = info?.highestPoints ? 'GW: ' + info.highestPoints : 'GW: --';

        const tmplScoreEl = document.getElementById('team-template-score');
        if (tmplScoreEl) tmplScoreEl.textContent = info?.templateScore ? info.templateScore + '%' : '--%';

        const tmplBarEl = document.getElementById('team-template-score-bar');
        if (tmplBarEl) tmplBarEl.style.width = info?.templateScore ? Math.min(100, info.templateScore) + '%' : '0%';

        // Position Breakdown
        if (team && team.length > 0) {
            const posStats = {
                GKP: { pts: 0, topName: '', topPts: 0, topCode: null },
                DEF: { pts: 0, topName: '', topPts: 0, topCode: null },
                MID: { pts: 0, topName: '', topPts: 0, topCode: null },
                FWD: { pts: 0, topName: '', topPts: 0, topCode: null }
            };

            team.forEach(p => {
                const pos = p.position || 'MID';
                const pts = p.totalPoints || p.points || 0;
                if (!posStats[pos]) posStats[pos] = { pts: 0, topName: '', topPts: 0, topCode: null };
                posStats[pos].pts += pts;
                if (pts >= posStats[pos].topPts) {
                    posStats[pos].topPts = pts;
                    posStats[pos].topName = p.webName || p.name || 'Player';
                    posStats[pos].topCode = p.code;
                }
            });

            if (document.getElementById('pos-gkp-pts')) document.getElementById('pos-gkp-pts').textContent = posStats.GKP.pts || '0';
            if (document.getElementById('pos-gkp-top')) document.getElementById('pos-gkp-top').textContent = posStats.GKP.topName ? `Top: ${posStats.GKP.topName} (${posStats.GKP.topPts})` : 'No data';
            if (posStats.GKP.topCode) {
                const imgEl = document.getElementById('pos-gkp-img');
                if (imgEl) imgEl.innerHTML = `<img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${posStats.GKP.topCode}.png" alt="${posStats.GKP.topName || 'Goalkeeper'} - top scoring goalkeeper" onerror="this.parentElement.innerHTML='<span class=\\'material-symbols-outlined\\' style=\\'color:#444;font-size:28px;\\'>person</span>'" style="width:100%;height:100%;object-fit:cover;">`;
            }

            if (document.getElementById('pos-def-pts')) document.getElementById('pos-def-pts').textContent = posStats.DEF.pts || '0';
            if (document.getElementById('pos-def-top')) document.getElementById('pos-def-top').textContent = posStats.DEF.topName ? `Top: ${posStats.DEF.topName} (${posStats.DEF.topPts})` : 'No data';
            if (posStats.DEF.topCode) {
                const imgEl = document.getElementById('pos-def-img');
                if (imgEl) imgEl.innerHTML = `<img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${posStats.DEF.topCode}.png" alt="${posStats.DEF.topName || 'Defender'} - top scoring defender" onerror="this.parentElement.innerHTML='<span class=\\'material-symbols-outlined\\' style=\\'color:#444;font-size:28px;\\'>person</span>'" style="width:100%;height:100%;object-fit:cover;">`;
            }

            if (document.getElementById('pos-mid-pts')) document.getElementById('pos-mid-pts').textContent = posStats.MID.pts || '0';
            if (document.getElementById('pos-mid-top')) document.getElementById('pos-mid-top').textContent = posStats.MID.topName ? `Top: ${posStats.MID.topName} (${posStats.MID.topPts})` : 'No data';
            if (posStats.MID.topCode) {
                const imgEl = document.getElementById('pos-mid-img');
                if (imgEl) imgEl.innerHTML = `<img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${posStats.MID.topCode}.png" alt="${posStats.MID.topName || 'Midfielder'} - top scoring midfielder" onerror="this.parentElement.innerHTML='<span class=\\'material-symbols-outlined\\' style=\\'color:#444;font-size:28px;\\'>person</span>'" style="width:100%;height:100%;object-fit:cover;">`;
            }

            if (document.getElementById('pos-fwd-pts')) document.getElementById('pos-fwd-pts').textContent = posStats.FWD.pts || '0';
            if (document.getElementById('pos-fwd-top')) document.getElementById('pos-fwd-top').textContent = posStats.FWD.topName ? `Top: ${posStats.FWD.topName} (${posStats.FWD.topPts})` : 'No data';
            if (posStats.FWD.topCode) {
                const imgEl = document.getElementById('pos-fwd-img');
                if (imgEl) imgEl.innerHTML = `<img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${posStats.FWD.topCode}.png" alt="${posStats.FWD.topName || 'Forward'} - top scoring forward" onerror="this.parentElement.innerHTML='<span class=\\'material-symbols-outlined\\' style=\\'color:#444;font-size:28px;\\'>person</span>'" style="width:100%;height:100%;object-fit:cover;">`;
            }
        }

        // Squad Performance Table
        const squadTbody = document.getElementById('squad-performance-tbody');
        if (squadTbody) {
            if (!team || team.length === 0) {
                squadTbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#8ba396;font-size:13px;">Connect your FPL ID to see squad performance data</td></tr>';
                return;
            }
            const playersToRender = team;

            squadTbody.innerHTML = playersToRender.map(p => `
                <tr style="border-bottom:1px solid #16251e;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
                    <td style="padding:4px 6px;background:#141916;max-width:120px;overflow:hidden;display:flex;align-items:center;gap:6px;">
                        <div style="width:24px;height:24px;border-radius:50%;background:#1c2720;border:1px solid #28392e;flex-shrink:0;"></div>
                        <span style="font-weight:700;color:#ffffff;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.webName || p.name}</span>
                    </td>
                    <td style="text-align:center;color:#ffffff;font-family:var(--font-mono);font-size:11px;">${p.totalPoints || p.points || 0}</td>
                    <td style="text-align:center;color:#8ba396;font-family:var(--font-mono);font-size:11px;">${p.gwApps || 28}</td>
                    <td style="text-align:center;color:#8ba396;font-family:var(--font-mono);font-size:11px;">${p.starts || 27}</td>
                    <td style="text-align:center;color:#8ba396;font-family:var(--font-mono);font-size:11px;">${p.captPts || 0}</td>
                    <td style="text-align:center;color:#ffffff;font-family:var(--font-mono);font-size:11px;">${p.costStr || ('£' + ((p.nowCost || 100) / 10).toFixed(1) + 'm')}</td>
                    <td style="text-align:center;font-weight:700;color:#00FF85;font-family:var(--font-mono);font-size:11px;">${p.ppg || ( (p.totalPoints || p.points || 0) / 28 ).toFixed(1)}</td>
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

        // Per 90 toggle
        const per90 = document.getElementById('per90-toggle')?.checked || false;

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
                case 'mins':
                    return (b.minutes || 0) - (a.minutes || 0);
                case 'goals':
                    return (b.goals_scored || 0) - (a.goals_scored || 0);
                case 'pts':
                default:
                    return (b.total_points || 0) - (a.total_points || 0);
            }
        });

        const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        const posColors = { 1: '#FFD700', 2: '#4FC3F7', 3: '#81C784', 4: '#E57373' };

        // Update column headers based on per90 toggle
        const thGoals = document.getElementById('th-goals');
        const thXG = document.getElementById('th-xg');
        const thXA = document.getElementById('th-xa');
        const thXGI = document.getElementById('th-xgi');
        if (thGoals) thGoals.textContent = per90 ? 'Goals/90' : 'Goals';
        if (thXG) thXG.textContent = per90 ? 'xG/90' : 'xG';
        if (thXA) thXA.textContent = per90 ? 'xA/90' : 'xA';
        if (thXGI) thXGI.textContent = per90 ? 'xGI/90' : 'xGI';

        tbody.innerHTML = filtered.slice(0, 50).map((p, idx) => {
            const team = teams.find(t => t.id === p.team);
            const teamShort = team ? team.short_name : 'FPL';
            const posStr = posNames[p.element_type] || 'DEF';
            const posColor = posColors[p.element_type] || '#4FC3F7';
            const formVal = parseFloat(p.form || 0);
            const price = (p.now_cost / 10).toFixed(1);
            const mins = p.minutes || 0;
            const nineties = mins > 0 ? mins / 90 : 0;

            const goalsRaw = p.goals_scored || 0;
            const xGRaw = parseFloat(p.expected_goals || 0);
            const xARaw = parseFloat(p.expected_assists || 0);
            const xGIRaw = parseFloat(p.expected_goal_involvements || 0);

            const goals = per90 && nineties > 0 ? goalsRaw / nineties : goalsRaw;
            const xG = per90 && nineties > 0 ? xGRaw / nineties : xGRaw;
            const xA = per90 && nineties > 0 ? xARaw / nineties : xARaw;
            const xGI = per90 && nineties > 0 ? xGIRaw / nineties : xGIRaw;
            const goalsVsXG = goals - xG;
            const xgiPer90 = parseFloat(p.expected_goal_involvements_per_90 || 0);

            const isEven = idx % 2 === 1;
            const decimals = per90 ? 2 : 1;

            return `
                <tr style="border-bottom:1px solid #1A2E28;transition:background 0.2s;${isEven ? 'background:rgba(49,54,51,0.15);' : ''}" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='${isEven ? 'rgba(49,54,51,0.15)' : 'transparent'}'">
                    <td style="padding:4px 6px;background:${isEven ? '#1E1E1E' : '#1A1A1A'};max-width:110px;overflow:hidden;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <div style="width:28px;height:28px;border-radius:50%;overflow:hidden;background:#2A2A2A;border:1px solid #333;flex-shrink:0;">
                                <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || p.web_name || 'FPL Player'} photo" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                            </div>
                            <div style="min-width:0;overflow:hidden;">
                                <div style="font-weight:700;font-size:11px;color:#E0E0E0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.web_name}</div>
                                <div style="display:flex;align-items:center;gap:3px;font-size:9px;color:#8ba396;white-space:nowrap;">
                                    <span style="padding:1px 3px;border-radius:2px;font-weight:700;background:${posColor}20;color:${posColor};font-size:8px;">${posStr}</span>
                                    <span>${teamShort}</span>
                                    <span style="color:#444;">·</span>
                                    <span style="font-family:var(--font-mono);color:#B0B0B0;">£${price}m</span>
                                </div>
                            </div>
                        </div>
                    </td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:12px;font-weight:700;color:#00FF85;">${per90 && nineties > 0 ? (p.total_points / nineties).toFixed(1) : p.total_points}</td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:11px;color:#B0B0B0;">${mins.toLocaleString()}</td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:12px;color:${goalsRaw > 0 ? '#E0E0E0' : '#666'};">${goals.toFixed(decimals)}</td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:12px;color:${xG >= (per90 ? 0.3 : 5) ? '#00FF85' : xG >= (per90 ? 0.15 : 2) ? '#FFA600' : '#B0B0B0'};">${xG.toFixed(decimals)}</td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:12px;color:${goalsVsXG > 0 ? '#00FF85' : goalsVsXG < 0 ? '#FF005A' : '#666'};">${goalsVsXG > 0 ? '+' : ''}${goalsVsXG.toFixed(decimals)}</td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:11px;color:#B0B0B0;">${xA.toFixed(decimals)}</td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:12px;color:${xGI >= (per90 ? 0.4 : 5) ? '#00FF85' : xGI >= (per90 ? 0.2 : 2) ? '#FFA600' : '#B0B0B0'};">${xGI.toFixed(decimals)}</td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:11px;color:#B0B0B0;">${xgiPer90.toFixed(2)}</td>
                    <td style="text-align:center;">
                        <div style="display:flex;align-items:center;justify-content:center;gap:2px;">
                            ${[formVal >= 5 ? 1 : 2, formVal >= 4 ? 2 : 3, formVal >= 3 ? 1 : 2, formVal >= 2 ? 3 : 4, formVal >= 1 ? 1 : 5].map(h => `<div style="width:4px;height:${h * 3}px;border-radius:2px;background:var(--fdr-${h});"></div>`).join('')}
                        </div>
                    </td>
                    <td style="text-align:center;font-family:var(--font-mono);font-size:11px;color:#B0B0B0;">${parseFloat(p.ict_index || 0).toFixed(1)}</td>
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
                    <td style="padding:4px 6px;position:relative;font-weight:700;color:var(--md-sys-color-on-surface);width:40px;background:${isEven ? 'rgba(2,43,30,0.5)' : '#022B1E'};">
                        <div style="position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:70%;background:var(--${borderTier});border-radius:0 2px 2px 0;"></div>
                        ${m.rank}
                    </td>
                    <td style="padding:4px 6px;background:${isEven ? 'rgba(2,43,30,0.5)' : '#022B1E'};max-width:140px;overflow:hidden;">
                        <div style="font-weight:700;color:var(--md-sys-color-on-surface);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.managerName}</div>
                        <div style="font-size:9px;color:var(--md-sys-color-on-surface-variant);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.entryName}</div>
                    </td>
                    <td style="padding:4px 6px;text-align:center;color:var(--md-sys-color-on-surface);font-weight:600;">${m.eventTotal}</td>
                    <td class="mono" style="padding:4px 6px;text-align:center;color:var(--fdr-1);font-weight:800;">${this.formatNumber(m.total)}</td>
                    <td style="padding:4px 6px;text-align:center;">${diffArrow}</td>
                    <td style="padding:4px 6px;text-align:center;">
                        <span class="mono" style="background:var(--md-sys-color-surface-variant);color:var(--md-sys-color-on-surface);font-size:10px;padding:2px 6px;border-radius:3px;font-weight:700;display:inline-block;">${this.formatNumber(m.diffCount)}</span>
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

    setFixtureStartGW(gw) {
        this.state.fixtureStartGW = parseInt(gw);
        this.renderFixtures();
    },

    renderFixtures() {
        const fixtures = this.state.fixtures;
        const bootstrap = this.state.bootstrapData;
        if (!fixtures || !bootstrap) return;

        const lookaheadCount = this.state.fixtureLookahead || 5;
        const currentGW = bootstrap.events?.find(e => e.is_current)?.id || 1;
        const startGW = this.state.fixtureStartGW || currentGW;
        const teams = bootstrap.teams || [];
        const elements = bootstrap.elements || [];

        // Populate GW selector if empty
        const gwSelect = document.getElementById('fixture-gw-select');
        if (gwSelect && gwSelect.options.length === 0) {
            for (let i = 1; i <= 38; i++) {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = `GW ${i}`;
                if (i === currentGW) opt.selected = true;
                gwSelect.appendChild(opt);
            }
        }

        // Dynamic Gameweeks header
        const targetGWs = [];
        for (let g = startGW; g < Math.min(39, startGW + lookaheadCount); g++) {
            targetGWs.push(g);
        }

        const headerRow = document.getElementById('fixture-grid-header-row');
        if (headerRow) {
            headerRow.style.background = '#a7cfbc';
            headerRow.innerHTML = `<th style="padding:5px 6px;background:#a7cfbc;width:60px;max-width:60px;font-family:var(--font-mono);font-size:11px;color:#0a0f0d;font-weight:700;">TEAM</th>` +
                targetGWs.map(gw => `<th style="padding:5px 6px;text-align:center;font-family:var(--font-mono);font-size:11px;color:#0a0f0d;font-weight:700;background:#a7cfbc;"><span style="color:#0a0f0d;font-weight:700;">GW${gw}</span></th>`).join('');
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
                        return `<td style="padding:3px;"><div style="background:#313633;border-radius:6px;padding:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;height:40px;opacity:0.5;"><span style="font-size:10px;font-family:var(--font-mono);color:#b9cbb9;font-weight:700;">BLANK</span></div></td>`;
                    }
                    const isHome = fx.team_h === team.id;
                    const oppId = isHome ? fx.team_a : fx.team_h;
                    const oppTeam = teams.find(t => t.id === oppId);
                    const oppShort = oppTeam ? oppTeam.short_name : 'TBD';
                    const diff = isHome ? (fx.team_h_difficulty || fx.difficulty || 3) : (fx.team_a_difficulty || fx.difficulty || 3);
                    const venueStr = isHome ? 'H' : 'A';
                    const colStyle = fdrColors[diff] || fdrColors[3];

                    return `<td style="padding:3px;">
                        <div style="background:${colStyle.bg};border-radius:6px;padding:4px 6px;display:flex;flex-direction:column;align-items:center;justify-content:center;height:40px;">
                            <span style="font-size:10px;font-weight:700;font-family:var(--font-mono);color:${colStyle.text}">${oppShort} (${venueStr})</span>
                        </div>
                    </td>`;
                }).join('');

                const avgFDR = Math.round(targetGWs.reduce((acc, gw) => {
                    const fx = fixtures.find(f => f.event === gw && (f.team_h === team.id || f.team_a === team.id));
                    if (!fx) return acc + 3;
                    return acc + (fx.team_h === team.id ? (fx.team_h_difficulty || 3) : (fx.team_a_difficulty || 3));
                }, 0) / targetGWs.length);

                const teamAccentColor = fdrColors[avgFDR]?.bg || '#37DB59';

                return `<tr style="border-bottom:1px solid #1A2E28;background:${isEven ? '#181d1a' : '#0f1412'};">
                    <td style="padding:4px 6px;background:${isEven ? '#181d1a' : '#0f1412'};max-width:60px;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono);font-size:10px;font-weight:700;color:#00ff85;">
                        <div style="display:flex;align-items:center;gap:4px;">
                            <div style="width:3px;height:16px;background:${teamAccentColor};border-radius:999px;flex-shrink:0;"></div>
                            ${team.short_name}
                        </div>
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
                        <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || p.web_name || 'FPL Player'} photo" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
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
                    <td style="padding:4px 6px;text-align:center;background:#1E1E1E;border-left:3px solid var(--${p.borderTier});font-weight:700;font-size:11px;">${p.rk}</td>
                    <td style="padding:4px 6px;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <div style="width:28px;height:28px;border-radius:50%;overflow:hidden;background:var(--md-sys-color-surface);flex-shrink:0;border:1px solid var(--md-sys-color-outline-variant);">
                                <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || p.web_name || 'FPL Player'} photo" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                            </div>
                            <div style="min-width:0;">
                                <div style="font-weight:600;color:var(--md-sys-color-on-surface);display:flex;align-items:center;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                                    ${p.name} ${badgeIcon}
                                </div>
                                <div style="font-size:9px;color:var(--md-sys-color-on-surface-variant);white-space:nowrap;">${p.team} (${p.position})</div>
                            </div>
                        </div>
                    </td>
                    <td style="padding:4px 6px;text-align:center;font-weight:500;font-size:11px;">${p.opp}</td>
                    <td style="padding:4px 6px;text-align:center;">
                        <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:3px;background:var(--fdr-${p.fdr});color:#0a0f0d;font-size:10px;font-weight:800;">${p.fdr}</span>
                    </td>
                    <td style="padding:4px 6px;text-align:center;font-weight:600;color:var(--fdr-1);font-size:11px;">${p.form}</td>
                    <td style="padding:4px 6px;text-align:center;font-weight:600;color:#00D1FF;font-size:11px;">${p.xGI}</td>
                    <td style="padding:4px 6px;text-align:center;font-weight:800;font-size:11px;${rankColor}">${p.xPTS}</td>
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

            // Render Bento Grid Cards
            this.renderOwnershipBento(data);

            // Render Table
            this.renderOwnershipTable();

            // Auto-capture snapshot in background (throttled server-side to 1hr)
            this.autoCaptureSnapshot();
        } catch (err) {
            console.error('Ownership trends render error:', err);
            const tbody = document.getElementById('ownership-trends-table-body');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:var(--space-lg);color:var(--md-sys-color-error);">Failed to load ownership trend data: ${err.message}</td></tr>`;
            }
        }
    },

    async autoCaptureSnapshot() {
        try {
            await fetch('/api/ownership/snapshot', { method: 'POST' });
        } catch (e) {
            // Silent fail - snapshot is non-critical
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
                    <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || 'FPL Player'} - top transferred in" onerror="this.src='football.ico'" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--fdr-1);background:var(--md-sys-color-surface-container-high);">
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
                    <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || 'FPL Player'} - top transferred out" onerror="this.src='football.ico'" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--fdr-5);background:var(--md-sys-color-surface-container-high);">
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
                    <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || 'FPL Player'} - price change" onerror="this.src='football.ico'" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--fdr-4);background:var(--md-sys-color-surface-container-high);">
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
                const bg = val > 0 ? 'background:rgba(0,255,133,0.12);color:#1A9F39;' :
                           val < 0 ? 'background:rgba(255,0,90,0.12);color:#E21C3D;' :
                           'background:#2A2A2A;color:#B0B0B0;';
                return `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--font-mono);${bg}">${sign}${val.toFixed(2)}%</span>`;
            };

            const sparklineSVG = this.generateSparklineSVG(p.sparkline, p.delta24h >= 0, 110, 24);

            return `
            <tr style="border-bottom:1px solid #333333;transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                <td style="padding:4px 6px;text-align:center;color:#B0B0B0;font-family:var(--font-mono);font-size:10px;background:#1E1E1E;">${i + 1}</td>
                <td style="padding:4px 6px;text-align:left;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || 'FPL Player'}" onerror="this.src='football.ico'" style="width:28px;height:28px;border-radius:50%;object-fit:cover;background:#2A2A2A;border:1px solid #444444;flex-shrink:0;">
                        <div style="min-width:0;">
                            <div style="font-weight:700;font-size:11px;color:#E0E0E0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</div>
                            <div style="display:flex;align-items:center;gap:3px;font-size:9px;color:#B0B0B0;">
                                <span style="font-weight:600;">${p.team}</span>
                                <span style="color:#444;">·</span>
                                <span style="padding:0 3px;border-radius:2px;font-weight:700;font-size:8px;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                            </div>
                        </div>
                    </div>
                </td>
                <td style="padding:4px 6px;text-align:center;font-family:var(--font-mono);font-weight:600;color:#E0E0E0;">${p.costStr}</td>
                <td style="padding:4px 6px;text-align:center;">
                    <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
                        <span style="font-weight:700;color:#E0E0E0;font-family:var(--font-mono);font-size:11px;">${p.ownership}%</span>
                        <div style="height:3px;width:40px;background:#2A2A2A;border-radius:2px;overflow:hidden;">
                            <div style="height:100%;width:${Math.min(p.ownership, 100)}%;background:#00ff85;border-radius:2px;"></div>
                        </div>
                    </div>
                </td>
                <td style="padding:4px 6px;text-align:center;">${formatDelta(p.delta24h)}</td>
                <td style="padding:4px 6px;text-align:center;">${formatDelta(p.delta3d)}</td>
                <td style="padding:4px 6px;text-align:center;">${formatDelta(p.delta7d)}</td>
                <td style="padding:4px 6px;text-align:center;">${sparklineSVG}</td>
                <td style="padding:4px 6px;text-align:center;font-family:var(--font-mono);font-weight:700;color:#00ff85;font-size:11px;">${p.points}</td>
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

    // ==================== RENDER: MATCH ANALYSIS (TACTICS) ====================
    async renderZones() {
        // Load teams into dropdowns
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) return;

        const teams = bootstrap.teams;
        const homeSelect = document.getElementById('zones-home-team');
        const awaySelect = document.getElementById('zones-away-team');

        if (homeSelect && homeSelect.options.length <= 1) {
            teams.forEach(t => {
                homeSelect.add(new Option(t.short_name, t.id));
                awaySelect.add(new Option(t.short_name, t.id));
            });
        }

        // Set default GW
        const gwSelect = document.getElementById('zones-gw-select');
        if (gwSelect && this.state.currentGW) {
            gwSelect.value = this.state.currentGW;
        }
    },

    loadMatchFixtures() {
        const gwSelect = document.getElementById('zones-gw-select');
        const selectedGW = parseInt(gwSelect?.value) || this.state.currentGW;
        const fixtures = this.state.fixtures;
        const bootstrap = this.state.bootstrapData;
        if (!fixtures || !bootstrap) return;

        const teams = bootstrap.teams || [];
        const gwFixtures = fixtures.filter(f => f.event === selectedGW);

        // Build list of fixture pairs for this GW
        const fixturePairs = gwFixtures.map(f => {
            const homeTeam = teams.find(t => t.id === f.team_h);
            const awayTeam = teams.find(t => t.id === f.team_a);
            return {
                homeId: f.team_h,
                awayId: f.team_a,
                homeName: homeTeam?.short_name || '?',
                awayName: awayTeam?.short_name || '?',
                homeFullName: homeTeam?.name || '?',
                awayFullName: awayTeam?.name || '?'
            };
        });

        // Show fixture cards below selectors
        const homeSelect = document.getElementById('zones-home-team');
        const awaySelect = document.getElementById('zones-away-team');

        // Auto-select first fixture if none selected
        if (fixturePairs.length > 0 && homeSelect && awaySelect) {
            // Clear and repopulate with GW fixtures
            homeSelect.innerHTML = '<option value="">Select Home</option>';
            awaySelect.innerHTML = '<option value="">Select Away</option>';

            fixturePairs.forEach(fp => {
                homeSelect.add(new Option(`${fp.homeName} (${fp.homeFullName})`, fp.homeId));
                awaySelect.add(new Option(`${fp.awayName} (${fp.awayFullName})`, fp.awayId));
            });

            // Auto-select first fixture
            const firstFx = fixturePairs[0];
            homeSelect.value = firstFx.homeId;
            awaySelect.value = firstFx.awayId;
        }

        // Reset analysis view
        document.getElementById('match-analysis-content').style.display = 'none';
        document.getElementById('match-empty-state').style.display = 'block';
    },

    async loadMatchAnalysis() {
        const homeId = document.getElementById('zones-home-team')?.value;
        const awayId = document.getElementById('zones-away-team')?.value;
        if (!homeId || !awayId) return;
        if (homeId === awayId) return;

        try {
            const data = await this.apiFetch(`/api/match-analysis?team_h=${homeId}&team_a=${awayId}`);
            this.renderMatchAnalysis(data);
        } catch (err) {
            console.error('Match analysis error:', err);
        }
    },

    renderMatchAnalysis(data) {
        const { home, away, dangerZones, vulnZones, predictedDanger, homeStrength, awayStrength } = data;

        document.getElementById('match-empty-state').style.display = 'none';
        document.getElementById('match-analysis-content').style.display = 'block';

        // Render formation panel (reusable for both sides)
        const renderFormationPanel = (teamData, isHome) => {
            const posOrder = ['GK', 'DEF', 'MID', 'FWD'];
            const posColors = { GK: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };

            // Build formation string from player counts
            const formationStr = posOrder.slice(1).map(pos => (teamData.posGroups[pos] || []).length).join('-');

            let rows = '';
            posOrder.forEach(pos => {
                const players = teamData.posGroups[pos] || [];
                if (players.length === 0) return;
                rows += `<div style="display:flex;justify-content:center;gap:8px;margin-bottom:8px;">`;
                players.forEach(p => {
                    const isTop = p.xGI >= 10;
                    const bgColor = pos === 'GK' ? 'rgba(255,215,0,0.15)' :
                                   pos === 'DEF' ? 'rgba(79,195,247,0.15)' :
                                   pos === 'MID' ? 'rgba(129,199,132,0.15)' :
                                   'rgba(229,115,115,0.15)';
                    const borderColor = posColors[pos];
                    rows += `<div style="background:${bgColor};border:1px solid ${borderColor}40;border-radius:8px;padding:8px 12px;min-width:80px;text-align:center;">
                        <div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:${borderColor};">${pos}</div>
                        <div style="font-size:12px;font-weight:700;color:#fff;margin-top:2px;">${p.xGI.toFixed(1)} xGI</div>
                        <div style="font-size:10px;color:#8ba396;margin-top:1px;">${p.name}</div>
                    </div>`;
                });
                rows += `</div>`;
            });

            return `
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                    <h3 style="font-size:18px;font-weight:700;color:#fff;margin:0;">${teamData.teamName}</h3>
                    <span style="font-family:var(--font-mono);font-size:13px;color:#8ba396;background:#1c211e;padding:4px 8px;border-radius:4px;">${formationStr}</span>
                </div>
                <div style="background:#0d1210;border-radius:8px;padding:16px;margin-bottom:16px;">
                    ${rows}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-family:var(--font-mono);font-size:12px;">
                    <div style="padding:8px;background:#1c211e;border-radius:6px;text-align:center;">
                        <div style="color:#8ba396;font-size:10px;">Total xGI</div>
                        <div style="color:#00FF85;font-size:16px;font-weight:700;">${teamData.totalXGI}</div>
                    </div>
                    <div style="padding:8px;background:#1c211e;border-radius:6px;text-align:center;">
                        <div style="color:#8ba396;font-size:10px;">Goals Scored</div>
                        <div style="color:#fff;font-size:16px;font-weight:700;">${teamData.totalGoals}</div>
                    </div>
                    <div style="padding:8px;background:#1c211e;border-radius:6px;text-align:center;">
                        <div style="color:#8ba396;font-size:10px;">DEFCON</div>
                        <div style="color:${parseFloat(teamData.defcon) <= 2.5 ? '#00FF85' : parseFloat(teamData.defcon) <= 3.5 ? '#FFA600' : '#FF005A'};font-size:16px;font-weight:700;">${parseFloat(teamData.defcon) <= 2.5 ? 'Strong' : parseFloat(teamData.defcon) <= 3.5 ? 'Average' : 'Weak'}</div>
                    </div>
                    <div style="padding:8px;background:#1c211e;border-radius:6px;text-align:center;">
                        <div style="color:#8ba396;font-size:10px;">GK: ${teamData.bestPicks.find(p => p.position === 'GK')?.name || '--'}</div>
                        <div style="color:#fff;font-size:11px;">${teamData.totalCS} CS · ${teamData.totalGC} GC</div>
                    </div>
                </div>
            `;
        };

        document.getElementById('home-formation-panel').innerHTML = renderFormationPanel(home, true);
        document.getElementById('away-formation-panel').innerHTML = renderFormationPanel(away, false);

        // Render center panel
        const dangerHTML = dangerZones.length > 0 ? dangerZones.map(dz =>
            `<div style="padding:8px 12px;background:rgba(255,0,90,0.1);border:1px solid rgba(255,0,90,0.2);border-radius:6px;font-size:13px;">
                <span style="font-weight:700;color:#FF005A;">${dz.team}</span>: <span style="color:#fff;">${dz.zone}</span>
            </div>`
        ).join('') : '<div style="color:#8ba396;font-size:13px;">No significant danger zones</div>';

        const vulnHTML = vulnZones.length > 0 ? vulnZones.map(vz =>
            `<div style="padding:8px 12px;background:rgba(255,166,0,0.1);border:1px solid rgba(255,166,0,0.2);border-radius:6px;font-size:13px;">
                <span style="font-weight:700;color:#FFA600;">${vz.team}</span>: <span style="color:#fff;">${vz.zone}</span>
            </div>`
        ).join('') : '<div style="color:#8ba396;font-size:13px;">No significant vulnerabilities</div>';

        const predColor = predictedDanger.includes(home.teamShort) ? '#00FF85' :
                         predictedDanger.includes(away.teamShort) ? '#FF005A' : '#FFA600';

        document.getElementById('match-center-panel').innerHTML = `
            <h3 style="font-size:16px;font-weight:700;color:#fff;margin:0;text-align:center;">Match Analysis</h3>

            <div style="background:rgba(255,0,90,0.08);border:1px solid rgba(255,0,90,0.2);border-radius:8px;padding:12px;">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                    <span class="material-symbols-outlined" style="color:#FF005A;font-size:16px;">warning</span>
                    <span style="font-size:12px;font-weight:700;color:#FF005A;text-transform:uppercase;font-family:var(--font-mono);">Danger Zones</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">${dangerHTML}</div>
            </div>

            <div style="background:rgba(255,166,0,0.08);border:1px solid rgba(255,166,0,0.2);border-radius:8px;padding:12px;">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                    <span class="material-symbols-outlined" style="color:#FFA600;font-size:16px;">shield</span>
                    <span style="font-size:12px;font-weight:700;color:#FFA600;text-transform:uppercase;font-family:var(--font-mono);">Vulnerability Zones</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">${vulnHTML}</div>
            </div>

            <div style="background:#1c211e;border-radius:8px;padding:12px;">
                <div style="text-align:center;margin-bottom:8px;font-size:11px;color:#8ba396;text-transform:uppercase;font-family:var(--font-mono);">Defensive Strength</div>
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <span style="font-size:20px;font-weight:700;color:#fff;">${home.defcon}</span>
                    <span style="font-size:10px;color:#8ba396;font-family:var(--font-mono);">DEFCON</span>
                    <span style="font-size:20px;font-weight:700;color:#fff;">${away.defcon}</span>
                </div>
                <div style="height:6px;background:#0d1210;border-radius:3px;margin-top:8px;overflow:hidden;display:flex;">
                    <div style="height:100%;width:${homeStrength}%;background:#4FC3F7;border-radius:3px 0 0 3px;"></div>
                    <div style="height:100%;width:${awayStrength}%;background:#FF005A;border-radius:0 3px 3px 0;"></div>
                </div>
            </div>

            <div style="background:#1c211e;border-radius:8px;padding:12px;text-align:center;">
                <div style="font-size:10px;color:#8ba396;text-transform:uppercase;font-family:var(--font-mono);margin-bottom:4px;">Predicted Danger</div>
                <div style="font-size:16px;font-weight:700;color:${predColor};">${predictedDanger}</div>
            </div>
        `;

        // Render best picks
        const renderPicks = (teamData, isHome) => {
            return `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
                    <span class="material-symbols-outlined" style="color:${isHome ? '#00FF85' : '#FF005A'};font-size:18px;">star</span>
                    <h3 style="font-size:16px;font-weight:700;color:#fff;margin:0;">Best ${teamData.teamShort} Picks</h3>
                </div>
                ${teamData.bestPicks.slice(0, 3).map((p, i) => `
                    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;${i < 2 ? 'border-bottom:1px solid #1A2E28;' : ''}">
                        <div style="width:40px;height:40px;border-radius:50%;overflow:hidden;background:#2A2A2A;border:1px solid #333;flex-shrink:0;">
                            <img src="https://resources.premierleague.com/premierleague/photos/players/110x140/p${p.code}.png" alt="${p.name || p.web_name || 'FPL Player'} photo" onerror="this.src='football.ico'" style="width:100%;height:100%;object-fit:cover;">
                        </div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:700;font-size:14px;color:#fff;">${p.name}</div>
                            <div style="font-size:11px;color:#8ba396;font-family:var(--font-mono);">${p.position} · £${p.cost}m · F: ${p.form}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:14px;font-weight:700;color:#00FF85;font-family:var(--font-mono);">${p.xGI.toFixed(1)} xGI</div>
                        </div>
                    </div>
                `).join('')}
            `;
        };

        document.getElementById('home-picks-panel').innerHTML = renderPicks(home, true);
        document.getElementById('away-picks-panel').innerHTML = renderPicks(away, false);
    },

    changeGW(delta) {
        const newGW = (this.state.selectedGW || this.state.currentGW) + delta;
        if (newGW >= 1 && newGW <= 38) {
            this.state.selectedGW = newGW;
            document.querySelectorAll('#current-gw, #fixture-gw-display, #captain-gw-display, #zones-gw-display').forEach(el => {
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
        const weeklyRanks = m.weeklyRanks || [];
        const benchPts = m.weeklyPointsLostBench || [];
        const chips = m.managerInfo?.chipsUsed || [];
        const seasonHistory = m.seasonHistory || [];
        const info = m.managerInfo || {};

        if (weeklyPts.length === 0) {
            container.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><span class="material-symbols-outlined">history</span><p>No gameweek history available yet.</p></div></div></div>';
            return;
        }

        const totalPts = weeklyPts.reduce((a, b) => a + b, 0);
        const avgPts = (totalPts / weeklyPts.length).toFixed(1);
        const totalBench = benchPts.reduce((a, b) => a + b, 0);
        const bestGW = Math.max(...weeklyPts);
        const bestGWIdx = weeklyPts.indexOf(bestGW) + 1;
        const worstGW = Math.min(...weeklyPts.filter(p => p > 0));
        const worstGWIdx = weeklyPts.indexOf(worstGW) + 1;

        container.innerHTML = `<div style="display:flex;flex-direction:column;gap:20px;">
            <!-- Season Stats Banner -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:12px;">
                <div style="background:#141916;border:1px solid #1A2E28;border-radius:10px;padding:16px;text-align:center;">
                    <div style="font-size:0.7rem;color:#8ba396;text-transform:uppercase;font-family:var(--font-mono);letter-spacing:0.05em;margin-bottom:4px;">Total Points</div>
                    <div style="font-size:1.5rem;font-weight:700;color:#00FF85;font-family:var(--font-mono);">${totalPts}</div>
                </div>
                <div style="background:#141916;border:1px solid #1A2E28;border-radius:10px;padding:16px;text-align:center;">
                    <div style="font-size:0.7rem;color:#8ba396;text-transform:uppercase;font-family:var(--font-mono);letter-spacing:0.05em;margin-bottom:4px;">Avg / GW</div>
                    <div style="font-size:1.5rem;font-weight:700;color:#ffffff;font-family:var(--font-mono);">${avgPts}</div>
                </div>
                <div style="background:#141916;border:1px solid #1A2E28;border-radius:10px;padding:16px;text-align:center;">
                    <div style="font-size:0.7rem;color:#8ba396;text-transform:uppercase;font-family:var(--font-mono);letter-spacing:0.05em;margin-bottom:4px;">Best GW</div>
                    <div style="font-size:1.5rem;font-weight:700;color:#FFA600;font-family:var(--font-mono);">${bestGW}</div>
                    <div style="font-size:0.65rem;color:#6c8577;">GW${bestGWIdx}</div>
                </div>
                <div style="background:#141916;border:1px solid #1A2E28;border-radius:10px;padding:16px;text-align:center;">
                    <div style="font-size:0.7rem;color:#8ba396;text-transform:uppercase;font-family:var(--font-mono);letter-spacing:0.05em;margin-bottom:4px;">Bench Pts Lost</div>
                    <div style="font-size:1.5rem;font-weight:700;color:#E57373;font-family:var(--font-mono);">${totalBench}</div>
                </div>
            </div>

            <!-- GW History Table -->
            <div class="card">
                <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">calendar_today</span> Gameweek History</h3></div>
                <div class="card-body">
                    <div class="table-scroll-mobile">
                        <table style="width:100%;border-collapse:collapse;font-size:12px;">
                            <thead>
                                <tr style="border-bottom:2px solid #1A2E28;background:#1c211e;">
                                    <th style="text-align:center;font-family:var(--font-mono);font-size:9px;color:#8ba396;text-transform:uppercase;">GW</th>
                                    <th style="text-align:center;font-family:var(--font-mono);font-size:9px;color:#8ba396;text-transform:uppercase;">Points</th>
                                    <th style="text-align:center;font-family:var(--font-mono);font-size:9px;color:#8ba396;text-transform:uppercase;">Rank</th>
                                    <th style="text-align:center;font-family:var(--font-mono);font-size:9px;color:#8ba396;text-transform:uppercase;">Bench</th>
                                    <th style="text-align:center;font-family:var(--font-mono);font-size:9px;color:#8ba396;text-transform:uppercase;">Pts Bar</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${weeklyPts.map((pts, i) => {
                                    const rank = weeklyRanks[i] || 0;
                                    const bench = benchPts[i] || 0;
                                    const barWidth = bestGW > 0 ? Math.round((pts / bestGW) * 100) : 0;
                                    const ptsColor = pts >= 60 ? '#00FF85' : pts >= 40 ? '#FFA600' : pts >= 20 ? '#ffffff' : '#E57373';
                                    return `<tr style="border-bottom:1px solid #16251e;transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
                                        <td style="text-align:center;font-family:var(--font-mono);font-weight:700;color:#8ba396;font-size:10px;">${i + 1}</td>
                                        <td style="text-align:center;font-family:var(--font-mono);font-weight:700;color:${ptsColor};font-size:12px;">${pts}</td>
                                        <td style="text-align:center;font-family:var(--font-mono);color:#6c8577;font-size:10px;">${rank > 0 ? rank.toLocaleString() : '--'}</td>
                                        <td style="text-align:center;font-family:var(--font-mono);color:${bench > 0 ? '#E57373' : '#444'};font-size:10px;">${bench > 0 ? '-' + bench : '--'}</td>
                                        <td style="text-align:center;width:80px;">
                                            <div style="height:4px;background:#1A2E28;border-radius:2px;overflow:hidden;">
                                                <div style="height:100%;width:${barWidth}%;background:${ptsColor};border-radius:2px;transition:width 0.3s;"></div>
                                            </div>
                                        </td>
                                    </tr>`;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- Chips Used -->
            ${chips.length > 0 ? `
            <div class="card">
                <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">local_fire_department</span> Chips Used</h3></div>
                <div class="card-body">
                    <div style="display:flex;flex-wrap:wrap;gap:8px;">
                        ${chips.map(c => `<span style="display:inline-flex;align-items:center;gap:4px;padding:6px 12px;background:var(--md-sys-color-surface-container);border:1px solid var(--md-sys-color-outline-variant);border-radius:var(--radius-pill);font-size:0.8125rem;font-weight:600;color:var(--md-sys-color-on-surface);">${c}</span>`).join('')}
                    </div>
                </div>
            </div>` : ''}

            <!-- Past Seasons -->
            ${seasonHistory.length > 0 ? `
            <div class="card">
                <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">emoji_events</span> Past Seasons</h3></div>
                <div class="card-body">
                    <div class="table-scroll-mobile">
                        <table style="width:100%;border-collapse:collapse;font-size:12px;">
                            <thead>
                                <tr style="border-bottom:2px solid #1A2E28;background:#1c211e;">
                                    <th style="text-align:left;font-family:var(--font-mono);font-size:9px;color:#8ba396;text-transform:uppercase;">Season</th>
                                    <th style="text-align:center;font-family:var(--font-mono);font-size:9px;color:#8ba396;text-transform:uppercase;">Points</th>
                                    <th style="text-align:center;font-family:var(--font-mono);font-size:9px;color:#8ba396;text-transform:uppercase;">Rank</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${seasonHistory.map(s => `<tr style="border-bottom:1px solid #16251e;">
                                    <td style="font-weight:600;color:#ffffff;font-size:11px;">${s.season}</td>
                                    <td style="text-align:center;font-family:var(--font-mono);color:#00FF85;font-weight:700;font-size:11px;">${s.points?.toLocaleString() || '--'}</td>
                                    <td style="text-align:center;font-family:var(--font-mono);color:#6c8577;font-size:11px;">${s.rank?.toLocaleString() || '--'}</td>
                                </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>` : ''}
        </div>`;
    },

    initSettings() {
        const container = document.getElementById('settings-section');
        if (!container) return;
        const m = this.state.managerData;
        const gw = this.state.selectedGW || this.state.currentGW || 1;

        container.innerHTML = `<div style="display:flex;flex-direction:column;gap:20px;">
            <!-- Connection Card -->
            <div class="card">
                <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">link</span> Connection</h3></div>
                <div class="card-body">
                    <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--md-sys-color-surface-container);border-radius:var(--radius-md);margin-bottom:16px;">
                        <span style="width:10px;height:10px;border-radius:50%;background:${this.state.managerId ? '#00FF85' : '#666'};box-shadow:${this.state.managerId ? '0 0 8px #00FF85' : 'none'};"></span>
                        <span style="font-weight:600;color:var(--md-sys-color-on-surface);">${this.state.managerId ? 'Connected' : 'Not Connected'}</span>
                        ${m?.managerInfo?.name ? `<span style="color:var(--md-sys-color-on-surface-variant);margin-left:auto;">${m.managerInfo.name}</span>` : ''}
                    </div>
                    <div class="input-group mb-md">
                        <label class="input-label">FPL Manager ID</label>
                        <div style="display:flex;gap:8px;">
                            <input type="number" class="input" id="settings-manager-id" placeholder="e.g. 123456" value="${this.state.managerId || ''}" style="flex:1;">
                            <button class="btn btn-primary" onclick="FPL.updateManagerId()">Save</button>
                        </div>
                        <small style="color:var(--md-sys-color-on-surface-variant);">Find your ID in the URL on the FPL website.</small>
                    </div>
                    <div class="input-group">
                        <label class="input-label">League ID (optional)</label>
                        <div style="display:flex;gap:8px;">
                            <input type="number" class="input" id="settings-league-id" placeholder="e.g. 314" value="${this.state.leagueId || ''}" style="flex:1;">
                            <button class="btn btn-primary" onclick="FPL.updateLeagueId()">Save</button>
                        </div>
                        <small style="color:var(--md-sys-color-on-surface-variant);">Classic League ID for standings view.</small>
                    </div>
                </div>
            </div>

            <!-- Preferences Card -->
            <div class="card">
                <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">tune</span> Preferences</h3></div>
                <div class="card-body">
                    <div class="input-group mb-md">
                        <label class="input-label">Default Formation</label>
                        <select class="input" id="settings-formation" onchange="FPL.saveSetting('formation', this.value)">
                            <option value="4231" ${this.getSetting('formation') === '4231' ? 'selected' : ''}>4-2-3-1</option>
                            <option value="352" ${this.getSetting('formation') === '352' ? 'selected' : ''}>3-5-2</option>
                            <option value="433" ${this.getSetting('formation') === '433' ? 'selected' : ''}>4-3-3</option>
                        </select>
                    </div>
                    <div class="input-group mb-md">
                        <label class="input-label">Price Display</label>
                        <select class="input" id="settings-price-format" onchange="FPL.saveSetting('priceFormat', this.value)">
                            <option value="decimal" ${this.getSetting('priceFormat') === 'decimal' ? 'selected' : ''}>Decimal (e.g. 7.5)</option>
                            <option value="integer" ${this.getSetting('priceFormat') === 'integer' ? 'selected' : ''}>Integer (e.g. 75)</option>
                        </select>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--md-sys-color-outline-variant);">
                        <div>
                            <div style="font-weight:600;color:var(--md-sys-color-on-surface);">Auto-refresh Data</div>
                            <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Refresh data every 5 minutes</div>
                        </div>
                        <label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer;">
                            <input type="checkbox" id="settings-auto-refresh" onchange="FPL.saveSetting('autoRefresh', this.checked)" ${this.getSetting('autoRefresh') ? 'checked' : ''} style="opacity:0;width:0;height:0;">
                            <span style="position:absolute;inset:0;background:${this.getSetting('autoRefresh') ? '#00FF85' : '#444'};border-radius:13px;transition:0.3s;"></span>
                            <span style="position:absolute;top:3px;left:${this.getSetting('autoRefresh') ? '25px' : '3px'};width:20px;height:20px;background:#fff;border-radius:50%;transition:0.3s;"></span>
                        </label>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;">
                        <div>
                            <div style="font-weight:600;color:var(--md-sys-color-on-surface);">Show Player Photos</div>
                            <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Load player images in tables</div>
                        </div>
                        <label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer;">
                            <input type="checkbox" id="settings-show-photos" onchange="FPL.saveSetting('showPhotos', this.checked)" ${this.getSetting('showPhotos') !== false ? 'checked' : ''} style="opacity:0;width:0;height:0;">
                            <span style="position:absolute;inset:0;background:${this.getSetting('showPhotos') !== false ? '#00FF85' : '#444'};border-radius:13px;transition:0.3s;"></span>
                            <span style="position:absolute;top:3px;left:${this.getSetting('showPhotos') !== false ? '25px' : '3px'};width:20px;height:20px;background:#fff;border-radius:50%;transition:0.3s;"></span>
                        </label>
                    </div>
                </div>
            </div>

            <!-- Data Management Card -->
            <div class="card">
                <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">storage</span> Data Management</h3></div>
                <div class="card-body">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--md-sys-color-outline-variant);">
                        <div>
                            <div style="font-weight:600;color:var(--md-sys-color-on-surface);">Cached Data</div>
                            <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Manager, league, and player data</div>
                        </div>
                        <span style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);font-family:var(--font-mono);">${this.state.managerId ? 'In use' : 'Empty'}</span>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;">
                        <div>
                            <div style="font-weight:600;color:var(--md-sys-color-on-surface);">Clear All Data</div>
                            <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Reset all saved preferences and cached data</div>
                        </div>
                        <button class="btn btn-outline" onclick="FPL.clearData()" style="border-color:var(--md-sys-color-error);color:var(--md-sys-color-error);">Clear</button>
                    </div>
                </div>
            </div>

            <!-- About Card -->
            <div class="card">
                <div class="card-header"><h3><span class="material-symbols-outlined" style="font-size:20px;color:var(--md-sys-color-primary);">info</span> About</h3></div>
                <div class="card-body">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
                        <span class="material-symbols-outlined" style="font-size:32px;color:#00FF85;">sports_soccer</span>
                        <div>
                            <div style="font-weight:700;color:var(--md-sys-color-on-surface);font-size:16px;">FPL Manager Stats</div>
                            <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">v1.0.0</div>
                        </div>
                    </div>
                    <p style="font-size:0.8125rem;color:var(--md-sys-color-on-surface-variant);line-height:1.5;">Advanced analytics and insights for Fantasy Premier League managers. Track your performance, analyze fixtures, and make data-driven decisions.</p>
                </div>
            </div>
        </div>`;
    },

    getSetting(key) {
        const val = localStorage.getItem('fpl_' + key);
        if (val === null) return key === 'showPhotos' ? true : key === 'autoRefresh' ? false : '4231';
        if (val === 'true') return true;
        if (val === 'false') return false;
        return val;
    },

    saveSetting(key, value) {
        localStorage.setItem('fpl_' + key, value);
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
