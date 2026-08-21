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
        decisionData: null,
        decisionView: 'overview',
        currentGW: null,
        selectedGW: null,
        selectedFixtureId: null,
        teamMap: {},
        playerMap: {},
        fotmobPlayerIds: {},
        fotmobUnavailablePhotos: new Set(),
        positionMap: { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' },
        isLoading: false,
        error: null,
        activeTab: 'general',
        managerId: localStorage.getItem('fplManagerId') || null,
        leagueId: localStorage.getItem('fplLeagueId') || null,
        theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
        aiTeamGWView: 1
    },

    // Client-side tab data cache (avoids re-fetching when switching tabs)
    _tabCache: new Map(),
    _tabCacheTTL: 2 * 60 * 1000, // 2 minutes

    getCachedTabData(key) {
        const cached = this._tabCache.get(key);
        if (cached && Date.now() - cached.ts < this._tabCacheTTL) return cached.data;
        this._tabCache.delete(key);
        return null;
    },

    setCachedTabData(key, data) {
        this._tabCache.set(key, { data, ts: Date.now() });
    },

    invalidateTabCache(key) {
        if (key) this._tabCache.delete(key);
        else this._tabCache.clear();
    },

    API: {
        bootstrap: '/api/bootstrap-static',
        fixtures: '/api/fixtures',
        analyzeManager: (id) => `/api/analyze-manager/${id}`,
        leagueStandings: (id) => `/api/league-standings/${id}`,
        zoneAnalysis: (gw) => `/api/zone-analysis?gw=${gw || ''}`,
        fixturesDetail: (gw) => `/api/fixtures-detail?gw=${gw || ''}`,
        teamProjections: (gw) => `/api/team-projections?gw=${gw || ''}`,
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
        priceChanges: '/api/price-changes',
        decisionCentre: '/api/v1/decision-centre',
        aiTeam: '/api/ai-team',
        goalsProjections: (gw, horizon) => `/api/goals-projections?gw=${gw || ''}&horizon=${horizon || 6}`,
        goalsConceded: (gw, horizon) => `/api/goals-conceded?gw=${gw || ''}&horizon=${horizon || 6}`,
        rollingFDR: (gw) => `/api/rolling-fdr?gw=${gw || ''}`,
        managerLookup: (id) => `/api/manager-lookup/${id}`,
        managerLeagues: (id) => `/api/manager-leagues/${id}`,
    },

    async apiFetch(url) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await window.fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.error(`Fetch error for ${url}:`, err);
            if (err.name === 'AbortError') throw new Error('The FPL data request timed out. Please try again.');
            throw err;
        } finally {
            clearTimeout(timeout);
        }
    },

    async apiPost(url, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        try {
            const res = await window.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } finally {
            clearTimeout(timeout);
        }
    },

    async init() {
        // The application shell is usable while base data hydrates in the background.
        this.hideLoading();
        this.state.playerFilter = 'all';
        const setupDeadlineCountdown = (deadlineTime) => {
            if (!deadlineTime) return false;
            const deadlineDate = new Date(deadlineTime);
            if (Number.isNaN(deadlineDate.getTime())) return false;
            localStorage.setItem('fplDeadlineTime', deadlineDate.toISOString());
            const dlEl = document.getElementById('deadline-time');
            if (dlEl) {
                dlEl.textContent = deadlineDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            }
            this.startCountdown(deadlineDate);
            return true;
        };

        setupDeadlineCountdown(localStorage.getItem('fplDeadlineTime'));
        this.apiFetch(this.API.deadline)
            .then(deadline => setupDeadlineCountdown(deadline?.deadlineTime))
            .catch(() => {});

        try {
            const [bootstrap, fixtures, fotmobData] = await Promise.all([
                this.apiFetch(this.API.bootstrap),
                this.apiFetch(this.API.fixtures),
                this.apiFetch('/fotmob-player-ids.json').catch(() => null)
            ]);

            this.state.fotmobPlayerIds = fotmobData?.byOptaId || {};
            this.state.fotmobUnavailablePhotos = new Set(fotmobData?.unavailablePhotoOptaIds || []);

            const currentEvent = bootstrap.events?.find(e => e.is_current);
            const nextEvent = bootstrap.events?.find(e => e.is_next);
            const futureEvent = bootstrap.events?.find(e => e.deadline_time && new Date(e.deadline_time).getTime() > Date.now());
            const deadline = {
                currentGW: currentEvent?.id || nextEvent?.id || 1,
                deadlineTime: futureEvent?.deadline_time || nextEvent?.deadline_time || null
            };

            this.state.bootstrapData = bootstrap;
            this.state.fixtures = fixtures;
            this.state.currentGW = deadline.currentGW;
            this.state.selectedGW = this.state.currentGW;

            // Build team and player maps
            bootstrap.teams.forEach(t => { this.state.teamMap[t.id] = t; });
            bootstrap.elements.forEach(p => {
                this.state.playerMap[p.id] = p;
                p.fotmobId = this.state.fotmobPlayerIds[String(p.code)] || null;
                p.teamName = this.state.teamMap[p.team]?.name || '';
                p.teamShort = this.state.teamMap[p.team]?.short_name || '';
                p.positionName = this.state.positionMap[p.element_type] || '';
            });

            // Update deadline display and start countdown
            if (!setupDeadlineCountdown(deadline.deadlineTime)) {
                // Fallback: fetch deadline independently if initial load failed
                this.apiFetch(this.API.deadline).then(dl => setupDeadlineCountdown(dl?.deadlineTime)).catch(() => {});
            }

            // Refresh deadline every 5 minutes to stay accurate
            if (this._deadlineRefreshInterval) clearInterval(this._deadlineRefreshInterval);
            this._deadlineRefreshInterval = setInterval(() => {
                this.apiFetch(this.API.deadline).then(dl => setupDeadlineCountdown(dl?.deadlineTime)).catch(() => {});
            }, 5 * 60 * 1000);

            // Populate GW jump selector
            this.updateFixtureGWJump();

            // Load manager data if connected
            if (this.state.managerId) {
                void this.loadManagerData(this.state.managerId).then(() => {
                    this.refreshConnectionUI();
                    if (this.state.activeTab === 'manager') this.renderTeamAnalysis();
                });
            }

        } catch (err) {
            this.state.error = err.message;
            this.showError(err.message || 'Unable to load FPL data');
        } finally {
            this.hideLoading();
        }
    },

    async loadManagerData(managerId) {
        try {
            const cacheKey = `manager-${managerId}`;
            let data = this.getCachedTabData(cacheKey);
            if (!data) {
                data = await this.apiFetch(this.API.analyzeManager(managerId));
                this.setCachedTabData(cacheKey, data);
                // Save connected manager to DB for name search
                window.fetch('/api/save-manager', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        managerId: Number(managerId),
                        teamName: data.managerInfo?.teamName || null,
                        playerFirstName: data.managerInfo?.playerFirstName || null,
                        playerLastName: data.managerInfo?.playerLastName || null,
                        overallPoints: data.managerInfo?.overallPoints || null,
                        overallRank: data.managerInfo?.overallRank || null,
                        leagueId: this.state.leagueId ? Number(this.state.leagueId) : null
                    })
                }).catch(() => {});
            }
            this.state.managerData = data;
            this.state.managerId = managerId;
            localStorage.setItem('fplManagerId', managerId);

            // Update manager ID display in sidebar
            const display = document.getElementById('manager-id-display');
            if (display) {
                display.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#00FF85;box-shadow:0 0 6px #00FF85;"></span> ${this.escapeHTML(data.managerInfo?.name || 'Manager ' + managerId)}</span>`;
            }

            // Update topbar connect button to show connected state
            const topbarBtn = document.querySelector('.topbar-right .btn-primary');
            if (topbarBtn) {
                topbarBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;color:#00FF85;">check_circle</span> ${this.escapeHTML(data.managerInfo?.teamName || 'Connected')}`;
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

    refreshConnectionUI() {
        const id = this.state.managerId;
        const data = this.state.managerData;

        // Update sidebar manager ID display
        const display = document.getElementById('manager-id-display');
        if (display) {
            if (id) {
                display.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:#00FF85;box-shadow:0 0 6px #00FF85;"></span> ${this.escapeHTML(data?.managerInfo?.name || 'Manager ' + id)}</span>`;
            } else {
                display.textContent = 'No manager connected';
            }
        }

        // Update topbar connect button
        const topbarBtn = document.querySelector('.topbar-right .btn-primary');
        if (topbarBtn) {
            if (id) {
                topbarBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;color:#00FF85;">check_circle</span> ${this.escapeHTML(data?.managerInfo?.teamName || 'Connected')}`;
                topbarBtn.onclick = () => this.showDialog('connect-dialog');
                topbarBtn.style.background = 'rgba(0,255,133,0.12)';
                topbarBtn.style.border = '1px solid rgba(0,255,133,0.3)';
                topbarBtn.style.color = '#00FF85';
            } else {
                topbarBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">link</span> Connect`;
                topbarBtn.onclick = () => this.showDialog('connect-dialog');
                topbarBtn.style.background = '';
                topbarBtn.style.border = '';
                topbarBtn.style.color = '';
            }
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
        void label;
    },

    hideLoading() {
        if (this.loaderInterval) {
            clearInterval(this.loaderInterval);
            this.loaderInterval = null;
        }
    },

    startCountdown(deadlineDate) {
        if (!(deadlineDate instanceof Date) || Number.isNaN(deadlineDate.getTime())) return;

        this._countdownDeadline = deadlineDate;

        const update = () => {
            // Resolve the element on every tick because the React shell can remount it.
            const countdownEl = document.getElementById('dash-countdown');
            const dateEl = document.getElementById('dash-deadline-date');
            if (!countdownEl) return;

            if (dateEl) {
                dateEl.textContent = deadlineDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            }
            const now = new Date();
            const diff = deadlineDate - now;
            if (diff <= 0) {
                countdownEl.textContent = 'UPDATING';
                countdownEl.style.color = '#FFA600';
                countdownEl.style.textShadow = 'none';
                const canRefresh = !this._deadlineRefreshAttempt || Date.now() - this._deadlineRefreshAttempt >= 15000;
                if (!this._deadlineRefreshPending && canRefresh) {
                    this._deadlineRefreshPending = true;
                    this._deadlineRefreshAttempt = Date.now();
                    this.apiFetch(this.API.deadline)
                        .then(next => {
                            const nextDate = new Date(next?.deadlineTime);
                            if (!Number.isNaN(nextDate.getTime()) && nextDate > new Date()) this.startCountdown(nextDate);
                        })
                        .catch(() => {})
                        .finally(() => { this._deadlineRefreshPending = false; });
                }
                return;
            }
            countdownEl.style.color = '#00ff85';
            countdownEl.style.textShadow = 'none';
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
        if (!this._countdownLifecycleReady) {
            const resumeCountdown = () => {
                this._countdownUpdate?.();
            };
            document.addEventListener('visibilitychange', resumeCountdown);
            window.addEventListener('pageshow', resumeCountdown);
            this._countdownLifecycleReady = true;
        }
        this._countdownUpdate = update;
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

    formatPriceDisplay(costStr, cost) {
        if (costStr && typeof costStr === 'string') {
            const clean = costStr.replace(/^[^d£]+/, '£').replace(/^Â£/, '£');
            if (clean.startsWith('£')) return clean;
            if (/^\d/.test(clean)) return '£' + clean;
            return clean;
        }
        if (typeof cost === 'number' && !isNaN(cost)) {
            const val = cost > 30 ? cost / 10 : cost;
            return `£${val.toFixed(1)}m`;
        }
        return '£0.0m';
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

    getTeamLogo(shortName) {
        const logos = {
            'ARS': 'Arsenal%20FC.png', 'AVL': 'Aston%20Villa.png', 'BOU': 'AFC%20Bournemouth.png',
            'BRE': 'Brentford%20FC.png', 'BHA': 'Brighton%20%26%20Hove%20Albion.png',
            'CHE': 'Chelsea%20FC.png', 'COV': 'Coventry%20City.png', 'CRY': 'Crystal%20Palace.png',
            'EVE': 'Everton%20FC.png', 'FUL': 'Fulham%20FC.png', 'HUL': 'Hull%20City.png',
            'IPS': 'Ipswich%20Town.png', 'LEE': 'Leeds%20United.png', 'LIV': 'Liverpool%20FC.png',
            'MCI': 'Manchester%20City.png', 'MUN': 'Manchester%20United.png', 'NEW': 'Newcastle%20United.png',
            'NFO': 'Nottingham%20Forest.png', 'SUN': 'Sunderland%20AFC.png', 'TOT': 'Tottenham%20Hotspur.png',
            'WOL': 'Wolverhampton%20Wanderers.png'
        };
        const file = logos[shortName];
        if (!file) return '';
        return 'https://raw.githubusercontent.com/luukhopman/football-logos/master/logos/England%20-%20Premier%20League/' + file;
    },

    teamBadge(shortName, size) {
        size = size || 24;
        const url = this.getTeamLogo(shortName);
        if (!url) return '<span style="display:inline-block;width:' + size + 'px;height:' + size + 'px;border-radius:4px;background:#1c211e;border:1px solid #1A2E28;"></span>';
        return '<img src="' + url + '" style="width:' + size + 'px;height:' + size + 'px;border-radius:4px;object-fit:contain;background:#1c211e;border:1px solid #1A2E28;" onerror="this.style.display=\'none\'">';
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
        const validTabs = ['general', 'manager', 'decision', 'league', 'players', 'zones', 'fixtures', 'teamnews', 'captain', 'ownership', 'setpieces', 'aiteam'];
        if (!validTabs.includes(tab)) tab = 'general';
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

        // Ensure connection UI is always in sync
        this.refreshConnectionUI();

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
            case 'general': return this.renderGeneral();
            case 'players': return this.renderPlayers();
            case 'league': return this.renderLeague();
            case 'fixtures': return this.renderFixtures();
            case 'teamnews': return this.renderTeamNews();
            case 'captain': return this.renderCaptaincy();
            case 'ownership': return this.renderOwnership();
            case 'zones': return this.renderZones();
            case 'manager': return this.renderTeamAnalysis();
            case 'decision': return this.renderDecisionCentre();
            case 'setpieces': return this.renderSetPieces();
            case 'aiteam': return this.renderAITeam();
        }
    },

    toggleTheme() {
        const nextTheme = this.state.theme === 'light' ? 'dark' : 'light';
        this.state.theme = nextTheme;
        document.documentElement.dataset.theme = nextTheme;
        document.documentElement.classList.toggle('dark', nextTheme === 'dark');
        localStorage.setItem('theme', nextTheme);
        localStorage.setItem('fplTheme', nextTheme);
        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) themeMeta.setAttribute('content', nextTheme === 'light' ? '#f7faf8' : '#0f1412');
        document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
            button.setAttribute('aria-label', 'Toggle theme');
            button.setAttribute('title', nextTheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
            button.classList.toggle('is-dark', nextTheme === 'dark');
        });
    },

    async setSquadView(view) {
        const loading = document.getElementById('aiteam-loading');
        const results = document.getElementById('aiteam-results');
        const errorEl = document.getElementById('aiteam-error');
        loading?.classList.remove('hidden');
        results?.classList.add('hidden');
        errorEl?.classList.add('hidden');
        await this.loadAITeam(false);
    },

    normalizeAITeamData(data) {
        const lineup = data?.lineup || {};
        const squad = Array.isArray(data?.squad) ? data.squad : [];
        const starters = Array.isArray(lineup.starters) ? lineup.starters : [];
        const bench = Array.isArray(lineup.bench) ? lineup.bench : [];
        if (squad.length !== 15 || starters.length !== 11 || bench.length !== 4) return null;
        return {
            ...data,
            isLocked: Boolean(data.isLocked ?? data.meta?.isAutoLocked),
            meta: { ...(data.meta || {}), isAutoLocked: Boolean(data.isLocked ?? data.meta?.isAutoLocked) },
            transfers: data.transfers?.plan ? data.transfers : { plan: [] },
            chips: data.chips?.schedule ? data.chips : { schedule: [] },
        };
    },

    renderAITeam() {
        return this.loadAITeam();
    },

    async loadAITeam(force = false) {
        const loading = document.getElementById('aiteam-loading');
        const results = document.getElementById('aiteam-results');
        const errorEl = document.getElementById('aiteam-error');
        loading?.classList.remove('hidden');
        loading?.setAttribute('aria-busy', 'true');
        results?.classList.add('hidden');
        errorEl?.classList.add('hidden');
        try {
            let data;
            if (!force) {
                try {
                    const saved = await this.apiFetch(this.API.aiTeam);
                    data = saved?.saved ? this.normalizeAITeamData(saved) : null;
                } catch (e) {
                    console.warn('Saved AI Team unavailable, rebuilding:', e.message);
                }
            }
            if (!data) {
                const horizon = Number(document.getElementById('aiteam-horizon')?.value) || 5;
                const strategy = document.getElementById('aiteam-strategy')?.value || 'balanced';
                data = await this.apiPost(this.API.aiTeam, { horizon, strategy, rebuild: force });
                data = this.normalizeAITeamData(data);
            }
            if (!data) throw new Error('The AI returned an incomplete squad. Rebuild again after the latest FPL data loads.');

            this.state.aiTeamData = data;
            if (!this.state.aiTeamGWView) this.state.aiTeamGWView = 1;
            this.paintAITeam(data);
            results?.classList.remove('hidden');
        } catch (error) {
            console.error('AI Team error:', error);
            if (errorEl) {
                errorEl.classList.remove('hidden');
                errorEl.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">error</span><div><strong>AI Team unavailable</strong><p>${this.escapeHTML(error.message || 'Try again shortly.')}</p><button type="button" class="aiteam-secondary-btn" onclick="FPL.loadAITeam(true)">Try again</button></div>`;
            }
        } finally {
            loading?.classList.add('hidden');
            loading?.setAttribute('aria-busy', 'false');
        }
    },

    setAITeamGWView(gws) {
        this.state.aiTeamGWView = gws;
        document.querySelectorAll('.aiteam-gw-pill').forEach(btn => {
            const val = parseInt(btn.dataset.gw);
            btn.classList.toggle('active', val === gws || (gws > 1 && val === gws));
        });
        const data = this.state.aiTeamData;
        if (data) this.paintAITeam(data);
    },

    setAITeamView(view) {
        document.querySelectorAll('.aiteam-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
        document.querySelectorAll('.aiteam-view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
    },

    async suggestAITeamTransfer(playerId) {
        const data = this.state.aiTeamData;
        const bootstrap = this.state.bootstrapData;
        if (!data || !bootstrap) return;
        const player = [...data.lineup.starters, ...data.lineup.bench].find(p => p.id === playerId);
        if (!player) return;
        const gwView = this.state.aiTeamGWView || 1;
        const allPlayers = bootstrap.elements || [];
        const teams = bootstrap.teams || [];
        const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        const posId = Object.entries(posMap).find(([, v]) => v === player.position)?.[0];
        const squadIds = new Set(data.squad.map(p => p.id));
        const budget = 100 - data.teamCost + player.cost;
        const candidates = allPlayers
            .filter(p => p.id !== playerId && !squadIds.has(p.id) && String(p.element_type) === String(posId) && (p.now_cost / 10) <= budget)
            .map(p => {
                const team = teams.find(t => t.id === p.team);
                const fixtures = (data.transfers?.plan || []).length > 0 ? [] : [];
                const totalXpts = parseFloat(p.total_points || 0) * 0.5 + parseFloat(p.form || 0) * 3;
                return { id: p.id, name: p.web_name, team: team?.short_name || '?', cost: p.now_cost / 10, xPts: totalXpts, form: parseFloat(p.form || 0) };
            })
            .sort((a, b) => b.xPts - a.xPts)
            .slice(0, 5);
        const body = document.getElementById('player-detail-body');
        if (!body) return;
        const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };
        body.innerHTML = `
            <div style="padding:16px 20px;background:var(--md-sys-color-surface-container-high);border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <span class="material-symbols-outlined" style="color:#ff4d4d;">swap_horiz</span>
                    <span style="font-weight:700;color:#fff;font-size:15px;">Replace ${player.name}</span>
                </div>
                <div style="font-size:12px;color:#8ba396;">${player.position} · ${player.teamFull || player.team} · £${player.cost?.toFixed(1)}m · ${(player.totalXpts || 0).toFixed(1)} horizon xPts</div>
            </div>
            <div style="padding:12px 20px;">
                <div style="font-size:11px;font-weight:700;color:#8ba396;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;font-family:var(--font-mono);">Suggested Replacements (${player.position})</div>
                ${candidates.length ? candidates.map(c => {
                    const gain = c.xPts - (player.totalXpts || 0);
                    const gainClass = gain >= 0 ? 'positive' : 'negative';
                    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                        <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                            <span style="padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;background:${posColors[player.position]}20;color:${posColors[player.position]};">${player.position}</span>
                            <div style="min-width:0;"><div style="font-weight:600;font-size:13px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.name}</div><div style="font-size:10px;color:#8ba396;">${c.team} · £${c.cost.toFixed(1)}m · Form ${c.form.toFixed(1)}</div></div>
                        </div>
                        <div style="display:flex;align-items:center;gap:10px;">
                            <span class="aiteam-transfer-gain ${gainClass}">${gain >= 0 ? '+' : ''}${gain.toFixed(1)}</span>
                            <button class="aiteam-transfer-apply" onclick="FPL.applyAITeamSwap(${playerId},${c.id})">Apply</button>
                        </div>
                    </div>`;
                }).join('') : '<div class="aiteam-empty-state"><span class="material-symbols-outlined">search_off</span><p>No suitable replacements found within budget.</p></div>'}
            </div>`;
        this.showDialog('player-detail-dialog');
    },

    async applyAITeamSwap(outId, inId) {
        const data = this.state.aiTeamData;
        const bootstrap = this.state.bootstrapData;
        if (!data || !bootstrap) return;
        const inPlayer = bootstrap.elements.find(p => p.id === inId);
        if (!inPlayer) return;
        const team = bootstrap.teams.find(t => t.id === inPlayer.team);
        const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        const outIdx = data.squad.findIndex(p => p.id === outId);
        if (outIdx < 0) return;
        const oldPlayer = data.squad[outIdx];
        const newPlayer = {
            id: inPlayer.id, name: inPlayer.web_name, team: inPlayer.team, teamFull: team?.name || team?.short_name || '?',
            position: posMap[inPlayer.element_type] || 'MID', cost: inPlayer.now_cost / 10,
            form: parseFloat(inPlayer.form || 0), totalXpts: parseFloat(inPlayer.total_points || 0) * 0.5 + parseFloat(inPlayer.form || 0) * 3,
            weekly: oldPlayer.weekly || [], upcomingFixtures: oldPlayer.upcomingFixtures || [], status: inPlayer.status || 'a', news: inPlayer.news || ''
        };
        data.squad[outIdx] = newPlayer;
        const lineStarters = data.lineup.starters.findIndex(p => p.id === outId);
        const lineBench = data.lineup.bench.findIndex(p => p.id === outId);
        if (lineStarters >= 0) data.lineup.starters[lineStarters] = newPlayer;
        else if (lineBench >= 0) data.lineup.bench[lineBench] = newPlayer;
        data.teamCost = data.teamCost - oldPlayer.cost + newPlayer.cost;
        this.hideDialog('player-detail-dialog');
        this.paintAITeam(data);
    },

    paintAITeam(data) {
        const { squad, lineup, meta, chips, transfers, teamCost, teamXpts, formation, isLocked } = data;
        const gwView = this.state.aiTeamGWView || 1;
        const totalGWs = lineup.starters[0]?.weekly?.length || 5;

        function sumPlayerXPts(player, count) {
            if (!player?.weekly) return 0;
            return player.weekly.slice(0, count).reduce((s, w) => s + (w.xPts || 0), 0);
        }
        function fdrColor(fdr) {
            if (fdr <= 2) return '#00FF85';
            if (fdr <= 3) return '#FFA726';
            return '#ff4d4d';
        }

        // --- Summary Bar ---
        const summaryEl = document.getElementById('aiteam-summary');
        if (summaryEl) {
            const startersXPts = lineup.starters.reduce((s, p) => s + sumPlayerXPts(p, gwView), 0);
            const captainBonus = lineup.captain ? sumPlayerXPts(lineup.captain, gwView) : 0;
            const predictedPts = startersXPts + captainBonus;
            const remaining = Math.round((100 - teamCost) * 10) / 10;
            const autoLocked = Boolean(isLocked ?? meta?.isAutoLocked);
            summaryEl.innerHTML = `
                <div class="aiteam-card"><div class="aiteam-card-icon" style="background:rgba(0,255,133,0.12);color:#00FF85;"><span class="material-symbols-outlined">payments</span></div><div class="aiteam-card-data"><span class="aiteam-card-value">\u00A3${teamCost.toFixed(1)}m</span><span class="aiteam-card-label">\u00A3${remaining.toFixed(1)}m left</span></div></div>
                <div class="aiteam-card"><div class="aiteam-card-icon" style="background:rgba(79,195,247,0.12);color:#4FC3F7;"><span class="material-symbols-outlined">trending_up</span></div><div class="aiteam-card-data"><span class="aiteam-card-value">${predictedPts.toFixed(1)}</span><span class="aiteam-card-label">${gwView === 1 ? 'Next GW' : gwView + ' GWs'} xPts</span></div></div>
                <div class="aiteam-card"><div class="aiteam-card-icon" style="background:rgba(192,132,252,0.12);color:#c084fc;"><span class="material-symbols-outlined">emoji_events</span></div><div class="aiteam-card-data"><span class="aiteam-card-value">${teamXpts.toFixed(1)}</span><span class="aiteam-card-label">Horizon xPts</span></div></div>
                <div class="aiteam-card aiteam-status-card" aria-label="AI team status"><div class="aiteam-card-icon" style="background:rgba(255,167,38,0.12);color:#FFA726;"><span class="material-symbols-outlined">${autoLocked ? 'lock' : 'auto_awesome'}</span></div><div class="aiteam-card-data"><span class="aiteam-card-value" style="font-size:12px;">${autoLocked ? 'LOCKED' : 'AI BUILT'}</span><span class="aiteam-card-label">${autoLocked ? 'Auto-selected for GW1' : 'Built from live data'}</span></div></div>`;
        }

        // --- Formation Label ---
        const formLabel = document.getElementById('aiteam-formation-label');
        if (formLabel) formLabel.textContent = formation || '4-4-2';

        // --- Captain Display ---
        const captainDisp = document.getElementById('aiteam-captain-display');
        if (captainDisp && lineup.captain) {
            const cap = lineup.captain;
            captainDisp.innerHTML = `<span class="material-symbols-outlined">star</span> <strong>${cap.name}</strong> \u00B7 ${sumPlayerXPts(cap, gwView).toFixed(1)} xPts`;
        }

        // --- GW Selector ---
        const gwToggle = document.getElementById('aiteam-gw-toggle');
        if (gwToggle) {
            const pills = [];
            pills.push(`<button class="aiteam-gw-pill${gwView === 1 ? ' active' : ''}" data-gw="1" onclick="FPL.setAITeamGWView(1)">1 GW</button>`);
            if (totalGWs >= 3) pills.push(`<button class="aiteam-gw-pill${gwView === 3 ? ' active' : ''}" data-gw="3" onclick="FPL.setAITeamGWView(3)">3 GWs</button>`);
            if (totalGWs >= 5) pills.push(`<button class="aiteam-gw-pill${gwView === 5 ? ' active' : ''}" data-gw="5" onclick="FPL.setAITeamGWView(5)">5 GWs</button>`);
            if (totalGWs >= 8) pills.push(`<button class="aiteam-gw-pill${gwView === 8 ? ' active' : ''}" data-gw="8" onclick="FPL.setAITeamGWView(8)">8 GWs</button>`);
            gwToggle.innerHTML = pills.join('');
        }

        // --- Pitch ---
        const pitchEl = document.getElementById('aiteam-pitch');
        if (pitchEl) {
            const gkps = lineup.starters.filter(p => p.position === 'GKP');
            const defs = lineup.starters.filter(p => p.position === 'DEF');
            const mids = lineup.starters.filter(p => p.position === 'MID');
            const fwds = lineup.starters.filter(p => p.position === 'FWD');
            const isCaptain = (p) => lineup.captain && p.id === lineup.captain.id;
            const isVice = (p) => lineup.viceCaptain && p.id === lineup.viceCaptain.id;

            function playerCard(player) {
                const cap = isCaptain(player);
                const vice = isVice(player);
                const badge = cap ? ' (C)' : vice ? ' (V)' : '';
                const borderStyle = cap ? 'border:2px solid #FFD700;box-shadow:0 0 12px rgba(255,215,0,0.4);' : vice ? 'border:2px solid rgba(255,255,255,0.5);' : 'border:1px solid rgba(255,255,255,0.28);';
                const xPts = sumPlayerXPts(player, gwView).toFixed(1);
                const shirt = FPL.playerTeamShirtUrl(player);
                const shirtImg = shirt ? `<img src="${shirt}" alt="" loading="lazy" decoding="async" onerror="this.closest('.tactics-player-shirt').classList.add('is-missing');this.remove();" style="width:100%;height:100%;object-fit:contain;">` : '';
                const weekly = player.weekly || [];
                const fixtures = player.upcomingFixtures || [];
                const fixtureRows = [];
                for (let i = 0; i < Math.min(gwView, weekly.length); i++) {
                    const w = weekly[i];
                    const fx = fixtures.find(f => f.gw === w.gameweek) || fixtures[i];
                    if (!fx) continue;
                    const col = fdrColor(fx.fdr);
                    const oppLabel = fx.home ? `${fx.opponent}(H)` : `${fx.opponent}(A)`;
                    fixtureRows.push(`<div class="aiteam-fixture-row"><span class="aiteam-fixture-opp" style="color:${col};">${oppLabel}</span><span class="aiteam-fixture-xpts">${w.xPts.toFixed(1)}</span></div>`);
                }
                const runLen = player.consecutiveGoodFixtures || 0;
                const runBadge = runLen >= 4 ? `<span style="font-size:8px;padding:1px 4px;border-radius:3px;background:rgba(0,255,133,0.15);color:#00FF85;font-weight:700;position:absolute;top:2px;right:2px;">${runLen} RUN</span>` : '';
                return `<div class="tactics-player-card home aiteam-pitch-card" style="${borderStyle}position:relative;cursor:pointer;" onclick="FPL.showPlayerDetail(${player.id})" title="${player.name}${badge} \u00B7 \u00A3${(player.cost || 0).toFixed(1)}m \u00B7 ${xPts} xPts">
                    <div class="tactics-player-shirt" style="display:grid;place-items:center;background:rgba(0,0,0,0.15);border-radius:4px;">${shirtImg}<span class="aiteam-shirt-fallback" aria-hidden="true">${FPL.playerTeamShort(player)}</span></div>
                    <div class="tactics-player-copy"><b class="aiteam-pitch-name${cap ? ' is-captain' : ''}">${player.name}${badge}</b></div>
                    <div class="aiteam-pitch-cost">\u00A3${(player.cost || 0).toFixed(1)}m</div>
                    <div class="aiteam-pitch-xpts">${xPts} xPts</div>
                    <div class="aiteam-fixture-block">${fixtureRows.join('')}</div>
                    ${runBadge}
                </div>`;
            }
            const rows = [];
            rows.push(`<div class="tactics-pitch-row" style="--players:${gkps.length};">${gkps.map(p => playerCard(p)).join('')}</div>`);
            rows.push(`<div class="tactics-pitch-row" style="--players:${defs.length};">${defs.map(p => playerCard(p)).join('')}</div>`);
            rows.push(`<div class="tactics-pitch-row" style="--players:${mids.length};">${mids.map(p => playerCard(p)).join('')}</div>`);
            rows.push(`<div class="tactics-pitch-row" style="--players:${fwds.length};">${fwds.map(p => playerCard(p)).join('')}</div>`);
            pitchEl.innerHTML = `<div class="tactics-pitch">${rows.join('')}</div>`;
        }

        // --- Bench ---
        const benchEl = document.getElementById('aiteam-bench-section');
        if (benchEl) {
            let html = '<div class="aiteam-bench-label"><span class="material-symbols-outlined">event_seat</span> BENCH</div><div class="aiteam-bench-players">';
            lineup.bench.slice(0, 4).forEach((p, i) => {
                const xPts = sumPlayerXPts(p, gwView).toFixed(1);
                const shirt = FPL.playerTeamShirtUrl(p);
                const shirtImg = shirt ? `<img src="${shirt}" alt="" loading="lazy" decoding="async" onerror="this.closest('.aiteam-bench-shirt-img').classList.add('is-missing');this.remove();" style="width:100%;height:100%;object-fit:contain;">` : '';
                const weekly = p.weekly || [];
                const fixtures = p.upcomingFixtures || [];
                const fixtureRows = [];
                for (let j = 0; j < Math.min(gwView, weekly.length); j++) {
                    const w = weekly[j];
                    const fx = fixtures.find(f => f.gw === w.gameweek) || fixtures[j];
                    if (!fx) continue;
                    const col = fdrColor(fx.fdr);
                    fixtureRows.push(`<div class="aiteam-fixture-row"><span class="aiteam-fixture-opp" style="color:${col};">${fx.home ? fx.opponent + '(H)' : fx.opponent + '(A)'}</span><span class="aiteam-fixture-xpts">${w.xPts.toFixed(1)}</span></div>`);
                }
                html += `<div class="aiteam-bench-slot${p.position === 'GKP' ? ' is-goalkeeper' : ''}">
                    <div class="aiteam-bench-order">${i + 1}</div>
                    <div class="aiteam-bench-shirt-img">${shirtImg}<span class="aiteam-shirt-fallback" aria-hidden="true">${FPL.playerTeamShort(p)}</span></div>
                    <div class="aiteam-bench-info">
                        <div class="aiteam-bench-heading"><div class="aiteam-bench-name">${p.name}</div><span class="aiteam-bench-position">${p.position}</span></div>
                        <div class="aiteam-bench-club">${p.teamFull || p.team}</div>
                        <div class="aiteam-bench-metrics"><span>\u00A3${p.cost?.toFixed(1)}m</span><strong>${xPts} xPts</strong></div>
                        <div class="aiteam-fixture-block">${fixtureRows.join('')}</div>
                    </div>
                </div>`;
            });
            html += '</div>';
            benchEl.innerHTML = html;
        }

        // --- Squad Table ---
        const squadWrap = document.getElementById('aiteam-squad-table-wrap');
        if (squadWrap) {
            const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };
            const statusIcons = { a: { icon: 'check_circle', color: '#00FF87', label: 'Available' }, d: { icon: 'help', color: '#FFA726', label: 'Doubtful' }, i: { icon: 'hospital', color: '#ff4d4d', label: 'Injured' }, s: { icon: 'gavel', color: '#ff4d4d', label: 'Suspended' } };
            const isCap = (p) => lineup.captain && p.id === lineup.captain.id;
            const isVice = (p) => lineup.viceCaptain && p.id === lineup.viceCaptain.id;
            const starterIds = new Set(lineup.starters.map(p => p.id));
            const benchIds = new Set(lineup.bench.map(p => p.id));
            const all = [...lineup.starters, ...lineup.bench].filter((p, i, l) => p && l.findIndex(x => x.id === p.id) === i);
            const legendColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };
            const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
            all.forEach(p => counts[p.position]++);
            const legend = Object.entries(counts).map(([pos, c]) => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;"><span style="width:7px;height:7px;border-radius:2px;background:${legendColors[pos]};"></span>${pos} ${c}</span>`).join('');

            squadWrap.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <span style="font-size:13px;font-weight:600;color:#fff;">15-Player Roster</span>
                    <span style="display:flex;gap:8px;">${legend}</span>
                </div>
                <div class="table-scroll-mobile" tabindex="0" aria-label="AI Team squad table">
                    <table class="aiteam-table" style="min-width:700px;">
                        <thead><tr><th style="width:36px;">#</th><th class="aiteam-player-cell">Player</th><th>Pos</th><th>\u00A3</th><th>xPts</th><th>Fixtures</th><th>Role</th><th style="width:70px;">Action</th></tr></thead>
                        <tbody>${all.map((p, i) => {
                            const s = statusIcons[p.status] || statusIcons.a;
                            const xp = sumPlayerXPts(p, gwView).toFixed(1);
                            const role = isCap(p) ? '<span style="color:#FFD700;font-weight:700;">C</span>' : isVice(p) ? '<span style="color:#C0C0C0;">V</span>' : benchIds.has(p.id) ? '<span style="color:#8ba396;">B</span>' : '<span style="color:#00FF85;">S</span>';
                            const fx = (p.upcomingFixtures || []).slice(0, 4).map(f => {
                                const c = f.fdr <= 2 ? '#00FF85' : f.fdr <= 3 ? '#FFA726' : '#ff4d4d';
                                return `<span style="display:inline-block;width:20px;height:16px;line-height:16px;text-align:center;font-size:7px;font-weight:700;border-radius:2px;background:${c}22;color:${c};" title="GW${f.gw}: ${f.home?'':'@'}${f.opponent}">${f.opponent}</span>`;
                            }).join('');
                            return `<tr>
                                <td class="aiteam-rank-cell">${i + 1}</td>
                                <td class="aiteam-player-cell"><div class="aiteam-table-player">${this.teamBadge(p.team, 20)}<div><span class="aiteam-table-player-name" style="font-size:12px;">${p.name}</span><div class="aiteam-table-player-club">${p.teamFull || p.team}</div></div></div></td>
                                <td style="text-align:center;"><span style="padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;background:${posColors[p.position]}22;color:${posColors[p.position]};">${p.position}</span></td>
                                <td style="text-align:center;font-family:var(--font-mono);font-size:11px;color:#B0B0B0;">\u00A3${p.cost?.toFixed(1)}m</td>
                                <td style="text-align:center;font-family:var(--font-mono);font-size:12px;font-weight:700;color:#00FF85;">${xp}</td>
                                <td style="text-align:center;font-size:10px;padding:4px 2px;"><div style="display:flex;gap:1px;justify-content:center;">${fx}</div></td>
                                <td style="text-align:center;font-size:11px;font-weight:600;">${role}</td>
                                <td style="text-align:center;"><button onclick="FPL.suggestAITeamTransfer(${p.id})" title="Find replacement" style="padding:4px 8px;border:1px solid #294138;border-radius:4px;background:transparent;color:#8ba396;font-size:10px;cursor:pointer;transition:all 0.15s;"><span class="material-symbols-outlined" style="font-size:14px;">swap_horiz</span></button></td>
                            </tr>`;
                        }).join('')}</tbody>
                    </table>
                </div>`;
        }

        // --- Transfer Suggestions ---
        const transferEl = document.getElementById('aiteam-transfer-suggestions');
        if (transferEl) {
            const suggestions = (transfers?.plan || [])
                .filter(plan => plan.transfers?.length)
                .flatMap(plan => plan.transfers.map(move => ({ ...move, gw: plan.gw, planHit: plan.hit || 0 })))
                .filter(move => move.gain > 0)
                .sort((a, b) => b.gain - a.gain);
            if (suggestions.length) {
                transferEl.innerHTML = `
                    <div style="margin-bottom:16px;">
                        <div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:4px;">Transfer Suggestions</div>
                        <div style="font-size:11px;color:#8ba396;">Planned from the original GW1 squad using legal starting-XI gain across the remaining horizon.</div>
                    </div>
                    ${suggestions.slice(0, 5).map(s => {
                        return `<div class="aiteam-transfer-suggest">
                            <div class="aiteam-transfer-suggest-header">
                                <h3>GW${s.gw}: ${s.out.name} <span class="reason">${s.out.position} \u00B7 ${s.out.teamFull || s.out.team}</span></h3>
                                <span style="font:600 11px var(--font-mono);color:#00FF85;">+${s.gain.toFixed(1)} XI xPts${s.planHit ? ` \u00B7 -${s.planHit} hit` : ''}</span>
                            </div>
                            <div class="aiteam-transfer-option">
                                <div class="aiteam-transfer-player out">
                                    <div><div class="aiteam-transfer-player-name">${s.out.name}</div><div class="aiteam-transfer-player-meta">\u00A3${s.out.cost?.toFixed(1)}m \u00B7 outgoing</div></div>
                                </div>
                                <span class="material-symbols-outlined" style="color:#8ba396;font-size:18px;">arrow_forward</span>
                                <div class="aiteam-transfer-player in"><div><div class="aiteam-transfer-player-name">${s.in.name}</div><div class="aiteam-transfer-player-meta">\u00A3${s.in.cost?.toFixed(1)}m \u00B7 ${s.nextGain >= 0 ? '+' : ''}${s.nextGain.toFixed(1)} next GW</div></div></div>
                                <button class="aiteam-transfer-apply" onclick="FPL.suggestAITeamTransfer(${s.out.id})">Review</button>
                            </div>
                        </div>`;
                    }).join('')}`;
            } else {
                transferEl.innerHTML = `<div class="aiteam-empty-state"><span class="material-symbols-outlined">thumb_up</span><p>No urgent transfer suggestions. Your squad looks solid for the upcoming fixtures.</p></div>`;
            }
        }

        // --- GW Breakdown ---
        const gwBreakdown = document.getElementById('aiteam-gw-breakdown');
        if (gwBreakdown && lineup.starters[0]?.weekly) {
            const gws = (meta?.gameweeks || lineup.starters[0].weekly.map(w => w.gameweek)).slice(0, gwView);
            const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };
            const allP = [...lineup.starters, ...lineup.bench];
            gwBreakdown.innerHTML = `
                <div class="table-scroll-mobile" tabindex="0" aria-label="GW breakdown table">
                    <table class="aiteam-table" style="min-width:max-content;">
                        <thead><tr><th class="aiteam-player-cell">Player</th>${gws.map(g => `<th>GW${g}</th>`).join('')}<th style="min-width:60px;">Total</th></tr></thead>
                        <tbody>${allP.map((p, i) => {
                            const isB = i >= lineup.starters.length;
                            return `<tr class="${isB ? 'is-bench' : ''}" style="${isB ? 'background:rgba(255,255,255,0.02);' : ''}">
                                <td class="aiteam-player-cell"><div class="aiteam-gw-player"><span class="aiteam-gw-position" style="color:${posColors[p.position]};">${p.position}</span><span class="aiteam-gw-player-copy"><strong>${p.name}</strong><small>${p.teamFull || p.team}${isB ? ' \u00B7 Bench' : ''}</small></span></div></td>
                                ${gws.map(g => {
                                    const w = p.weekly.find(week => week.gameweek === g) || { xPts: 0 };
                                    const fx = p.upcomingFixtures?.find(f => f.gw === g);
                                    const fdr = fx?.fdr || 3;
                                    const fdrBg = fdr <= 2 ? 'rgba(0,255,133,0.08)' : fdr <= 3 ? 'rgba(255,167,38,0.08)' : 'rgba(255,77,77,0.08)';
                                    const fxColor = fdr <= 2 ? '#00FF85' : fdr <= 3 ? '#FFA726' : '#ff4d4d';
                                    return `<td class="aiteam-gw-cell" style="color:${w.xPts >= 5 ? '#00FF85' : w.xPts >= 3 ? '#fff' : '#8ba396'};background:${fdrBg};">
                                        <span class="aiteam-gw-fixture" style="color:${fx ? fxColor : '#718279'};">${fx ? fx.opponent + (fx.home ? '(H)' : '(A)') : 'BLANK'}</span>
                                        <strong>${w.xPts.toFixed(1)}</strong>
                                    </td>`;
                                }).join('')}
                                <td class="aiteam-total-cell">${gws.reduce((s, g) => s + (p.weekly.find(w => w.gameweek === g)?.xPts || 0), 0).toFixed(1)}</td>
                            </tr>`;
                        }).join('')}</tbody>
                    </table>
                </div>`;
        }

        // --- Chip Strategy ---
        const chipsEl = document.getElementById('aiteam-chips-section');
        if (chipsEl) {
            const chipList = chips?.schedule || chips?.recommendations || [];
            if (chipList.length) {
                const chipNames = { BB: 'Bench Boost', TC: 'Triple Captain', FH: 'Free Hit', WC: 'Wildcard' };
                const chipColors = { BB: '#4FC3F7', TC: '#FFD700', FH: '#c084fc', WC: '#FFA726' };
                const chipIcons = { BB: 'event_seat', TC: 'star', FH: 'flash_on', WC: 'auto_fix_high' };
                chipsEl.innerHTML = `
                    <div style="margin-top:16px;"><div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:4px;">Chip Strategy</div>
                    <div class="aiteam-chips-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:8px;">
                    ${chipList.map(c => {
                        const name = chipNames[c.chip] || c.chip;
                        const color = chipColors[c.chip] || '#00FF85';
                        return `<div class="aiteam-chip-card" style="border-color:${color}55;padding:12px;border:1px solid ${color}33;border-radius:6px;background:#141916;">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;"><span class="material-symbols-outlined" style="color:${color};font-size:18px;">${chipIcons[c.chip] || 'auto_awesome'}</span><span style="font-weight:700;color:#fff;font-size:13px;">${name}</span></div>
                            <div style="color:${color};font-weight:700;font-size:14px;">GW ${c.gw ?? c.gameweek}</div>
                            <div style="color:#8ba396;font-size:10px;margin-top:4px;">${c.reason || ''}</div>
                            <div style="margin-top:4px;color:#00FF85;font-size:10px;font-weight:600;">+${(c.expectedGain || 0).toFixed(1)} xPts</div>
                        </div>`;
                    }).join('')}</div></div>`;
            } else {
                chipsEl.innerHTML = '';
            }
        }
    },

    // ==================== RENDER: DASHBOARD (GENERAL) ====================
    async renderGeneral() {
        try {
            let data = this.getCachedTabData('dashboard');
            if (!data) {
                data = await this.apiFetch('/api/dashboard/overview');
                this.setCachedTabData('dashboard', data);
            }
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
                    const clickAction = p.id ? `FPL.showPlayerDetail(${p.id})` : `FPL.openPlayersByPosition('${p.pos}')`;
                    return `<tr style="border-bottom:1px solid #1A2E28;transition:background 0.2s;cursor:pointer;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'" onclick="${clickAction}">
                        <td style="padding:8px 10px;display:flex;align-items:center;gap:8px;background:#141916;position:relative;">
                            <div style="width:3px;height:24px;border-radius:999px;background:${barColor};flex-shrink:0;"></div>
                            <div class="player-photo-shell" style="width:32px;height:32px;border-radius:50%;border:1px solid #1A2E28;">
                                ${this.playerPhotoMarkup(p, `${p.name || p.web_name || 'FPL Player'} photo`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}
                            </div>
                            <div style="min-width:0;flex:1;">
                                <div style="font-weight:700;color:#ffffff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</div>
                                <div class="mono" style="font-size:10px;color:#8ba396;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.team} • ${p.pos}</div>
                            </div>
                        </td>
                        <td style="padding:8px 10px;text-align:center;font-weight:600;color:#dfe4e0;font-family:var(--font-mono);font-size:12px;white-space:nowrap;">${p.selectedBy}</td>
                        <td style="padding:8px 10px;text-align:center;font-weight:700;color:#00ff85;font-family:var(--font-mono);font-size:13px;white-space:nowrap;">${p.xPPG ?? p.ppg ?? '--'}</td>
                    </tr>`;
                }).join('');
            }

            const fdrHeaderRow = document.getElementById('dash-fdr-header-row');
            if (fdrHeaderRow && data.nextGWs) {
                const dashSortGW = this.state.dashFDRSortGW || null;
                const dashSortAsc = this.state.dashFDRSortAsc !== false;
                fdrHeaderRow.innerHTML = `<th style="padding:8px 12px;text-align:left;color:#8ba396;background:#141916;position:sticky;left:0;z-index:2;">Team</th>` +
                    data.nextGWs.map(gw => {
                        const isSorted = dashSortGW === gw;
                        const arrow = isSorted ? (dashSortAsc ? ' ▲' : ' ▼') : '';
                        const color = isSorted ? '#00FF85' : '#8ba396';
                        return `<th style="padding:6px 8px;text-align:center;color:${color};cursor:pointer;user-select:none;transition:color 0.2s;" onclick="FPL.sortDashFDRByGW(${gw})" title="Sort by GW${gw} FDR">GW${gw}${arrow}</th>`;
                    }).join('');
            }

            const fdrTbody = document.getElementById('dash-fdr-tbody');
            if (fdrTbody && data.fdrGrid) {
                const dashSortGW = this.state.dashFDRSortGW || null;
                const dashSortAsc = this.state.dashFDRSortAsc !== false;
                let grid = [...data.fdrGrid];
                if (dashSortGW && data.nextGWs?.includes(dashSortGW)) {
                    grid.sort((a, b) => {
                        const colA = a.fixtures.find((f, i) => data.nextGWs[i] === dashSortGW);
                        const colB = b.fixtures.find((f, i) => data.nextGWs[i] === dashSortGW);
                        const fdrA = (Array.isArray(colA) ? colA[0]?.fdr : colA?.fdr) || 3;
                        const fdrB = (Array.isArray(colB) ? colB[0]?.fdr : colB?.fdr) || 3;
                        return dashSortAsc ? fdrA - fdrB : fdrB - fdrA;
                    });
                }
                fdrTbody.innerHTML = grid.map(row => `
                    <tr style="border-bottom:1px solid #1A2E28;transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                        <td style="padding:8px 12px;text-align:left;font-weight:700;color:#ffffff;font-size:12px;font-family:var(--font-mono);background:#141916;white-space:nowrap;">${row.team}</td>
                        ${row.fixtures.map((f, i) => {
                            if (Array.isArray(f)) {
                                return `<td style="padding:4px;"><div style="display:flex;flex-direction:column;gap:2px;">${f.map(item => `<div class="mono" style="font-size:10px;font-weight:700;padding:3px 6px;border-radius:4px;${fdrColors[item.fdr] || fdrColors[3]}">${item.label}</div>`).join('')}</div></td>`;
                            }
                            const styleStr = fdrColors[f.fdr] || fdrColors[3];
                            return `<td style="padding:4px;">
                                <div class="mono" style="font-size:10px;font-weight:700;padding:5px 8px;border-radius:4px;display:inline-block;width:100%;${styleStr}">${f.label}</div>
                            </td>`;
                        }).join('')}
                    </tr>
                `).join('');
            }

            const transfersInContainer = document.getElementById('dash-transfers-in-list');
            if (transfersInContainer) {
                transfersInContainer.innerHTML = data.topTransfersIn?.length ? data.topTransfersIn.map(p => `
                    <div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
                        <div class="player-photo-shell" style="width:32px;height:32px;border-radius:50%;border:1px solid #1A2E28;">
                            ${this.playerPhotoMarkup(p, `${p.name || p.web_name || 'FPL Player'} photo`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}
                        </div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:13px;font-weight:700;color:#ffffff;">${p.name}</div>
                            <div class="mono" style="font-size:10px;color:#8ba396;">${p.team} • ${p.pos} • £${p.price || '?'}m</div>
                        </div>
                        <div class="mono" style="font-size:13px;font-weight:700;color:#00ff85;white-space:nowrap;">${p.transfersCount}</div>
                    </div>
                `).join('') : '<div style="text-align:center;padding:12px;font-size:13px;color:#8ba396;">No transfer data yet</div>';
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
            if (transfersOutContainer) {
                transfersOutContainer.innerHTML = data.topTransfersOut.length > 0 ? data.topTransfersOut.map((p, idx) => `
                    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;${idx < data.topTransfersOut.length - 1 ? 'border-bottom:1px solid #19261f;' : ''}">
                        <div style="width:32px;height:32px;border-radius:50%;background:#1c2720;border:1px solid #28392e;display:flex;align-items:center;justify-content:center;font-weight:700;color:#FF005A;font-size:12px;">${idx + 1}</div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:14px;font-weight:700;color:#ffffff;">${p.name}</div>
                            <div style="font-size:11px;color:#8ba396;font-family:var(--font-mono);">${p.team} • ${p.pos} • £${p.price || '?'}m</div>
                        </div>
                        <div style="font-size:13px;font-weight:700;color:#FF005A;font-family:var(--font-mono);white-space:nowrap;">${p.transfersCount}</div>
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
                            <div style="font-size:13px;font-weight:700;color:#ffffff;">${this.escapeHTML(p.name)} <span style="font-size:10px;color:#8ba396;font-family:var(--font-mono);">${this.escapeHTML(p.team)} • ${this.escapeHTML(p.pos)}</span></div>
                            <div style="font-size:11px;color:${statusColor};margin-top:2px;">${this.escapeHTML(p.status)}: ${this.escapeHTML(p.news)}</div>
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

    initDialogs() {
        document.querySelectorAll('.dialog-overlay').forEach(overlay => {
            if (overlay.dataset.dialogBound === 'true') return;
            overlay.dataset.dialogBound = 'true';
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) this.hideDialog(overlay.id);
            });
            overlay.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    this.hideDialog(overlay.id);
                    return;
                }
                if (event.key !== 'Tab') return;
                const focusable = [...overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            });
        });

        document.querySelectorAll('th[onclick]').forEach(header => {
            header.tabIndex = 0;
            header.setAttribute('role', 'button');
            header.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                header.click();
            });
        });

        document.querySelectorAll('[role="tablist"]').forEach(tablist => {
            if (tablist.dataset.keyboardBound === 'true') return;
            tablist.dataset.keyboardBound = 'true';
            tablist.addEventListener('keydown', event => {
                if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
                const tabs = [...tablist.querySelectorAll('[role="tab"]')];
                if (!tabs.length) return;
                const current = Math.max(0, tabs.indexOf(document.activeElement));
                const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
                const next = tabs[(current + direction + tabs.length) % tabs.length];
                event.preventDefault();
                next.focus();
                next.click();
            });
        });
    },

    showDialog(id) {
        const el = document.getElementById(id);
        if (el) {
            this.dialogTrigger = document.activeElement;
            el.classList.add('active');
            el.setAttribute('aria-hidden', 'false');
            document.querySelector('.layout')?.setAttribute('inert', '');
            document.querySelector('.bottom-nav')?.setAttribute('inert', '');
            const firstFocusable = el.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
            if (id === 'connect-dialog') {
                const managerInput = document.getElementById('connect-manager-id');
                const leagueInput = document.getElementById('connect-league-id');
                if (managerInput) managerInput.value = this.state.managerId || '';
                if (leagueInput) leagueInput.value = this.state.leagueId || '';
                managerInput?.focus();
            } else {
                (firstFocusable || el.querySelector('.dialog'))?.focus?.();
            }
        }
    },

    hideDialog(id) {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('active');
            el.setAttribute('aria-hidden', 'true');
            document.querySelector('.layout')?.removeAttribute('inert');
            document.querySelector('.bottom-nav')?.removeAttribute('inert');
            this.dialogTrigger?.focus?.();
            this.dialogTrigger = null;
        }
    },

    confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('confirm-dialog');
            if (!overlay) {
                resolve(window.confirm(`${title}\n\n${message}`));
                return;
            }
            const titleEl = document.getElementById('confirm-dialog-title');
            const msgEl = document.getElementById('confirm-dialog-message');
            const okBtn = document.getElementById('confirm-dialog-ok');
            const cancelBtn = document.getElementById('confirm-dialog-cancel');
            const closeBtn = overlay.querySelector('.dialog-header .btn-icon');
            let settled = false;
            const cleanup = () => {
                okBtn?.removeEventListener('click', onOk);
                cancelBtn?.removeEventListener('click', onCancel);
                closeBtn?.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onOverlayClick);
                overlay.removeEventListener('keydown', onKey);
                this.hideDialog('confirm-dialog');
            };
            const settle = (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const onOk = () => settle(true);
            const onCancel = () => settle(false);
            const onKey = (event) => { if (event.key === 'Escape') settle(false); };
            const onOverlayClick = (event) => { if (event.target === overlay) settle(false); };
            if (titleEl) titleEl.textContent = title;
            if (msgEl) msgEl.innerHTML = message || '';
            if (okBtn) {
                okBtn.textContent = confirmLabel;
                okBtn.classList.toggle('btn-danger', Boolean(danger));
                okBtn.classList.toggle('btn-primary', !danger);
            }
            if (cancelBtn) cancelBtn.textContent = cancelLabel;
            okBtn?.addEventListener('click', onOk);
            cancelBtn?.addEventListener('click', onCancel);
            closeBtn?.addEventListener('click', onCancel);
            overlay.addEventListener('click', onOverlayClick);
            overlay.addEventListener('keydown', onKey);
            this.showDialog('confirm-dialog');
            setTimeout(() => okBtn?.focus(), 60);
        });
    },

    // ==================== RENDER: DASHBOARD ====================
    renderDashboard() {
        const s = this.state;
        const m = s.managerData;

        // Update GW display
        const gwEls = document.querySelectorAll('#current-gw, #fixture-gw-display, #captain-gw-display');
        gwEls.forEach(el => { if (el) el.textContent = s.selectedGW || s.currentGW; });

        const lastUpEl = document.getElementById('last-updated');
        if (lastUpEl) lastUpEl.textContent = new Date().toLocaleTimeString();

        if (!m || !m.managerInfo) {
            const rankEl = document.getElementById('stat-overall-rank');
            const ptsEl = document.getElementById('stat-total-points');
            const gwRankEl = document.getElementById('stat-gw-rank');
            const tcEl = document.getElementById('stat-transfer-cost');
            const tvEl = document.getElementById('stat-team-value');
            if (rankEl) rankEl.textContent = '--';
            if (ptsEl) ptsEl.textContent = '--';
            if (gwRankEl) gwRankEl.textContent = '--';
            if (tcEl) tcEl.textContent = '--';
            if (tvEl) tvEl.textContent = '--';
            return;
        }

        const info = m.managerInfo;
        const teamVal = m.playerStats ? (m.playerStats.reduce((s, p) => s + (p.nowCost || 0), 0) / 10) : 0;

        const rankEl = document.getElementById('stat-overall-rank');
        const ptsEl = document.getElementById('stat-total-points');
        const gwRankEl = document.getElementById('stat-gw-rank');
        const tcEl = document.getElementById('stat-transfer-cost');
        const tvEl = document.getElementById('stat-team-value');
        if (rankEl) rankEl.textContent = this.formatNumber(info.overallRankRaw);
        if (ptsEl) ptsEl.textContent = this.formatNumber(info.managerPoints);
        if (gwRankEl) gwRankEl.textContent = info.lowestRank || '--';
        if (tcEl) tcEl.textContent = info.totalTransfers || 0;
        if (tvEl) tvEl.textContent = '£' + teamVal.toFixed(1);

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
                    <div style="font-weight:600;font-size:1rem;">${this.escapeHTML(info.name || 'Unknown')}</div>
                    <div style="font-size:0.75rem;color:var(--md-sys-color-on-surface-variant);">Team: ${this.escapeHTML(info.teamName || '--')}</div>
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

        // Pre-fill Manager ID input if connected
        const idInput = document.getElementById('manager-id-input-field');
        if (idInput && this.state.managerId && !idInput.value) {
            idInput.value = this.state.managerId;
        }

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
                    posStats[pos].topCode = p.code || p.photoId;
                }
            });

            if (document.getElementById('pos-gkp-pts')) document.getElementById('pos-gkp-pts').textContent = posStats.GKP.pts || '0';
            if (document.getElementById('pos-gkp-top')) document.getElementById('pos-gkp-top').textContent = posStats.GKP.topName ? `Top: ${posStats.GKP.topName} (${posStats.GKP.topPts})` : 'No data';
            if (posStats.GKP.topCode) {
                const imgEl = document.getElementById('pos-gkp-img');
                if (imgEl) imgEl.innerHTML = this.playerPhotoMarkup({ code: posStats.GKP.topCode, name: posStats.GKP.topName }, `${posStats.GKP.topName || 'Goalkeeper'} - top scoring goalkeeper`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;');
            }

            if (document.getElementById('pos-def-pts')) document.getElementById('pos-def-pts').textContent = posStats.DEF.pts || '0';
            if (document.getElementById('pos-def-top')) document.getElementById('pos-def-top').textContent = posStats.DEF.topName ? `Top: ${posStats.DEF.topName} (${posStats.DEF.topPts})` : 'No data';
            if (posStats.DEF.topCode) {
                const imgEl = document.getElementById('pos-def-img');
                if (imgEl) imgEl.innerHTML = this.playerPhotoMarkup({ code: posStats.DEF.topCode, name: posStats.DEF.topName }, `${posStats.DEF.topName || 'Defender'} - top scoring defender`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;');
            }

            if (document.getElementById('pos-mid-pts')) document.getElementById('pos-mid-pts').textContent = posStats.MID.pts || '0';
            if (document.getElementById('pos-mid-top')) document.getElementById('pos-mid-top').textContent = posStats.MID.topName ? `Top: ${posStats.MID.topName} (${posStats.MID.topPts})` : 'No data';
            if (posStats.MID.topCode) {
                const imgEl = document.getElementById('pos-mid-img');
                if (imgEl) imgEl.innerHTML = this.playerPhotoMarkup({ code: posStats.MID.topCode, name: posStats.MID.topName }, `${posStats.MID.topName || 'Midfielder'} - top scoring midfielder`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;');
            }

            if (document.getElementById('pos-fwd-pts')) document.getElementById('pos-fwd-pts').textContent = posStats.FWD.pts || '0';
            if (document.getElementById('pos-fwd-top')) document.getElementById('pos-fwd-top').textContent = posStats.FWD.topName ? `Top: ${posStats.FWD.topName} (${posStats.FWD.topPts})` : 'No data';
            if (posStats.FWD.topCode) {
                const imgEl = document.getElementById('pos-fwd-img');
                if (imgEl) imgEl.innerHTML = this.playerPhotoMarkup({ code: posStats.FWD.topCode, name: posStats.FWD.topName }, `${posStats.FWD.topName || 'Forward'} - top scoring forward`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;');
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
                        <div class="player-photo-shell" style="width:24px;height:24px;border-radius:50%;border:1px solid #28392e;">${this.playerPhotoMarkup(p, `${p.webName || p.name} photo`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}</div>
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
                <td style="padding:var(--space-sm);text-align:center;font-family:var(--font-mono);">£${data.totalValue.toFixed(1)}m</td>
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
                        ${this.teamBadge(p.teamShort, 14)}
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
    playerSortKey: 'pts',
    playerSortDir: 'desc',

    togglePlayerSort(metric) {
        if (this.playerSortKey === metric) {
            this.playerSortDir = this.playerSortDir === 'desc' ? 'asc' : 'desc';
        } else {
            this.playerSortKey = metric;
            this.playerSortDir = 'desc';
        }
        this.renderPlayers();
    },

    sortByPlayerMetric(metric) {
        this.playerSortKey = metric;
        this.playerSortDir = 'desc';
        this.renderPlayers();
    },

    renderPlayers() {
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap) {
            const tbody = document.getElementById('players-table-body');
            if (tbody) tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:32px;color:#8ba396;">Loading player data...</td></tr>';
            return;
        }

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
        const sortKey = this.playerSortKey || 'pts';
        const sortDir = this.playerSortDir === 'asc' ? 1 : -1;

        const metricValue = (player, metric) => {
            const nineties = (player.minutes || 0) / 90;
            let value;
            switch (metric) {
                case 'xg': value = parseFloat(player.expected_goals || 0); break;
                case 'xa': value = parseFloat(player.expected_assists || 0); break;
                case 'xgi': value = parseFloat(player.expected_goal_involvements || 0); break;
                case 'xgi90': return parseFloat(player.expected_goal_involvements_per_90 || 0);
                case 'gxg': value = (player.goals_scored || 0) - parseFloat(player.expected_goals || 0); break;
                case 'form': return parseFloat(player.form || 0);
                case 'defcon': value = parseFloat(player.defensive_contribution || 0); break;
                case 'mins': return player.minutes || 0;
                case 'goals': value = player.goals_scored || 0; break;
                case 'own': return parseFloat(player.selected_by_percent || 0);
                case 'ict': return parseFloat(player.ict_index || 0);
                case 'pts':
                default: value = player.total_points || 0; break;
            }
            if (!per90) return value;
            return nineties > 0 ? value / nineties : 0;
        };

        const sortIconIds = ['pts','mins','goals','xg','gxg','xa','xgi','xgi90','form','defcon'];
        sortIconIds.forEach(id => {
            const icon = document.getElementById('sort-icon-' + id);
            if (icon) {
                if (id === sortKey) {
                    icon.style.display = 'inline';
                    icon.textContent = sortDir === -1 ? 'arrow_downward' : 'arrow_upward';
                } else {
                    icon.style.display = 'none';
                }
            }
        });

        filtered.sort((a, b) => (metricValue(a, sortKey) - metricValue(b, sortKey)) * sortDir);

        const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        const posColors = { 1: '#FFD700', 2: '#4FC3F7', 3: '#81C784', 4: '#E57373' };

        // Update column headers based on per90 toggle
        const thGoals = document.getElementById('th-goals');
        const thXG = document.getElementById('th-xg');
        const thXA = document.getElementById('th-xa');
        const thXGI = document.getElementById('th-xgi');
        const thPts = document.getElementById('th-pts');
        const thDefcon = document.getElementById('th-defcon');
        if (thPts) thPts.childNodes[0].textContent = per90 ? 'Pts/90 ' : 'Pts ';
        if (thGoals) thGoals.textContent = per90 ? 'Goals/90' : 'Goals';
        if (thXG) thXG.textContent = per90 ? 'xG/90' : 'xG';
        if (thXA) thXA.textContent = per90 ? 'xA/90' : 'xA';
        if (thXGI) thXGI.textContent = per90 ? 'xGI/90' : 'xGI';
        if (thDefcon) thDefcon.childNodes[0].textContent = per90 ? 'DefCon/90 ' : 'DefCon ';

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
            const defcon = metricValue(p, 'defcon');
            const goalsVsXG = goals - xG;
            const xgiPer90 = parseFloat(p.expected_goal_involvements_per_90 || 0);

            const isEven = idx % 2 === 1;
            const decimals = per90 ? 2 : 1;

            return `
                <tr style="border-bottom:1px solid #1A2E28;transition:background 0.2s;${isEven ? 'background:rgba(49,54,51,0.15);' : ''}cursor:pointer;" onclick="FPL.showPlayerDetail(${p.id})" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='${isEven ? 'rgba(49,54,51,0.15)' : 'transparent'}'">
                    <td style="padding:4px 6px;background:${isEven ? '#1E1E1E' : '#1A1A1A'};max-width:110px;overflow:hidden;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <div class="player-photo-shell" style="width:28px;height:28px;border-radius:50%;border:1px solid #333;">
                                ${this.playerPhotoMarkup(p, `${p.name || p.web_name || 'FPL Player'} photo`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}
                            </div>
                            <div style="min-width:0;overflow:hidden;">
                                <div style="font-weight:700;font-size:11px;color:#E0E0E0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escapeHTML(p.web_name)}</div>
                                <div class="players-table-player-meta" style="display:flex;align-items:center;gap:3px;font-size:9px;color:#8ba396;white-space:nowrap;">
                                    <span style="padding:1px 3px;border-radius:2px;font-weight:700;background:${posColor}20;color:${posColor};font-size:8px;">${posStr}</span>
                                    <span>${teamShort}</span>
                                    <span class="players-table-price-separator" style="color:#444;">·</span>
                                    <span class="players-table-price" style="font-family:var(--font-mono);color:#B0B0B0;">£${price}m</span>
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
                    <td style="text-align:center;font-family:var(--font-mono);font-size:11px;color:#B0B0B0;">${defcon.toFixed(per90 ? 2 : 1)}</td>
                </tr>
            `;
        }).join('');
    },

    // ==================== RENDER: LEAGUE STANDINGS ====================
    async renderLeague() {
        const leagueId = this.state.selectedLeagueId || this.state.leagueId;
        const page = this.state.standingsPage || 1;
        
        const tbody = document.getElementById('league-standings-body');
        if (!tbody) return;

        try {
            const cacheKey = `league-${leagueId}-${page}`;
            let data = this.getCachedTabData(cacheKey);
            if (!data) {
                data = await this.apiFetch(`/api/leagues-classic/${leagueId}/standings?page=${page}`);
                this.setCachedTabData(cacheKey, data);
            }
            this.state.standingsData = data;

            // Bento Grid Card 1: League Name & ID
            const nameEl = document.getElementById('standings-league-name');
            if (nameEl) nameEl.textContent = data.leagueName || `League ${leagueId}`;

            const badgeEl = document.getElementById('standings-league-id-badge');
            if (badgeEl) badgeEl.textContent = `ID: ${data.leagueId}`;

            const typeEl = document.getElementById('standings-league-type');
            if (typeEl) typeEl.textContent = data.leagueType || 'Classic League';

            // Handle no-data state (season not started or no league data)
            if (data.noData) {
                const avgEl = document.getElementById('standings-league-avg');
                if (avgEl) avgEl.textContent = '--';
                const topScoreEl = document.getElementById('standings-top-score');
                if (topScoreEl) topScoreEl.textContent = '--';
                const topTeamEl = document.getElementById('standings-top-team');
                if (topTeamEl) topTeamEl.textContent = '--';
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:var(--space-xl);color:var(--md-sys-color-on-surface-variant);font-size:14px;">
                    <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
                        <span class="material-symbols-outlined" style="font-size:40px;color:var(--md-sys-color-outline);">hourglass_empty</span>
                        <div style="font-weight:600;color:var(--md-sys-color-on-surface);">Season data not available yet</div>
                        <div style="font-size:12px;max-width:300px;">League standings will appear here once the FPL season begins and managers have started making transfers.</div>
                    </div>
                </td></tr>`;
                const pagEl = document.getElementById('standings-pagination-controls');
                if (pagEl) pagEl.innerHTML = '';
                const countEl = document.getElementById('standings-showing-count');
                if (countEl) countEl.textContent = '';
                return;
            }

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
                    <td style="padding:4px 6px;position:relative;font-weight:700;color:var(--md-sys-color-on-surface);width:40px;background:${isEven ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)'};">
                        <div style="position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:70%;background:var(--${borderTier});border-radius:0 2px 2px 0;"></div>
                        ${m.rank}
                    </td>
                    <td style="padding:4px 6px;background:${isEven ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.05)'};max-width:140px;overflow:hidden;">
                        <div style="font-weight:700;color:var(--md-sys-color-on-surface);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escapeHTML(m.managerName)}</div>
                        <div style="font-size:9px;color:var(--md-sys-color-on-surface-variant);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escapeHTML(m.entryName)}</div>
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
        this.state.selectedLeagueId = Number(leagueId);
        this.state.standingsPage = 1;
        const select = document.getElementById('league-select');
        if (select) select.value = String(this.state.selectedLeagueId);
        void this.renderLeague();
    },

    loadCustomLeague() {
        const input = document.getElementById('league-id-input');
        const val = input?.value?.trim();
        if (!/^\d+$/.test(val || '') || Number(val) < 1) {
            this.showError('Enter a valid League ID or select a manager and league');
            return;
        }
        this.switchLeague(parseInt(val));
        if (input) input.value = '';
        const resultsEl = document.getElementById('league-search-results');
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
        }
    },

    // ==================== RENDER: FIXTURES ====================
    setFixtureLookahead(n) {
        this.state.fixtureLookahead = n;
        ['3', '5', '10'].forEach(val => {
            const btn = document.getElementById(`lookahead-${val}`);
            if (btn) {
                if (parseInt(val) === n) {
                    btn.style.background = '#00FF85';
                    btn.style.color = '#0a0f0d';
                    btn.style.fontWeight = '700';
                } else {
                    btn.style.background = 'transparent';
                    btn.style.color = '#b9cbb9';
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

        // Fixture sorting state
        const sortGW = this.state.fixtureSortGW || null;
        const sortAsc = this.state.fixtureSortAsc !== false;

        const headerRow = document.getElementById('fixture-grid-header-row');
        const fixtureTable = document.querySelector('.fixture-grid-table');
        if (fixtureTable) fixtureTable.style.setProperty('--fixture-columns', targetGWs.length);
        if (headerRow) {
            headerRow.style.background = '#202722';
            headerRow.innerHTML = `<th style="padding:6px 8px;background:#202722;width:60px;max-width:60px;font-family:var(--font-mono);font-size:10px;color:#dfe4e0;font-weight:700;position:sticky;left:0;z-index:2;border-right:1px solid #34453b;">TEAM</th>` +
                targetGWs.map(gw => {
                    const isSorted = sortGW === gw;
                    const arrow = isSorted ? (sortAsc ? ' ▲' : ' ▼') : '';
                    const color = isSorted ? '#00FF85' : '#dfe4e0';
                    return `<th style="padding:4px 6px;text-align:center;font-family:var(--font-mono);font-size:10px;color:${color};font-weight:700;background:#202722;cursor:pointer;user-select:none;transition:color 0.2s;" onclick="FPL.sortFixturesByGW(${gw})" title="Sort by GW${gw} FDR">GW${gw}${arrow}</th>`;
                }).join('');
        }

        // Compute team FDR values for sorting
        const getTeamFDR = (teamId, gw) => {
            const fx = fixtures.find(f => f.event === gw && (f.team_h === teamId || f.team_a === teamId));
            if (!fx) return 6; // blanks sort last
            return fx.team_h === teamId ? (fx.team_h_difficulty || fx.difficulty || 3) : (fx.team_a_difficulty || fx.difficulty || 3);
        };

        // Sort teams
        let sortedTeams = [...teams];
        if (sortGW && targetGWs.includes(sortGW)) {
            sortedTeams.sort((a, b) => {
                const fdrA = getTeamFDR(a.id, sortGW);
                const fdrB = getTeamFDR(b.id, sortGW);
                return sortAsc ? fdrA - fdrB : fdrB - fdrA;
            });
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

            tbody.innerHTML = sortedTeams.map((team, idx) => {
                const isEven = idx % 2 === 1;
                let cellHTMLs = targetGWs.map(gw => {
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
                    const isSortedCol = sortGW === gw;
                    const highlight = isSortedCol ? `box-shadow:inset 0 0 0 1px rgba(0,255,133,0.3);` : '';

                    return `<td style="padding:3px;">
                        <div style="background:${colStyle.bg};border-radius:6px;padding:4px 6px;display:flex;flex-direction:column;align-items:center;justify-content:center;height:40px;${highlight}">
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
                    <td style="padding:4px 6px;background:${isEven ? '#181d1a' : '#0f1412'};max-width:60px;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono);font-size:10px;font-weight:700;color:#00ff85;position:sticky;left:0;z-index:1;border-right:2px solid rgba(255,255,255,0.08);">
                        <div style="display:flex;align-items:center;gap:4px;">
                            <div style="width:3px;height:14px;background:${teamAccentColor};border-radius:999px;flex-shrink:0;"></div>
                            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${team.short_name}</span>
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

                return `<div class="flex items-center gap-3 p-3 rounded-lg bg-surface border border-pitch-line hover:border-fdr-1 transition-colors cursor-pointer group" style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;background:var(--md-sys-color-surface);border:1px solid var(--pitch-line);cursor:pointer;" onclick="FPL.showPlayerDetail(${p.id})">
                    <div class="player-photo-shell" style="width:40px;height:40px;border-radius:50%;border:1px solid var(--pitch-line);">
                        ${this.playerPhotoMarkup(p, `${p.name || p.web_name || 'FPL Player'} photo`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}
                        <div style="position:absolute;bottom:0;right:0;width:10px;height:10px;background:var(--fdr-1);border-radius:50%;border:1px solid var(--md-sys-color-surface);"></div>
                    </div>
                    <div style="flex:1;">
                        <p style="margin:0;font-weight:700;font-size:14px;color:var(--fdr-1);line-height:1.2;">${p.web_name}</p>
                        <p style="margin:2px 0 0 0;font-family:var(--font-mono);font-size:11px;color:var(--md-sys-color-on-surface-variant);display:flex;align-items:center;gap:4px;">${this.teamBadge(team?.short_name, 12)} ${team?.short_name || 'FPL'} • ${posStr}</p>
                    </div>
                    <div style="text-align:right;">
                        <p style="margin:0;font-family:var(--font-mono);font-size:15px;font-weight:700;color:var(--md-sys-color-primary);">${p.form}</p>
                        <p style="margin:2px 0 0 0;font-family:var(--font-mono);font-size:10px;color:var(--md-sys-color-on-surface-variant);">Form</p>
                    </div>
                </div>`;
            }).join('');
        }
    },

    switchFixtureSubView(subview) {
        const views = ['matrix', 'odds', 'goals', 'conceded'];
        const viewElements = {
            matrix: document.getElementById('fixture-subview-matrix'),
            odds: document.getElementById('fixture-subview-odds'),
            goals: document.getElementById('fixture-subview-goals'),
            conceded: document.getElementById('fixture-subview-conceded'),
        };
        const btnElements = {
            matrix: document.getElementById('fixture-view-btn-matrix'),
            odds: document.getElementById('fixture-view-btn-odds'),
            goals: document.getElementById('fixture-view-btn-goals'),
            conceded: document.getElementById('fixture-view-btn-conceded'),
        };
        const oddsSelector = document.getElementById('fixture-odds-gw-selector');
        const goalsSelector = document.getElementById('fixture-goals-horizon-selector');

        views.forEach(v => {
            if (viewElements[v]) viewElements[v].style.display = 'none';
            if (btnElements[v]) {
                btnElements[v].classList.remove('active');
            }
        });
        if (oddsSelector) oddsSelector.style.display = 'none';
        if (goalsSelector) goalsSelector.style.display = 'none';

        const activeView = views.includes(subview) ? subview : 'matrix';
        if (viewElements[activeView]) viewElements[activeView].style.display = 'block';
        if (btnElements[activeView]) btnElements[activeView].classList.add('active');

        if (activeView === 'odds') {
            if (oddsSelector) oddsSelector.style.display = 'flex';
            this.renderFixtureOdds();
        } else if (activeView === 'goals') {
            if (goalsSelector) goalsSelector.style.display = 'flex';
            this.renderGoalsScoredProjections();
        } else if (activeView === 'conceded') {
            if (goalsSelector) goalsSelector.style.display = 'flex';
            this.renderGoalsConcededProjections();
        }
    },

    setFixtureOddsGW(gw) {
        this.state.fixtureOddsGW = parseInt(gw, 10);
        this.renderFixtureOdds();
    },

    sortFixturesByGW(gw) {
        if (this.state.fixtureSortGW === gw) {
            this.state.fixtureSortAsc = !this.state.fixtureSortAsc;
        } else {
            this.state.fixtureSortGW = gw;
            this.state.fixtureSortAsc = true;
        }
        this.renderFixtures();
    },

    sortDashFDRByGW(gw) {
        if (this.state.dashFDRSortGW === gw) {
            this.state.dashFDRSortAsc = !this.state.dashFDRSortAsc;
        } else {
            this.state.dashFDRSortGW = gw;
            this.state.dashFDRSortAsc = true;
        }
        this.renderGeneral();
    },

    setFixtureGoalsHorizon(horizon) {
        this.state.fixtureGoalsHorizon = parseInt(horizon, 10) || 6;
        const activeSubView = document.getElementById('fixture-subview-goals')?.style.display === 'block' ? 'goals' : 'conceded';
        if (activeSubView === 'goals') this.renderGoalsScoredProjections();
        else this.renderGoalsConcededProjections();
    },

    formatSolioKickoff(kickoffTime) {
        if (!kickoffTime) return 'SAT 15:00 KO';
        const d = new Date(kickoffTime);
        if (isNaN(d.getTime())) return 'SAT 15:00 KO';
        const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
        const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const day = days[d.getUTCDay()];
        const dd = d.getUTCDate();
        const month = months[d.getUTCMonth()];
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        return `${day} ${dd} ${month} · ${hh}:${mm} KO`;
    },

    async renderFixtureOdds() {
        const container = document.getElementById('fixture-odds-container');
        if (!container) return;

        const currentGW = this.state.bootstrapData?.events?.find(e => e.is_current)?.id || 
                          this.state.bootstrapData?.events?.find(e => e.is_next)?.id || 1;
        const selectedGW = this.state.fixtureOddsGW || currentGW;

        const select = document.getElementById('fixture-odds-gw-select');
        if (select) {
            if (select.options.length === 0) {
                for (let i = 1; i <= 38; i++) {
                    const opt = document.createElement('option');
                    opt.value = i;
                    opt.textContent = 'GW ' + i;
                    select.appendChild(opt);
                }
            }
            select.value = selectedGW;
        }

        container.innerHTML = '<div style="padding:32px 16px;text-align:center;color:var(--md-sys-color-on-surface-variant);font-family:var(--font-mono);"><span class="material-symbols-outlined" style="font-size:36px;animation:spin 1s linear infinite;">sync</span><p style="margin-top:8px;">Calculating team projections...</p></div>';

        let data = null;
        try {
            data = await this.apiFetch(this.API.teamProjections(selectedGW));
        } catch (e) {
            console.error('API projections error:', e);
        }

        if (!data || !data.matchProjections) {
            container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">event_busy</span><p>No projection data for Gameweek ' + selectedGW + '.</p></div>';
            return;
        }

        this.state.lastFixtureProjectionsData = data;
        const self = this;

        const medalColor = (idx) => idx === 0 ? '#FFD700' : idx === 1 ? '#C0C0C0' : '#CD7F32';

        function fdrColor(fdr) {
            if (fdr <= 2) return 'var(--fdr-2)';
            if (fdr === 3) return 'var(--fdr-3)';
            if (fdr === 4) return 'var(--fdr-4)';
            return 'var(--fdr-5)';
        }

        var matchCards = data.matchProjections.map(function(m) {
            var hXG = m.homeTeam.projectedGoals;
            var aXG = m.awayTeam.projectedGoals;
            var hCS = m.homeTeam.cleanSheetPct;
            var aCS = m.awayTeam.cleanSheetPct;
            var hWin = m.homeTeam.winPct;
            var aWin = m.awayTeam.winPct;
            var draw = m.homeTeam.drawPct;
            var hFDR = m.homeTeam.fdr;
            var aFDR = m.awayTeam.fdr;
            var timeStr = self.formatSolioKickoff(m.kickoff);
            var hXGClass = hXG >= 1.8 ? 'solio-goals-high' : hXG >= 1.3 ? 'solio-goals-mid' : 'solio-goals-low';
            var aXGClass = aXG >= 1.8 ? 'solio-goals-high' : aXG >= 1.3 ? 'solio-goals-mid' : 'solio-goals-low';
            var hCSClass = hCS >= 35 ? 'solio-cs-high' : hCS >= 22 ? 'solio-cs-mid' : 'solio-cs-low';
            var aCSClass = aCS >= 35 ? 'solio-cs-high' : aCS >= 22 ? 'solio-cs-mid' : 'solio-cs-low';

            var probRow = '<div style="display:flex;justify-content:center;gap:12px;margin:8px 0;font-family:var(--font-mono);font-size:10px;">' +
                '<span style="color:var(--md-sys-color-primary);">H ' + hWin.toFixed(0) + '%</span>' +
                '<span style="color:var(--md-sys-color-on-surface-variant);">D ' + draw.toFixed(0) + '%</span>' +
                '<span style="color:var(--fdr-5);">A ' + aWin.toFixed(0) + '%</span>' +
                '</div>';

            var bttsRow = '';
            if (m.probabilities) {
                bttsRow = '<div style="display:flex;justify-content:center;gap:8px;margin-top:4px;font-family:var(--font-mono);font-size:9px;color:var(--md-sys-color-on-surface-variant);">' +
                    '<span>BTTS ' + (m.probabilities.btts || 0) + '%</span>' +
                    '<span>O1.5 ' + (m.probabilities.over15 || 0) + '%</span>' +
                    '<span>O2.5 ' + (m.probabilities.over25 || 0) + '%</span>' +
                    '</div>';
            }

            return '<div style="background:var(--md-sys-color-surface-container);border:1px solid var(--md-sys-color-outline-variant);border-radius:12px;padding:14px;">' +
                '<div style="text-align:center;font-family:var(--font-mono);font-size:10px;color:var(--md-sys-color-outline);margin-bottom:10px;">' + self.escapeHTML(timeStr) + '</div>' +
                probRow +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
                '<div style="display:flex;align-items:center;gap:8px;">' + self.teamBadge(m.homeTeam.shortName, 22) + '<span style="font-family:var(--font-mono);font-weight:800;font-size:14px;color:var(--md-sys-color-on-surface);">' + self.escapeHTML(m.homeTeam.shortName) + '</span></div>' +
                '<div style="display:flex;gap:6px;"><span class="solio-badge ' + hXGClass + '">' + hXG.toFixed(2) + ' xG</span><span class="solio-badge ' + hCSClass + '">' + hCS + '% CS</span></div>' +
                '</div>' +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
                '<div style="display:flex;align-items:center;gap:8px;">' + self.teamBadge(m.awayTeam.shortName, 22) + '<span style="font-family:var(--font-mono);font-weight:800;font-size:14px;color:var(--md-sys-color-on-surface);">' + self.escapeHTML(m.awayTeam.shortName) + '</span></div>' +
                '<div style="display:flex;gap:6px;"><span class="solio-badge ' + aXGClass + '">' + aXG.toFixed(2) + ' xG</span><span class="solio-badge ' + aCSClass + '">' + aCS + '% CS</span></div>' +
                '</div>' +
                bttsRow +
                '</div>';
        }).join('');

        var goalsRank = data.teamsToTarget?.projectedGoals || [];
        var csRank = data.teamsToTarget?.cleanSheets || [];

        function renderLeaderboard(title, icon, items, valueKey, valueLabel, colorFn) {
            if (!items || items.length === 0) return '';
            return '<div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:16px 0;">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:0 16px;">' +
                '<span class="material-symbols-outlined" style="color:var(--md-sys-color-primary);font-size:20px;">' + icon + '</span>' +
                '<span style="font-family:var(--font-mono);font-size:12px;font-weight:800;color:var(--md-sys-color-on-surface-variant);">' + title + '</span>' +
                '</div><div style="display:flex;flex-direction:column;gap:6px;">' +
                items.slice(0, 10).map(function(t, idx) {
                    var medal = idx < 3 ? medalColor(idx) : 'var(--md-sys-color-on-surface-variant)';
                    var val = t[valueKey];
                    var displayVal = typeof val === 'number' ? (valueKey.includes('cs') || valueKey.includes('win') ? val.toFixed(0) + '%' : val.toFixed(2)) : val;
                    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid rgba(255,255,255,0.04);">' +
                        '<div style="display:flex;align-items:center;gap:8px;">' +
                        '<span style="font-family:var(--font-mono);font-weight:900;font-size:12px;color:' + medal + ';">#' + t.rank + '</span>' +
                        self.teamBadge(t.team, 16) +
                        '<span style="font-family:var(--font-mono);font-weight:700;font-size:13px;color:var(--md-sys-color-on-surface);">' + self.escapeHTML(t.team) + '</span>' +
                        '<span style="font-family:var(--font-mono);font-size:10px;color:var(--md-sys-color-on-surface-variant);">vs ' + self.escapeHTML(t.opponent) + (t.isHome ? ' (H)' : ' (A)') + '</span>' +
                        '</div>' +
                        '<span style="font-family:var(--font-mono);font-weight:900;font-size:13px;color:' + (colorFn ? colorFn(t) : 'var(--data-blue)') + ';letter-spacing:0.02em;">' + displayVal + ' ' + valueLabel + '</span></div>';
                }).join('') +
                '</div></div>';
        }

        var html = '<div class="solio-container">' +
            '<div class="solio-header"><div class="solio-title-wrap">' +
            '<h2 class="solio-title">Match Projections <span class="solio-gw-badge">GW' + selectedGW + '</span></h2>' +
            '<p class="solio-subtitle">Dixon-Coles model \u00b7 2024-25 xG ratings \u00b7 ' + (data.projectionSource || 'team-level') + '</p>' +
            '</div></div>' +

            '<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));gap:12px;margin-bottom:24px;">' + matchCards + '</div>' +

            '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:16px;margin-bottom:24px;">' +
            renderLeaderboard('TOP PROJECTED GOALS', 'sports_soccer', goalsRank, 'goals', 'xG', function(t) { return 'var(--data-blue)'; }) +
            renderLeaderboard('BEST CLEAN SHEET CHANCES', 'shield', csRank, 'csPct', 'CS%', function(t) { return 'var(--md-sys-color-primary)'; }) +
            '</div>' +

            '<div class="solio-footer">Projections based on Dixon-Coles model using 2024-25 Premier League xG data (team attack/defense ratings, home advantage, opponent strength).</div>' +
            '</div>';

        container.innerHTML = html;
    },

    async renderTeamNews() {
        const container = document.getElementById('teamnews-container');
        if (!container) return;

        container.innerHTML = `<div style="padding:40px;text-align:center;color:#8ba396;"><span class="material-symbols-outlined" style="font-size:32px;animation:spin 1s linear infinite;">sync</span></div>`;

        try {
            const resp = await fetch('/api/team-news');
            const data = await resp.json();
            const teams = data.teams || [];
            const currentGW = data.currentGW || '';

            let html = `<div class="tn-wrap">`;

            if (teams.length === 0) {
                html += `<div class="tn-empty">
                    <span class="material-symbols-outlined">check_circle</span>
                    <p>All squads clear — no flagged players.</p>
                </div>`;
            } else {
                teams.forEach(teamData => {
                    const { team, players } = teamData;
                    const suspended = players.filter(p => p.category === 'suspended');
                    const out = players.filter(p => p.category === 'out');
                    const injured = players.filter(p => p.category === 'injury');
                    const doubt = players.filter(p => p.category === 'doubt');
                    const other = players.filter(p => p.category === 'news');

                    const count = players.length;
                    const hasOut = suspended.length + out.length + injured.length;

                    html += `<div class="tn-card">
                        <button class="tn-card-header" onclick="this.parentElement.classList.toggle('open')">
                            <span class="tn-chevron material-symbols-outlined">expand_more</span>
                            ${this.teamBadge(team.short, 20)}
                            <span class="tn-team-name">${this.escapeHTML(team.name)}</span>
                            <span class="tn-count">${count}</span>
                        </button>
                        <div class="tn-card-body">`;

                    if (suspended.length) {
                        html += `<div class="tn-section"><div class="tn-section-label tn-red">Suspended</div>`;
                        suspended.forEach(p => { html += this._tnRow(p, '#ff4d4d'); });
                        html += `</div>`;
                    }
                    if (out.length) {
                        html += `<div class="tn-section"><div class="tn-section-label tn-red">Unavailable</div>`;
                        out.forEach(p => { html += this._tnRow(p, '#ff4d4d'); });
                        html += `</div>`;
                    }
                    if (injured.length) {
                        html += `<div class="tn-section"><div class="tn-section-label tn-amber">Injured</div>`;
                        injured.forEach(p => { html += this._tnRow(p, '#FFA600'); });
                        html += `</div>`;
                    }
                    if (doubt.length) {
                        html += `<div class="tn-section"><div class="tn-section-label tn-amber">Doubtful</div>`;
                        doubt.forEach(p => { html += this._tnRow(p, '#FFA600'); });
                        html += `</div>`;
                    }
                    if (other.length) {
                        html += `<div class="tn-section"><div class="tn-section-label tn-gray">News</div>`;
                        other.forEach(p => { html += this._tnRow(p, '#8ba396'); });
                        html += `</div>`;
                    }

                    html += `</div></div>`;
                });
            }

            // Source links footer
            html += `<div class="tn-sources">
                <span class="tn-sources-label">Sources:</span>
                <a href="https://fantasy.premierleague.com/api/bootstrap-static/" target="_blank" rel="noopener">FPL API</a>
                <a href="https://www.fantasyfootballscout.co.uk/fantasy-football-injuries/" target="_blank" rel="noopener">FFS Injuries</a>
                <a href="https://www.premierleague.com/en/latest-player-injuries" target="_blank" rel="noopener">PL Injuries</a>
                <a href="https://www.premierfantasytools.com/premier-league-press-conferences/" target="_blank" rel="noopener">Press Conferences</a>
            </div>`;

            html += `</div>`;
            container.innerHTML = html;
        } catch (err) {
            container.innerHTML = `<div class="tn-empty"><span class="material-symbols-outlined">error</span><p>Failed to load team news.</p></div>`;
        }
    },

    _tnRow(p, color) {
        const chance = p.chance != null ? (p.chance === 0 ? '0%' : p.chance === 100 ? '100%' : p.chance + '%') : '';
        return `<div class="tn-row">
            <div class="tn-row-main">
                <span class="tn-row-name">${this.escapeHTML(p.name)}</span>
                <span class="tn-row-pos">${p.pos}</span>
                ${p.injury ? `<span class="tn-row-injury">${this.escapeHTML(p.injury)}</span>` : ''}
                ${chance ? `<span class="tn-row-chance" style="color:${p.chance === 0 ? '#ff4d4d' : p.chance >= 75 ? '#00FF85' : '#FFA600'}">${chance}</span>` : ''}
            </div>
            ${p.news ? `<div class="tn-row-news">${this.escapeHTML(p.news)}</div>` : ''}
            ${p.managerQuote ? `<div class="tn-row-quote">"${this.escapeHTML(p.managerQuote)}"</div>` : ''}
            <div class="tn-row-meta">
                ${p.sourceUrl ? `<a class="tn-row-source" href="${this.escapeHTML(p.sourceUrl)}" target="_blank" rel="noopener">Source</a>` : ''}
                ${p.returnDate ? `<span class="tn-row-return">Return: ${p.returnDate}</span>` : ''}
            </div>
        </div>`;
    },

    computeLocalTeamProjections(selectedGW) {
        const fixtures = this.state.fixtures || [];
        const bootstrap = this.state.bootstrapData || {};
        const teams = bootstrap.teams || [];
        const elements = bootstrap.elements || [];
        const events = bootstrap.events || [];
        const getTeam = id => teams.find(t => t.id === id) || { id, short_name: '???', name: 'Unknown' };

        const gwFixtures = fixtures.filter(f => f.event === selectedGW);
        const currentGW = events.find(e => e.is_current)?.id || events.find(e => e.is_next)?.id || 1;

        const formatDay = (kickoffTime) => {
            if (!kickoffTime) return 'TBD';
            const d = new Date(kickoffTime);
            if (isNaN(d.getTime())) return 'TBD';
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            return `${days[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        };

        const posMap = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        const FPL_PTS = { GKP: { goal: 10, cs: 4 }, DEF: { goal: 6, cs: 4 }, MID: { goal: 5, cs: 1 }, FWD: { goal: 4, cs: 0 } };

        // Hard-coded 2024-25 xG data (used when bootstrap strengths are all 0)
        const TEAM_XG = {
            'LIV': { xG: 2.24, xGA: 1.00 }, 'ARS': { xG: 1.66, xGA: 0.92 },
            'MCI': { xG: 1.85, xGA: 1.31 }, 'CHE': { xG: 1.81, xGA: 1.30 },
            'NEW': { xG: 1.75, xGA: 1.24 }, 'BOU': { xG: 1.77, xGA: 1.31 },
            'BHA': { xG: 1.59, xGA: 1.46 }, 'CRY': { xG: 1.63, xGA: 1.34 },
            'AVL': { xG: 1.51, xGA: 1.31 }, 'BRE': { xG: 1.62, xGA: 1.49 },
            'FUL': { xG: 1.33, xGA: 1.29 }, 'NFO': { xG: 1.23, xGA: 1.32 },
            'TOT': { xG: 1.57, xGA: 1.75 }, 'MUN': { xG: 1.43, xGA: 1.47 },
            'WHU': { xG: 1.24, xGA: 1.59 }, 'EVE': { xG: 1.10, xGA: 1.26 },
            'WOL': { xG: 1.18, xGA: 1.55 }, 'LEE': { xG: 1.02, xGA: 1.45 },
            'SUN': { xG: 0.94, xGA: 1.53 }, 'COV': { xG: 0.85, xGA: 1.60 },
            'IPS': { xG: 0.79, xGA: 1.68 }, 'HUL': { xG: 0.77, xGA: 1.72 },
        };

        // Check if bootstrap strengths are all 0 (GW1)
        const strengthsZero = teams.every(t => (t.strength_attack_home || 0) === 0 && (t.strength_attack_away || 0) === 0);

        const teamStrengths = {};
        if (strengthsZero) {
            // Use hard-coded xG data with home/away split
            teams.forEach(t => {
                const data = TEAM_XG[t.short_name] || { xG: 1.35, xGA: 1.35 };
                teamStrengths[t.id] = {
                    attackHome: data.xG * 0.58 * 2,
                    attackAway: data.xG * 0.42 * 2,
                    defenseHome: data.xGA * 0.45 * 2,
                    defenseAway: data.xGA * 0.55 * 2,
                };
            });
        } else {
            const meanAtkHome = teams.reduce((s, t) => s + (t.strength_attack_home || 1100), 0) / (teams.length || 20);
            const meanAtkAway = teams.reduce((s, t) => s + (t.strength_attack_away || 1100), 0) / (teams.length || 20);
            const meanDefHome = teams.reduce((s, t) => s + (t.strength_defence_home || 1100), 0) / (teams.length || 20);
            const meanDefAway = teams.reduce((s, t) => s + (t.strength_defence_away || 1100), 0) / (teams.length || 20);
            teams.forEach(t => {
                teamStrengths[t.id] = {
                    attackHome: Math.exp(((t.strength_attack_home || 1100) - meanAtkHome) / 100 * 2.5),
                    attackAway: Math.exp(((t.strength_attack_away || 1100) - meanAtkAway) / 100 * 2.5),
                    defenseHome: Math.exp(((t.strength_defence_home || 1100) - meanDefHome) / 100 * 2.5),
                    defenseAway: Math.exp(((t.strength_defence_away || 1100) - meanDefAway) / 100 * 2.5),
                };
            });
        }

        const allPlayers = [];
        const matchProjections = gwFixtures.map(f => {
            const homeTeam = getTeam(f.team_h);
            const awayTeam = getTeam(f.team_a);
            const fdrHome = f.team_h_difficulty || 3;
            const fdrAway = f.team_a_difficulty || 3;
            const hStr = teamStrengths[f.team_h] || { attackHome: 1, attackAway: 1, defenseHome: 1, defenseAway: 1 };
            const aStr = teamStrengths[f.team_a] || { attackHome: 1, attackAway: 1, defenseHome: 1, defenseAway: 1 };

            const projectPlayer = (el, isHome, oppStr) => {
                const pos = posMap[el.element_type] || 'MID';
                const matches = Math.max(1, (el.minutes || 0) / 90);
                const goalsPerMatch = matches > 0 ? (parseFloat(el.expected_goals) || 0) / matches : 0;
                const assistsPerMatch = matches > 0 ? (parseFloat(el.expected_assists) || 0) / matches : 0;
                const bonusPerMatch = matches > 0 ? (parseFloat(el.bonus_points) || 0) / matches : 0;
                const csRate = matches > 0 ? (parseFloat(el.clean_sheets) || 0) / matches : 0.25;
                const minutesMod = Math.min(1, (el.chance_of_playing_next_round || 100) / 100);
                const atkMod = isHome ? hStr.attackHome : hStr.attackAway;
                const oppDefMod = isHome ? (0.7 + (oppStr.defenseHome * 0.3)) : (0.7 + (oppStr.defenseAway * 0.3));
                const posGoalsMod = { GKP: 0.02, DEF: 0.15, MID: 0.65, FWD: 1.0 }[pos];
                const posAssistsMod = { GKP: 0.01, DEF: 0.20, MID: 0.75, FWD: 0.55 }[pos];
                const posBonusMod = { GKP: 0.15, DEF: 0.25, MID: 0.45, FWD: 0.40 }[pos];
                const posCSMod = { GKP: 1, DEF: 1, MID: 0.3, FWD: 0 }[pos];

                const goals = Math.max(0, Math.min(2.5, goalsPerMatch * atkMod * oppDefMod * posGoalsMod * minutesMod));
                const assists = Math.max(0, Math.min(2.0, assistsPerMatch * atkMod * oppDefMod * posAssistsMod * minutesMod));
                const csProb = Math.round(Math.max(0, Math.min(85, csRate * (1 / (isHome ? hStr.defenseHome : hStr.defenseAway)) * posCSMod * minutesMod * 100)));
                const bonus = Math.max(0, Math.min(3, bonusPerMatch * atkMod * posBonusMod * minutesMod));
                const goalPts = goals * (FPL_PTS[pos]?.goal || 5);
                const assistPts = assists * 3;
                const csPts = (csProb / 100) * (FPL_PTS[pos]?.cs || 0);
                const minsPts = minutesMod >= 0.8 ? 2 : minutesMod >= 0.4 ? 1 : 0;
                const totalPoints = goalPts + assistPts + csPts + bonus + minsPts;

                return {
                    id: el.id, name: el.web_name, team: isHome ? homeTeam.short_name : awayTeam.short_name,
                    teamId: isHome ? f.team_h : f.team_a, position: pos,
                    price: (el.now_cost || 50) / 10,
                    goals: Math.round(goals * 1000) / 1000,
                    assists: Math.round(assists * 1000) / 1000,
                    csProb, bonus: Math.round(bonus * 100) / 100,
                    totalPoints: Math.round(totalPoints * 100) / 100,
                    fixture: homeTeam.short_name + ' vs ' + awayTeam.short_name,
                };
            };

            const homePlayers = elements.filter(e => e.team === f.team_h && e.minutes > 0).map(e => projectPlayer(e, true, aStr));
            const awayPlayers = elements.filter(e => e.team === f.team_a && e.minutes > 0).map(e => projectPlayer(e, false, hStr));

            allPlayers.push(...homePlayers, ...awayPlayers);

            const hGoals = homePlayers.reduce((s, p) => s + p.goals, 0);
            const aGoals = awayPlayers.reduce((s, p) => s + p.goals, 0);
            const hCS = Math.min(85, Math.max(5, Math.round(Math.exp(-aGoals) * 100)));
            const aCS = Math.min(85, Math.max(5, Math.round(Math.exp(-hGoals) * 100)));
            const hTop = [...homePlayers].sort((a, b) => b.totalPoints - a.totalPoints).slice(0, 3).map(p => ({ name: p.name, position: p.position, points: p.totalPoints, goals: p.goals, assists: p.assists }));
            const aTop = [...awayPlayers].sort((a, b) => b.totalPoints - a.totalPoints).slice(0, 3).map(p => ({ name: p.name, position: p.position, points: p.totalPoints, goals: p.goals, assists: p.assists }));

            return {
                id: f.id, gw: selectedGW, kickoff: f.kickoff_time, dayStr: formatDay(f.kickoff_time),
                homeTeam: { id: homeTeam.id, name: homeTeam.name, shortName: homeTeam.short_name, projectedGoals: Math.round(hGoals * 100) / 100, cleanSheetPct: hCS, fdr: fdrHome, topPlayers: hTop, projectedPoints: Math.round(homePlayers.reduce((s, p) => s + p.totalPoints, 0) * 100) / 100 },
                awayTeam: { id: awayTeam.id, name: awayTeam.name, shortName: awayTeam.short_name, projectedGoals: Math.round(aGoals * 100) / 100, cleanSheetPct: aCS, fdr: fdrAway, topPlayers: aTop, projectedPoints: Math.round(awayPlayers.reduce((s, p) => s + p.totalPoints, 0) * 100) / 100 },
                players: [...homePlayers, ...awayPlayers].sort((a, b) => b.totalPoints - a.totalPoints),
            };
        });

        allPlayers.sort((a, b) => b.totalPoints - a.totalPoints);
        const goalsList = matchProjections.flatMap(m => [
            { team: m.homeTeam.shortName, opponent: m.awayTeam.shortName, goals: m.homeTeam.projectedGoals },
            { team: m.awayTeam.shortName, opponent: m.homeTeam.shortName, goals: m.awayTeam.projectedGoals },
        ]).sort((a, b) => b.goals - a.goals);
        const csList = matchProjections.flatMap(m => [
            { team: m.homeTeam.shortName, opponent: m.awayTeam.shortName, csPct: m.homeTeam.cleanSheetPct },
            { team: m.awayTeam.shortName, opponent: m.homeTeam.shortName, csPct: m.awayTeam.cleanSheetPct },
        ]).sort((a, b) => b.csPct - a.csPct);
        goalsList.forEach((item, i) => { item.rank = i + 1; });
        csList.forEach((item, i) => { item.rank = i + 1; });

        return {
            gw: selectedGW, matchProjections,
            teamsToTarget: { projectedGoals: goalsList, cleanSheets: csList },
            topPlayers: allPlayers.slice(0, 30),
            topGoals: [...allPlayers].sort((a, b) => b.goals - a.goals).slice(0, 20),
            topAssists: [...allPlayers].sort((a, b) => b.assists - a.assists).slice(0, 20),
            topBonus: [...allPlayers].sort((a, b) => b.bonus - a.bonus).slice(0, 20),
        };
    },

    renderGoalsScoredProjections: null,
    renderGoalsConcededProjections: null,

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

    // ==================== RENDER: CAPTAINCY MODEL ====================
    setCaptainGameweek(gw) {
        const gameweek = parseInt(gw, 10);
        if (!Number.isInteger(gameweek)) return;
        this.state.captainGW = gameweek;
        this.renderCaptaincy();
    },

    captainFixtureBadges(fixtures) {
        return (fixtures || []).map(fixture => `
            <span class="captaincy-fixture-badge">
                <span>${fixture.label}</span>
            </span>
        `).join('');
    },

    renderCaptainSpotlight(player, type) {
        if (!player) return '<div class="captaincy-empty">No eligible pick for this gameweek.</div>';
        const isBest = type === 'best';
        const label = isBest ? 'BEST CAPTAIN' : `DIFFERENTIAL < ${player.threshold}%`;
        const icon = isBest ? 'stars' : 'trending_up';
        const rank = !isBest && player.overallRank ? `<span class="captaincy-overall-rank">#${player.overallRank} overall</span>` : '';
        return `
            <div class="captaincy-spotlight-topline">
                <span class="captaincy-pick-label"><span class="material-symbols-outlined">${icon}</span>${label}</span>
                ${rank}
            </div>
            <div class="captaincy-player-lead">
                <div class="captaincy-player-photo">
                    ${this.playerPhotoMarkup(player, `${player.name} photo`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}
                </div>
                <div class="captaincy-player-heading">
                    <div class="captaincy-player-meta">${this.teamBadge(player.team, 18)} ${player.team} · ${player.position} · £${player.cost.toFixed(1)}m</div>
                    <h2>${player.name}</h2>
                    <div class="captaincy-fixtures">${this.captainFixtureBadges(player.fixtures)}</div>
                </div>
                <div class="captaincy-xpts-block"><strong>${player.xPts.toFixed(1)}</strong><span>xPts</span></div>
            </div>
            <p class="captaincy-explanation">${player.explanation}</p>
            <div class="captaincy-metrics">
                <div><span>xMins</span><strong>${player.xMins}</strong></div>
                <div><span>${player.formSource === 'form' ? 'Form' : 'PPG base'}</span><strong>${player.formUsed.toFixed(1)}</strong></div>
                <div><span>xGI / 90</span><strong>${player.xGI90.toFixed(2)}</strong></div>
                <div><span>Ownership</span><strong>${player.ownership.toFixed(1)}%</strong></div>
                <div><span>Minutes confidence</span><strong>${player.confidence}</strong></div>
            </div>
        `;
    },

    async renderCaptaincy() {
        const tbody = document.getElementById('captain-picks-body');
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="captaincy-loading">Recalculating captaincy picks...</td></tr>';
        try {
            const requestedGW = this.state.captainGW || '';
            const cacheKey = `captain-${requestedGW}`;
            let data = this.getCachedTabData(cacheKey);
            if (!data) {
                data = await this.apiFetch(this.API.captainPicks(requestedGW));
                this.setCachedTabData(cacheKey, data);
            }
            this.state.captainPicks = data;
            this.state.captainGW = data.gameweek;

            const gwSelect = document.getElementById('captain-gw-select');
            if (gwSelect) {
                const gameweeks = data.availableGameweeks?.length ? data.availableGameweeks : Array.from({ length: 38 }, (_, index) => index + 1);
                gwSelect.innerHTML = gameweeks.map(gw => `<option value="${gw}"${gw === data.gameweek ? ' selected' : ''}>GW ${gw}</option>`).join('');
            }

            const status = document.getElementById('cap-model-updated');
            if (status) {
                const updated = new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                status.textContent = `${data.modelVersion} · updated ${updated}`;
            }

            const title = document.getElementById('cap-table-title');
            if (title) title.textContent = `Top 5 Captain Picks · GW${data.gameweek}`;

            const inputs = document.getElementById('cap-model-inputs');
            if (inputs) inputs.innerHTML = (data.modelInputs || []).map(input => `<span>${input}</span>`).join('');

            const bestCard = document.getElementById('cap-best-card');
            if (bestCard) bestCard.innerHTML = this.renderCaptainSpotlight(data.bestPick, 'best');
            const differentialCard = document.getElementById('cap-differential-card');
            if (differentialCard) differentialCard.innerHTML = this.renderCaptainSpotlight(data.differentialPick, 'differential');

            if (!tbody) return;
            const picks = data.topPicks || [];
            if (!picks.length) {
                tbody.innerHTML = '<tr><td colspan="8" class="captaincy-empty">No eligible players have a fixture in this gameweek.</td></tr>';
                return;
            }

            tbody.innerHTML = picks.map(player => {
                const isDifferential = data.differentialPick?.id === player.id;
                const labels = [
                    player.rank === 1 ? '<span class="captaincy-row-label captaincy-row-label-best">BEST</span>' : '',
                    isDifferential ? '<span class="captaincy-row-label captaincy-row-label-diff">DIFF</span>' : ''
                ].join('');
                return `<tr class="${player.rank === 1 ? 'captaincy-row-best' : ''}" style="cursor:pointer;" onclick="FPL.showPlayerDetail(${player.id})">
                    <td><span class="captaincy-rank">${player.rank}</span></td>
                    <td>
                        <div class="captaincy-table-player">
                            <div class="captaincy-table-photo">${this.playerPhotoMarkup(player, `${player.name} photo`, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;', true)}</div>
                            <div class="captaincy-table-player-info"><strong>${player.name}${labels}</strong><span>${player.team} · ${player.position}</span></div>
                        </div>
                    </td>
                    <td><div class="captaincy-fixtures">${this.captainFixtureBadges(player.fixtures)}</div></td>
                    <td class="mono">${player.formUsed.toFixed(1)}</td>
                    <td class="mono">${player.xMins}</td>
                    <td class="mono">${player.xGI90.toFixed(2)}</td>
                    <td class="mono">${player.ownership.toFixed(1)}%</td>
                    <td class="captaincy-table-xpts mono">${player.xPts.toFixed(1)}</td>
                </tr>`;
            }).join('');
        } catch (err) {
            console.error('Captaincy model render error:', err);
            if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="captaincy-error">Failed to load captaincy picks: ${err.message}</td></tr>`;
        }
    },

    resolvePlayer(player) {
        if (!player) return null;
        const candidates = this.state.bootstrapData?.elements || [];
        const rawPhoto = String(player.photo ?? player.photoId ?? '').replace(/^p/i, '').replace(/\.(png|jpe?g)$/i, '');
        const code = Number(player.code || rawPhoto);
        if (Number.isFinite(code) && code > 0) {
            const byCode = candidates.find(candidate => Number(candidate.code) === code);
            if (byCode) return byCode;
        }
        const elementId = Number(player.id || player.elementId || player.element);
        if (Number.isFinite(elementId) && this.state.playerMap[elementId]) return this.state.playerMap[elementId];
        const normalizeName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const name = normalizeName(player.web_name || player.webName || player.name);
        if (!name) return null;
        const team = String(player.teamShort || player.team || '').toUpperCase();
        return candidates.find(candidate => {
            const candidateName = normalizeName(candidate.web_name);
            return candidateName === name && (!team || candidate.teamShort === team || String(candidate.team) === team);
        }) || candidates.find(candidate => normalizeName(candidate.web_name) === name) || null;
    },

    playerPhotoUrl(player, size = '110x140', alwaysShow = false) {
        if (!alwaysShow && this.getSetting('showPhotos') === false) return '';
        const current = this.resolvePlayer(player) || player;
        const rawPhoto = String(current?.photo ?? current?.photoId ?? '').replace(/^p/i, '').replace(/\.(png|jpe?g)$/i, '');
        const code = Number(current?.code || rawPhoto);
        if (this.state.fotmobUnavailablePhotos.has(String(code))) return '';
        const fotmobId = Number(current?.fotmobId || this.state.fotmobPlayerIds[String(code)]);
        return Number.isFinite(fotmobId) && fotmobId > 0
            ? `https://images.fotmob.com/image_resources/playerimages/${fotmobId}.png`
            : '';
    },

    playerInitials(player) {
        const current = this.resolvePlayer(player) || player || {};
        const name = String(current.web_name || current.webName || current.name || 'FPL');
        const parts = name.split(/[\s.-]+/).filter(Boolean);
        return (parts.length > 1 ? parts.map(part => part[0]).join('') : name.slice(0, 2)).slice(0, 2).toUpperCase();
    },

    playerTeamShort(player) {
        const current = this.resolvePlayer(player);
        if (current) return current.teamShort || this.state.teamMap[current.team]?.short_name || 'FPL';
        return String(player?.teamShort || player?.team || 'FPL').slice(0, 4).toUpperCase();
    },

    playerTeamShirtUrl(player) {
        const current = this.resolvePlayer(player);
        const teamId = current?.team || Number(player?.teamId);
        const team = this.state.teamMap[teamId];
        const teamCode = Number(team?.code || current?.team_code);
        return Number.isFinite(teamCode) && teamCode > 0
            ? `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${teamCode}-110.webp`
            : '';
    },

    pitchShirtMarkup(player, teamShort = '') {
        const shirt = this.playerTeamShirtUrl(player);
        const fallback = this.escapeHTML(teamShort || this.playerTeamShort(player));
        const img = shirt
            ? `<img src="${shirt}" alt="" loading="lazy" decoding="async" onerror="this.closest('.tactics-player-shirt').classList.add('is-missing');this.remove();" style="width:100%;height:100%;object-fit:contain;">`
            : '';
        return `${img}<span class="aiteam-shirt-fallback" aria-hidden="true">${fallback}</span>`;
    },

    starterBadge(player) {
        if (!player) return '';
        const tier = player.starterTier || 'Unknown role';
        const score = Number(player.starterScore);
        const cls = score >= 75 ? 'is-nailed' : score >= 55 ? 'is-likely' : score >= 35 ? 'is-rotation' : 'is-unknown';
        return `<span class="aiteam-starter-badge ${cls}" title="${this.escapeHTML(tier)} (${Number.isFinite(score) ? score : '?'}/100)">${this.escapeHTML(tier)}</span>`;
    },


    playerPhotoMarkup(player, alt = 'FPL player', className = '', style = '', alwaysShow = false) {
        const src = this.playerPhotoUrl(player, '110x140', alwaysShow);
        const shirt = this.playerTeamShirtUrl(player);
        const image = src ? `<img${className ? ` class="${className}"` : ''} src="${src}" alt="${this.escapeHTML(alt)}" loading="lazy" decoding="async" onerror="FPL.handlePlayerPhotoError(this)" style="${style}">` : '';
        const shirtImage = shirt ? `<img class="player-current-shirt" src="${shirt}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'" style="width:80%;height:80%;object-fit:contain;">` : '';
        return `${image}<span class="player-photo-fallback" data-player-fallback aria-hidden="true">${shirtImage}</span>`;
    },

    handlePlayerPhotoError(image) {
        image.onerror = null;
        image.style.display = 'none';
        const fallback = image.parentElement?.querySelector('[data-player-fallback]');
        if (fallback) fallback.style.display = 'flex';
    },

    // ==================== RENDER: OWNERSHIP ====================
    // ==================== RENDER: OWNERSHIP TRENDS ====================
    async renderOwnership() {
        try {
            let data = this.getCachedTabData('ownership');
            if (!data) {
                data = await this.apiFetch(this.API.ownershipTrends);
                this.setCachedTabData('ownership', data);
            }
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
            const snapshotResponse = await fetch('/api/ownership/snapshot', { method: 'POST' });
            if (snapshotResponse.status === 503) return;
        } catch (e) {
            // Silent fail - snapshot is non-critical
        }
    },

    renderOwnershipBento(data) {
        const inContainer = document.getElementById('bento-in-content');
        const outContainer = document.getElementById('bento-out-content');
        const velContainer = document.getElementById('bento-velocity-content');

        const posColors = { GKP: '#FFD700', DEF: '#4FC3F7', MID: '#81C784', FWD: '#E57373' };

        // 1. Transferred In (biggest ownership gain)
        if (inContainer && data.topTransferredIn) {
            const p = data.topTransferredIn;
            const sparklineSVG = this.generateSparklineSVG(p.sparkline, p.delta24h >= 0, 100, 32);

            inContainer.innerHTML = `
                <div style="display:flex;align-items:center;gap:14px;">
                    <span class="player-photo-shell" style="width:48px;height:48px;min-width:48px;border-radius:50%;border:2px solid #00FF8540;">${this.playerPhotoMarkup(p, p.name, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}</span>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:700;font-size:0.9375rem;color:#dfe4e0;display:flex;align-items:center;gap:6px;">
                            ${p.name}
                            <span style="padding:1px 6px;border-radius:var(--radius-pill);font-size:0.625rem;font-weight:700;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                        </div>
                        <div style="font-size:0.75rem;color:#8ba396;">${p.team} • ${this.formatPriceDisplay(p.costStr, p.cost)}</div>
                        <div class="mono" style="font-size:0.8125rem;font-weight:700;color:#00FF85;margin-top:3px;">+${p.delta24h}% 24h gain</div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                        <div class="mono" style="font-size:1.25rem;font-weight:800;color:#00FF85;">+${p.delta24h}%</div>
                        <div style="font-size:0.6875rem;color:#8ba396;">24h gain</div>
                        <div style="font-size:0.6875rem;color:#8ba396;margin-top:2px;">Own ${p.ownership}%</div>
                        <div style="margin-top:4px;">${sparklineSVG}</div>
                    </div>
                </div>`;
        }

        // 2. Transferred Out (biggest ownership drop)
        if (outContainer && data.topTransferredOut) {
            const p = data.topTransferredOut;
            const sparklineSVG = this.generateSparklineSVG(p.sparkline, p.delta24h >= 0, 100, 32);

            outContainer.innerHTML = `
                <div style="display:flex;align-items:center;gap:14px;">
                    <span class="player-photo-shell" style="width:48px;height:48px;min-width:48px;border-radius:50%;border:2px solid #FF005A40;">${this.playerPhotoMarkup(p, p.name, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}</span>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:700;font-size:0.9375rem;color:#dfe4e0;display:flex;align-items:center;gap:6px;">
                            ${p.name}
                            <span style="padding:1px 6px;border-radius:var(--radius-pill);font-size:0.625rem;font-weight:700;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                        </div>
                        <div style="font-size:0.75rem;color:#8ba396;">${p.team} • ${this.formatPriceDisplay(p.costStr, p.cost)}</div>
                        <div class="mono" style="font-size:0.8125rem;font-weight:700;color:#FF005A;margin-top:3px;">${p.delta24h}% 24h drop</div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                        <div class="mono" style="font-size:1.25rem;font-weight:800;color:#FF005A;">${p.delta24h}%</div>
                        <div style="font-size:0.6875rem;color:#8ba396;">24h drop</div>
                        <div style="font-size:0.6875rem;color:#8ba396;margin-top:2px;">Own ${p.ownership}%</div>
                        <div style="margin-top:4px;">${sparklineSVG}</div>
                    </div>
                </div>`;
        }

        // 3. Highest Velocity Shift
        if (velContainer && data.highestVelocity) {
            const p = data.highestVelocity;
            const velSign = p.velocityShift >= 0 ? '+' : '';
            const velColor = p.velocityShift >= 0 ? '#00FF85' : '#ff6b6b';
            const sparklineSVG = this.generateSparklineSVG(p.sparkline, p.velocityShift >= 0, 100, 32);

            velContainer.innerHTML = `
                <div style="display:flex;align-items:center;gap:14px;">
                    <span class="player-photo-shell" style="width:48px;height:48px;min-width:48px;border-radius:50%;border:2px solid #FFA60040;">${this.playerPhotoMarkup(p, p.name, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}</span>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:700;font-size:0.9375rem;color:#dfe4e0;display:flex;align-items:center;gap:6px;">
                            ${p.name}
                            <span style="padding:1px 6px;border-radius:var(--radius-pill);font-size:0.625rem;font-weight:700;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                        </div>
                        <div style="font-size:0.75rem;color:#8ba396;">${p.team} • ${this.formatPriceDisplay(p.costStr, p.cost)}</div>
                        <div class="mono" style="font-size:0.8125rem;font-weight:700;color:${velColor};margin-top:3px;">${velSign}${p.velocityShift}% Δ (7d vs 24h)</div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                        <div class="mono" style="font-size:1.25rem;font-weight:800;color:${velColor};">${velSign}${p.velocityShift}%</div>
                        <div style="font-size:0.6875rem;color:#8ba396;">velocity shift</div>
                        <div style="font-size:0.6875rem;color:#8ba396;margin-top:2px;">Own ${p.ownership}%</div>
                        <div style="margin-top:4px;">${sparklineSVG}</div>
                    </div>
                </div>`;
        }
    },

    ownSortKey: 'ownership',
    ownSortDir: 'desc',

    toggleOwnershipSort(key) {
        if (this.ownSortKey === key) {
            this.ownSortDir = this.ownSortDir === 'desc' ? 'asc' : 'desc';
        } else {
            this.ownSortKey = key;
            this.ownSortDir = 'desc';
        }
        const select = document.getElementById('own-sort');
        if (select && select.querySelector(`option[value="${key}"]`)) {
            select.value = key;
        }
        this.renderOwnershipTable();
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
        const sortKey = this.ownSortKey || document.getElementById('own-sort')?.value || 'ownership';
        const sortDir = this.ownSortDir === 'asc' ? 1 : -1;

        const ownSortIds = ['name','cost','ownership','delta24h','delta3d','delta7d','points'];
        ownSortIds.forEach(id => {
            const icon = document.getElementById('own-sort-icon-' + id);
            if (icon) {
                if (id === sortKey) {
                    icon.style.display = 'inline';
                    icon.textContent = sortDir === -1 ? 'arrow_downward' : 'arrow_upward';
                } else {
                    icon.style.display = 'none';
                }
            }
        });

        if (sortKey === 'name') {
            players.sort((a, b) => a.name.localeCompare(b.name) * sortDir);
        } else if (sortKey === 'cost') {
            players.sort((a, b) => ((b.cost || 0) - (a.cost || 0)) * sortDir);
        } else {
            players.sort((a, b) => ((b[sortKey] ?? 0) - (a[sortKey] ?? 0)) * sortDir);
        }

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
            <tr style="border-bottom:1px solid #333333;transition:background 0.15s;cursor:pointer;" onclick="FPL.showPlayerDetail(${p.id || 0})" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background='transparent'">
                <td style="padding:4px 6px;text-align:center;color:#B0B0B0;font-family:var(--font-mono);font-size:10px;background:#1E1E1E;">${i + 1}</td>
                <td style="padding:4px 6px;text-align:left;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span class="player-photo-shell" style="width:28px;height:28px;border-radius:50%;border:1px solid #444444;">${this.playerPhotoMarkup(p, p.name || 'FPL Player', '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')}</span>
                        <div style="min-width:0;">
                            <div style="font-weight:700;font-size:11px;color:#E0E0E0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</div>
                            <div style="display:flex;align-items:center;gap:3px;font-size:9px;color:#B0B0B0;">
                                ${this.teamBadge(p.team, 12)}
                                <span style="font-weight:600;">${p.team}</span>
                                <span style="color:#444;">·</span>
                                <span style="padding:0 3px;border-radius:2px;font-weight:700;font-size:8px;background:${posColors[p.position]}20;color:${posColors[p.position]};">${p.position}</span>
                            </div>
                        </div>
                    </div>
                </td>
                <td style="padding:4px 6px;text-align:center;font-family:var(--font-mono);font-weight:600;color:#E0E0E0;">${this.formatPriceDisplay(p.costStr, p.cost)}</td>
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
    escapeHTML(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
    },

    formatTacticsKickoff(kickoff) {
        if (!kickoff) return 'Date TBC';
        const date = new Date(kickoff);
        if (Number.isNaN(date.getTime())) return 'Date TBC';
        return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' +
            date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    },

    setTacticsStatus(message, type = '') {
        const el = document.getElementById('zones-analysis-status');
        if (!el) return;
        el.textContent = message || '';
        el.className = `tactics-status${type ? ` is-${type}` : ''}`;
    },

    async renderZones() {
        const gwSelect = document.getElementById('zones-gw-select');
        if (!gwSelect) return;
        if (gwSelect.options.length !== 38) {
            gwSelect.innerHTML = Array.from({ length: 38 }, (_, index) => `<option value="${index + 1}">GW ${index + 1}</option>`).join('');
        }
        const selectedGW = this.state.selectedGW || this.state.currentGW || 1;
        gwSelect.value = String(selectedGW);
        if (this.state.zoneData?.selectedGW === selectedGW) {
            this.renderTacticsFixtures(this.state.zoneData);
            return;
        }
        await this.loadMatchFixtures();
    },

    async loadMatchFixtures() {
        const gwSelect = document.getElementById('zones-gw-select');
        const selectedGW = parseInt(gwSelect?.value, 10) || this.state.currentGW || 1;
        this.state.selectedGW = selectedGW;
        const token = (this._zoneRequestToken || 0) + 1;
        this._zoneRequestToken = token;
        this.setTacticsStatus(`Loading GW ${selectedGW} fixture intelligence...`, 'loading');

        if (!this._zoneLoads) this._zoneLoads = new Map();
        let request = this._zoneLoads.get(selectedGW);
        if (!request) {
            request = this.apiFetch(this.API.zoneAnalysis(selectedGW)).finally(() => {
                if (this._zoneLoads.get(selectedGW) === request) this._zoneLoads.delete(selectedGW);
            });
            this._zoneLoads.set(selectedGW, request);
        }

        try {
            const data = await request;
            if (token !== this._zoneRequestToken) return data;
            this.state.zoneData = data;
            this.state.selectedGW = data.selectedGW || selectedGW;
            this.renderTacticsFixtures(data);
            this.setTacticsStatus('Select a fixture to open the full match dissection.');
            return data;
        } catch (error) {
            if (token !== this._zoneRequestToken) return null;
            console.error('Tactics fixture load error:', error);
            this.setTacticsStatus('Fixture analysis could not be loaded. Try the gameweek again.', 'error');
            const list = document.getElementById('zones-fixture-list');
            if (list) list.innerHTML = '<div class="tactics-inline-empty">No fixture data available.</div>';
            document.getElementById('match-analysis-content')?.style.setProperty('display', 'none');
            document.getElementById('match-empty-state')?.style.setProperty('display', 'block');
            return null;
        }
    },

    renderTacticsFixtures(data) {
        const fixtures = data?.matchBreakdowns || [];
        const list = document.getElementById('zones-fixture-list');
        const count = document.getElementById('zones-fixture-count');
        if (!list) return;
        if (count) count.textContent = `${fixtures.length} fixtures`;
        if (!fixtures.length) {
            list.innerHTML = '<div class="tactics-inline-empty">No fixtures are scheduled for this gameweek.</div>';
            document.getElementById('match-analysis-content')?.style.setProperty('display', 'none');
            document.getElementById('match-empty-state')?.style.setProperty('display', 'block');
            return;
        }

        const selectedExists = fixtures.some(match => String(match.fixture.id) === String(this.state.selectedFixtureId));
        if (!selectedExists) this.state.selectedFixtureId = fixtures[0].fixture.id;
        const e = value => this.escapeHTML(value);
        list.innerHTML = fixtures.map(match => {
            const fixture = match.fixture;
            const selected = String(fixture.id) === String(this.state.selectedFixtureId);
            const score = fixture.finished ? `${fixture.team_h_score ?? '-'} - ${fixture.team_a_score ?? '-'}` : 'vs';
            const homeLogo = this.getTeamLogo(fixture.homeTeam);
            const awayLogo = this.getTeamLogo(fixture.awayTeam);
            return `<button type="button" class="tactics-fixture-card${selected ? ' is-selected' : ''}" role="option" aria-selected="${selected}" onclick="FPL.selectTacticsFixture('${e(fixture.id)}')">
                <span class="tactics-fixture-time">${e(this.formatTacticsKickoff(fixture.kickoff))}</span>
                <span class="tactics-fixture-teams">
                    <span class="tactics-fixture-team">${homeLogo ? `<img src="${homeLogo}" style="width:18px;height:18px;object-fit:contain;">` : ''}<b>${e(fixture.homeTeam)}</b></span>
                    <strong>${e(score)}</strong>
                    <span class="tactics-fixture-team is-away"><b>${e(fixture.awayTeam)}</b>${awayLogo ? `<img src="${awayLogo}" style="width:18px;height:18px;object-fit:contain;">` : ''}</span>
                </span>
            </button>`;
        }).join('');
        this.renderSelectedTacticsMatch();
    },

    selectTacticsFixture(fixtureId) {
        this.state.selectedFixtureId = fixtureId;
        if (this.state.zoneData) this.renderTacticsFixtures(this.state.zoneData);
    },

    renderSelectedTacticsMatch() {
        const matches = this.state.zoneData?.matchBreakdowns || [];
        const match = matches.find(item => String(item.fixture.id) === String(this.state.selectedFixtureId)) || matches[0];
        if (!match) return;
        this.state.selectedFixtureId = match.fixture.id;
        document.getElementById('match-analysis-content')?.style.setProperty('display', 'block');
        document.getElementById('match-empty-state')?.style.setProperty('display', 'none');
        const awayPanel = document.getElementById('away-picks-panel');
        if (awayPanel) awayPanel.style.display = '';
        this.renderTacticsMatchHero(match);
        this.renderTacticsFormation(match.home, true);
        this.renderTacticsFormation(match.away, false);
        this.renderTacticsDissection(match);
        this.renderBestPicks(match);
    },

    renderTacticsMatchHero(match) {
        const fixture = match.fixture;
        const homeLogo = this.getTeamLogo(fixture.homeTeam);
        const awayLogo = this.getTeamLogo(fixture.awayTeam);
        const e = value => this.escapeHTML(value);
        const score = fixture.finished ? `${fixture.team_h_score ?? '-'} - ${fixture.team_a_score ?? '-'}` : '—';
        const hero = document.getElementById('zones-match-hero');
        if (!hero) return;
        hero.innerHTML = `<div class="tactics-match-kicker">GW ${fixture.gw} MATCH BRIEF · ${e(this.formatTacticsKickoff(fixture.kickoff))}</div>
            <div class="tactics-match-teams">
                <div class="tactics-match-team tactics-match-home">${homeLogo ? `<img src="${homeLogo}" alt="${e(fixture.homeTeam)} crest">` : ''}<strong>${e(fixture.homeTeam)}</strong><span>HOME</span></div>
                <div class="tactics-match-score"><b>${e(score)}</b><span>${e(match.prediction === 'Even' ? 'Balanced matchup' : `${match.prediction} edge`)}</span></div>
                <div class="tactics-match-team tactics-match-away"><strong>${e(fixture.awayTeam)}</strong><span>AWAY</span>${awayLogo ? `<img src="${awayLogo}" alt="${e(fixture.awayTeam)} crest">` : ''}</div>
            </div>`;
    },

    tacticsPlayerCard(player, accent = 'home', compact = false) {
        if (!player) return '';
        const e = value => this.escapeHTML(value);
        const shirt = this.playerTeamShirtUrl(player);
        return `<div class="tactics-player-card ${accent}${compact ? ' is-compact' : ''}" title="${e(player.name)}">
            <div class="tactics-player-shirt">${shirt ? `<img src="${shirt}" alt="" onerror="this.style.display='none'">` : ''}</div>
            <div class="tactics-player-copy"><b>${e(player.name)}</b></div>
        </div>`;
    },

    renderTacticsFormation(teamData, isHome) {
        const e = value => this.escapeHTML(value);
        const accent = isHome ? 'home' : 'away';
        const positions = ['gk', 'lb', 'lcb', 'rcb', 'rb', 'ldm', 'rdm', 'lw', 'cam', 'rw', 'st'];
        const rows = [['gk'], ['lb', 'lcb', 'rcb', 'rb'], ['ldm', 'rdm'], ['lw', 'cam', 'rw'], ['st']].map(zones =>
            `<div class="tactics-pitch-row">${zones.map(zone => this.tacticsPlayerCard(teamData.zoneStats?.[zone]?.players?.[0], accent)).join('')}</div>`
        ).join('');
        const defconClass = teamData.defcon >= 58 ? 'strong' : teamData.defcon >= 38 ? 'average' : 'weak';
        const panel = document.getElementById(isHome ? 'home-formation-panel' : 'away-formation-panel');
        if (!panel) return;
        panel.innerHTML = `<div class="tactics-team-heading"><div><span class="tactics-kicker">${isHome ? 'HOME XI' : 'AWAY XI'}</span><h2>${e(teamData.teamName)}</h2></div><span class="tactics-defcon-pill ${defconClass}">${teamData.defcon}/100 DEFCON</span></div>
            <div class="tactics-pitch" aria-label="${e(teamData.teamName)} player cards by detailed position">${rows}</div>
            <div class="tactics-team-stats">
                <div><span>ATTACK xGI</span><b>${Number(teamData.totalXG + teamData.totalXA).toFixed(1)}</b></div>
                <div><span>GOALS</span><b>${teamData.totalGoals}</b></div>
                <div><span>ASSISTS</span><b>${teamData.totalAssists ?? '--'}</b></div>
                <div><span>CLEAN SHEETS</span><b>${teamData.teamCS}</b></div>
            </div>
            <div class="tactics-edge-list">
                <div class="tactics-edge is-positive"><span>STRONG SIDE</span><b>${e(teamData.strongestAttackZone || '--')}</b></div>
                <div class="tactics-edge is-negative"><span>DEFENSIVE FLAW</span><b>${e(teamData.weakestDefenceZone || '--')}</b></div>
            </div>`;
    },

    renderTacticsDissection(match) {
        const { home, away, fixture } = match;
        const homeBar = Math.max(5, Math.min(95, (home.defcon / Math.max(home.defcon + away.defcon, 1)) * 100));
        const awayBar = 100 - homeBar;
        const e = value => this.escapeHTML(value);
        const center = document.getElementById('match-center-panel');
        if (!center) return;
        center.innerHTML = `<div class="tactics-center-heading"><span class="tactics-kicker">MATCH READ</span><h2>Where this game is won</h2></div>
            <div class="tactics-read-block is-danger"><span class="material-symbols-outlined">bolt</span><div><span class="tactics-read-label">${e(home.teamName)} attacking route</span><b>${e(home.strongestAttackZone || '--')} into ${e(away.weakestDefenceZone || '--')}</b><p>${e(home.teamName)}'s strongest side meets the opponent's most exposed defensive channel.</p></div></div>
            <div class="tactics-read-block is-warning"><span class="material-symbols-outlined">warning</span><div><span class="tactics-read-label">${e(away.teamName)} attacking route</span><b>${e(away.strongestAttackZone || '--')} into ${e(home.weakestDefenceZone || '--')}</b><p>Use the away route for differentials where the zone and player role line up.</p></div></div>
            <div class="tactics-defcon-compare"><div class="tactics-compare-label"><span>${e(home.teamName)} <b>${home.defcon}</b></span><span>DEFCON</span><span><b>${away.defcon}</b> ${e(away.teamName)}</span></div><div class="tactics-compare-bar"><i style="width:${homeBar}%"></i><i style="width:${awayBar}%"></i></div><small>${home.defcon >= away.defcon ? e(home.teamName) : e(away.teamName)} has the cleaner defensive profile for this fixture.</small></div>
            <div class="tactics-verdict"><span class="tactics-kicker">FPL VERDICT</span><b>${e(match.prediction === 'Even' ? 'No clear favourite' : `${match.prediction} is the stronger fantasy side`)}</b><p>Home FDR ${fixture.homeFDR} · Away FDR ${fixture.awayFDR}. Balance attacking upside against clean-sheet and minutes security.</p></div>`;
    },

    renderTacticsTargets(teamData, isHome) {
        const e = value => this.escapeHTML(value);
        const accent = isHome ? 'home' : 'away';
        const panel = document.getElementById(isHome ? 'home-picks-panel' : 'away-picks-panel');
        if (!panel) return;
        const groups = teamData.targetGroups || [];
        const keyMetric = (player, category) => ({
            goals: `${Number(player.xG || 0).toFixed(1)} xG`,
            assists: `${Number(player.xA || 0).toFixed(1)} xA`,
            cleanSheet: `${player.cleanSheets || 0} CS`,
            saves: `${player.saves || 0} saves`,
            defcon: `${player.defensiveContribution || 0} DEFCON`,
            value: `${player.minutesSecurity || 0}% min`
        }[category] || `${player.score || 0}`);
        panel.innerHTML = `<div class="tactics-target-heading"><div><span class="tactics-kicker">${isHome ? 'HOME TARGETS' : 'AWAY TARGETS'}</span><h2>${e(teamData.teamName)} picks</h2></div><span class="tactics-muted-label">${groups.length} signals</span></div>
            <div class="tactics-target-groups">${groups.map(group => `<section class="tactics-target-group"><div class="tactics-group-heading"><span class="material-symbols-outlined">${e(group.icon)}</span><b>${e(group.label)}</b></div>${group.picks.map(player => `<article class="tactics-target-player ${accent}"><div class="tactics-target-main">${this.tacticsPlayerCard(player, accent, true)}<strong>${player.score || 0}</strong></div><p>${e(player.reason)}</p><div class="tactics-target-metrics"><span class="is-primary">${e(keyMetric(player, group.key))}</span><span>F ${Number(player.form || 0).toFixed(1)}</span><span>£${(Number(player.cost || 0) / 10).toFixed(1)}m</span><span>${player.goals || 0}G ${player.assists || 0}A</span></div></article>`).join('')}</section>`).join('')}</div>`;
    },

    renderBestPicks(match) {
        const e = value => this.escapeHTML(value);
        const bestPicks = match.bestPicks || [];
        const panel = document.getElementById('home-picks-panel');
        if (!panel) return;
        if (!bestPicks.length) {
            panel.innerHTML = '<div class="tactics-inline-empty">No strong picks identified for this fixture.</div>';
            return;
        }
        const fdrColor = fdr => fdr <= 2 ? '#00ff85' : fdr <= 3 ? '#f9d243' : '#ff5c72';
        panel.innerHTML = `<div class="tactics-target-heading"><div><span class="tactics-kicker">BEST PICKS</span><h2>Top ${bestPicks.length} for this fixture</h2></div><span class="tactics-muted-label">${e(match.fixture.homeTeam)} vs ${e(match.fixture.awayTeam)}</span></div>
            <div class="tactics-target-groups">${bestPicks.map((player, i) => {
                const teamBadge = this.getTeamLogo(player.team);
                const posColor = { FWD: '#FF005A', MID: '#37DB59', DEF: '#6496ff', GKP: '#ffa600' }[player.position] || '#8ba396';
                return `<section class="tactics-target-group" style="grid-column:span 2;border-top:1px solid var(--md-sys-color-outline-variant);padding-top:12px;">
                    <article class="tactics-target-player" style="padding:8px 0;">
                        <div style="display:flex;align-items:center;gap:12px;">
                            <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:rgba(0,255,133,0.1);color:var(--md-sys-color-primary);font-family:var(--font-mono);font-weight:800;font-size:13px;">${i + 1}</span>
                            ${teamBadge ? `<img src="${teamBadge}" style="width:22px;height:22px;object-fit:contain;">` : ''}
                            <div style="flex:1;min-width:0;">
                                <div style="display:flex;align-items:center;gap:8px;">
                                    <b style="font-size:13px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e(player.name)}</b>
                                    <span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:${posColor}22;color:${posColor};">${e(player.position)}</span>
                                    <span style="font-family:var(--font-mono);font-size:11px;color:#8ba396;">${e(player.team)}</span>
                                </div>
                                <p style="margin:3px 0 0;color:var(--md-sys-color-on-surface-variant);font-size:11px;line-height:1.4;">${e(player.reason)}</p>
                                <div class="tactics-target-metrics" style="margin-top:4px;">
                                    <span class="is-primary" style="font-size:12px;">${player.score || 0} pts</span>
                                    <span style="font-size:11px;">F ${Number(player.form || 0).toFixed(1)}</span>
                                    <span style="font-size:11px;">£${(Number(player.cost || 0) / 10).toFixed(1)}m</span>
                                    <span style="font-size:11px;">${player.goals || 0}G ${player.assists || 0}A</span>
                                    <span style="font-size:11px;">${player.minutesSecurity || 0}% min</span>
                                </div>
                            </div>
                        </div>
                    </article>
                </section>`;
            }).join('')}</div>`;
        // Hide away panel when showing combined best picks
        const awayPanel = document.getElementById('away-picks-panel');
        if (awayPanel) awayPanel.style.display = 'none';
    },

    changeGW(delta) {
        const newGW = (this.state.selectedGW || this.state.currentGW) + delta;
        if (newGW >= 1 && newGW <= 38) {
            this.state.selectedGW = newGW;
            this.invalidateTabCache(); // Invalidate all tab caches on GW change
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
            <th style="padding:var(--space-sm) var(--space-md);text-align:center;">Transfers In</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:center;">Price</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:center;">Points</th>
        </tr></thead><tbody>${players.map((p, i) => {
            const team = bootstrap.teams.find(t => t.id === p.team);
            return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <td style="padding:var(--space-sm) var(--space-md);">${i + 1}</td>
                <td style="padding:var(--space-sm) var(--space-md);font-weight:600;">${p.web_name}</td>
                <td style="padding:var(--space-sm) var(--space-md);display:flex;align-items:center;gap:4px;">${this.teamBadge(team?.short_name, 16)} ${team?.short_name || '???'}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;"><span style="padding:2px 8px;border-radius:var(--radius-pill);font-size:0.6875rem;font-weight:700;background:${posColors[p.element_type]}20;color:${posColors[p.element_type]};">${posNames[p.element_type]}</span></td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-primary);">+${this.formatNumber(p.transfers_in_event || 0)}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">£${(p.now_cost / 10).toFixed(1)}m</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">${p.total_points}</td>
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
            <th style="padding:var(--space-sm) var(--space-md);text-align:center;">Transfers Out</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:center;">Price</th>
            <th style="padding:var(--space-sm) var(--space-md);text-align:center;">Points</th>
        </tr></thead><tbody>${players.map((p, i) => {
            const team = bootstrap.teams.find(t => t.id === p.team);
            return `<tr style="border-bottom:1px solid var(--md-sys-color-outline-variant);">
                <td style="padding:var(--space-sm) var(--space-md);">${i + 1}</td>
                <td style="padding:var(--space-sm) var(--space-md);font-weight:600;">${p.web_name}</td>
                <td style="padding:var(--space-sm) var(--space-md);display:flex;align-items:center;gap:4px;">${this.teamBadge(team?.short_name, 16)} ${team?.short_name || '???'}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;"><span style="padding:2px 8px;border-radius:var(--radius-pill);font-size:0.6875rem;font-weight:700;background:${posColors[p.element_type]}20;color:${posColors[p.element_type]};">${posNames[p.element_type]}</span></td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);font-weight:700;color:var(--md-sys-color-error);">-${this.formatNumber(p.transfers_out_event || 0)}</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">£${(p.now_cost / 10).toFixed(1)}m</td>
                <td style="padding:var(--space-sm) var(--space-md);text-align:center;font-family:var(--font-mono);">${p.total_points}</td>
            </tr>`;
        }).join('')}</tbody></table></div></div>`;
    },

    toggleLeagueView(view) {
        document.querySelectorAll('#content-league .tabs .tab').forEach(t => t.classList.remove('active'));
        event.target.classList.add('active');
    },

    filterPlayers(pos, el) {
        document.querySelectorAll('#content-players [onclick^="FPL.filterPlayers"]').forEach(t => {
            const active = t === el;
            t.classList.toggle('active', active);
            t.style.background = active ? 'rgba(0,255,133,0.16)' : 'transparent';
            t.style.color = active ? '#00FF85' : '#B0B0B0';
        });
        this.state.playerFilter = pos;
        this.renderPlayers();
    },

    sortPlayers(field) {
        this.renderPlayers();
    },

    renderDecisionCentre() {
        const empty = document.getElementById('decision-empty');
        const results = document.getElementById('decision-results');
        if (!empty || !results) return;
        const gwInput = document.getElementById('decision-gw');
        if (gwInput && !gwInput.dataset.ready) {
            gwInput.value = this.state.bootstrapData?.events?.find(event => event.is_next)?.id || this.state.currentGW || 1;
            gwInput.dataset.ready = 'true';
        }
        if (!this.state.managerId) {
            empty.classList.remove('hidden');
            results.classList.add('hidden');
            return;
        }
        empty.classList.add('hidden');
        if (this.state.decisionData) {
            results.classList.remove('hidden');
            this.paintDecisionCentre();
        } else {
            this.loadDecisionCentre();
        }
    },

    async loadDecisionCentre() {
        if (!this.state.managerId) return this.showDialog('connect-dialog');
        const loading = document.getElementById('decision-loading');
        const empty = document.getElementById('decision-empty');
        const results = document.getElementById('decision-results');
        loading?.classList.remove('hidden');
        empty?.classList.add('hidden');
        results?.classList.add('hidden');
        try {
            const rivals = (document.getElementById('decision-rival-ids')?.value || '').split(',').map(value => value.trim()).filter(value => /^\d+$/.test(value));
            const bankValue = document.getElementById('decision-bank')?.value;
            const payload = {
                managerId: this.state.managerId,
                targetGW: Number(document.getElementById('decision-gw')?.value) || this.state.currentGW,
                horizon: Number(document.getElementById('decision-horizon')?.value) || 5,
                strategy: document.getElementById('decision-strategy')?.value || 'balanced',
                freeTransfers: Number(document.getElementById('decision-ft')?.value) || 1,
                rivalIds: rivals,
            };
            if (bankValue !== '') payload.bank = Number(bankValue);
            this.state.decisionData = await this.apiPost(this.API.decisionCentre, payload);
            results?.classList.remove('hidden');
            this.paintDecisionCentre();
        } catch (error) {
            empty?.classList.remove('hidden');
            empty.innerHTML = `<span class="material-symbols-outlined">error</span><div><b>Decision model unavailable</b><p>${this.escapeHTML(error.message || 'Try again shortly.')}</p></div>`;
        } finally {
            loading?.classList.add('hidden');
        }
    },

    setDecisionView(view) {
        this.state.decisionView = view;
        document.querySelectorAll('.decision-subnav button').forEach(button => {
            const active = button.dataset.decisionView === view;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        });

        document.querySelectorAll('.decision-view').forEach(section => {
            const active = section.dataset.view === view;
            section.classList.toggle('active', active);
            section.hidden = !active;
        });
    },

    decisionPlayerRow(player, badge = '') {
        return `<div class="decision-player-row"><span class="decision-player-pos">${player.position}</span><div><b>${this.escapeHTML(player.name)}</b><small>${player.team} · £${player.cost.toFixed(1)}m ${badge}</small></div><div class="decision-player-numbers"><strong>${player.weekly[0]?.xPts.toFixed(1) || '0.0'}</strong><small>xPts</small></div></div>`;
    },

    paintDecisionCentre() {
        const data = this.state.decisionData;
        if (!data) return;
        const formatRank = rank => rank ? this.formatNumber(rank) : '--';
        const summary = document.getElementById('decision-summary');
        if (summary) summary.innerHTML = `<div class="decision-stats"><div><span>PROJECTED GW</span><strong>${data.lineup.expectedPoints.toFixed(1)}</strong><small>GW${data.meta.targetGW}</small></div><div><span>BEST MOVE</span><strong>+${(data.transfers.plans[0]?.netGain || 0).toFixed(1)}</strong><small>net xPts</small></div><div><span>RANK</span><strong>${formatRank(data.manager.rank)}</strong><small>${this.escapeHTML(data.meta.strategy)} mode</small></div><div><span>SQUAD VALUE</span><strong>£${data.manager.squadValue.toFixed(1)}</strong><small>£${data.manager.bank.toFixed(1)}m bank</small></div></div>`;
        const stamp = document.getElementById('decision-model-stamp');
        if (stamp) stamp.textContent = data.meta.modelVersion;
        const actions = document.getElementById('decision-actions');
        if (actions) actions.innerHTML = data.decisions.map((decision, index) => `<article class="decision-action"><span>${index + 1}</span><div><small>${decision.type.toUpperCase()} · ${decision.priority}</small><h3>${this.escapeHTML(decision.title)}</h3><p>${this.escapeHTML(decision.reason)}</p></div><strong>${decision.expectedGain > 0 ? '+' : ''}${decision.expectedGain.toFixed(1)}</strong></article>`).join('');
        const alerts = document.getElementById('decision-alerts');
        if (alerts) alerts.innerHTML = data.alerts.length ? data.alerts.map(alert => `<div class="decision-alert ${alert.severity}"><span class="material-symbols-outlined">${alert.severity === 'critical' ? 'error' : alert.severity === 'opportunity' ? 'trending_up' : 'warning'}</span><p>${this.escapeHTML(alert.message)}</p></div>`).join('') : '<div class="decision-quiet">No material squad risks detected.</div>';
        const alertCount = document.getElementById('decision-alert-count');
        if (alertCount) alertCount.textContent = `${data.alerts.length} signals`;
        const live = document.getElementById('decision-live');
        if (live) live.innerHTML = data.live?.status === 'live' ? `<div class="decision-panel decision-live-panel"><div class="decision-panel-head"><h2>Live rank pulse</h2><span>${data.live.estimatedRankDirection === 'up' ? 'RANK GAIN' : 'RANK LOSS'} · ${data.live.safetyDelta >= 0 ? '+' : ''}${data.live.safetyDelta.toFixed(1)} vs published</span></div><div class="decision-live-stats"><div><strong>${data.live.livePoints}</strong><small>live points</small></div><div><strong>${this.formatNumber(data.live.estimatedOverallPoints)}</strong><small>estimated total</small></div><div><strong>${data.live.captainDamage.toFixed(1)}</strong><small>captain damage</small></div></div><div class="decision-rival-lists"><div><b>Rank gainers</b>${data.live.gainers.map(player => `<span>${this.escapeHTML(player.name)} +${player.rankImpact.toFixed(1)}</span>`).join('') || '<span>None yet</span>'}</div><div><b>Rank threats</b>${data.live.threats.map(player => `<span>${this.escapeHTML(player.name)} ${player.rankImpact.toFixed(1)}</span>`).join('') || '<span>None yet</span>'}</div></div></div>` : `<div class="decision-quiet decision-live-wait">${this.escapeHTML(data.live?.message || 'Live analytics activate when matches begin.')}</div>`;

        const transferPlans = document.getElementById('decision-transfer-plans');
        if (transferPlans) transferPlans.innerHTML = data.transfers.plans.length ? `<div class="decision-transfer-grid">${data.transfers.plans.slice(0, 10).map((plan, index) => `<article class="decision-transfer-card"><div class="decision-plan-rank">${index + 1}</div><div class="decision-transfer-moves">${plan.transfers.map(move => `<div><span class="sell">${this.escapeHTML(move.out.name)}</span><span class="material-symbols-outlined">arrow_forward</span><span class="buy">${this.escapeHTML(move.in.name)}</span></div>`).join('')}</div><div class="decision-plan-metrics"><span><b>+${plan.netGain.toFixed(1)}</b> net xPts</span><span>${plan.breakEvenProbability}% break-even</span><span>£${plan.bankAfter.toFixed(1)}m bank</span><span>${plan.risk} risk</span></div><p>${this.escapeHTML(plan.rationale)}</p></article>`).join('')}</div>` : '<div class="decision-quiet">Rolling the transfer is the strongest modeled option.</div>';
        const optimalMeta = document.getElementById('decision-optimal-meta');
        if (optimalMeta) optimalMeta.textContent = `${data.transfers.optimalSquad.valid ? 'Legal squad' : 'Incomplete'} · £${data.transfers.optimalSquad.cost.toFixed(1)}m`;
        const optimalSquad = document.getElementById('decision-optimal-squad');
        if (optimalSquad) optimalSquad.innerHTML = `<div class="decision-player-grid">${data.transfers.optimalSquad.players.map(player => this.decisionPlayerRow(player)).join('')}</div>`;

        const lineupTotal = document.getElementById('decision-lineup-total');
        if (lineupTotal) lineupTotal.textContent = `${data.lineup.expectedPoints.toFixed(1)} xPts`;
        const lineup = document.getElementById('decision-lineup');
        if (lineup) lineup.innerHTML = `<div class="decision-pitch"><div class="decision-pitch-label">STARTING XI</div>${['GKP', 'DEF', 'MID', 'FWD'].map(position => `<div class="decision-pitch-line">${data.lineup.starters.filter(player => player.position === position).map(player => `<div class="decision-pitch-player"><span>${player === data.lineup.captain ? 'C' : player === data.lineup.viceCaptain ? 'V' : player.position}</span><b>${this.escapeHTML(player.name)}</b><small>${player.weekly[0].xPts.toFixed(1)} xPts</small></div>`).join('')}</div>`).join('')}</div><div class="decision-bench"><h3>Bench order</h3>${data.lineup.bench.map((player, index) => this.decisionPlayerRow(player, `· ${index + 1}`)).join('')}</div>`;

        const pool = data.comparisonPool || [];
        const selectA = document.getElementById('decision-compare-a');
        const selectB = document.getElementById('decision-compare-b');
        const options = pool.map(player => `<option value="${player.id}">${this.escapeHTML(player.name)} · ${player.team}</option>`).join('');
        if (selectA && !selectA.options.length) selectA.innerHTML = options;
        if (selectB && !selectB.options.length) { selectB.innerHTML = options; selectB.selectedIndex = Math.min(1, selectB.options.length - 1); }
        this.renderDecisionComparison();

        const rivals = document.getElementById('decision-rivals');
        if (rivals) rivals.innerHTML = data.rivals.length ? data.rivals.map(rival => `<article class="decision-rival"><div class="decision-rival-head"><div><small>${this.escapeHTML(rival.teamName)}</small><h3>${this.escapeHTML(rival.name)}</h3></div><div><strong>${rival.projectedSwing >= 0 ? '+' : ''}${rival.projectedSwing.toFixed(1)}</strong><small>projected swing</small></div></div><div class="decision-rival-stats"><span>${rival.overlap}% overlap</span><span>${rival.projectedPoints.toFixed(1)} xPts</span><span>OR ${formatRank(rival.rank)}</span></div><div class="decision-rival-lists"><div><b>Their threats</b>${rival.threats.map(player => `<span>${this.escapeHTML(player.name)} ${player.weekly[0].xPts.toFixed(1)}</span>`).join('') || '<span>None</span>'}</div><div><b>Your edges</b>${rival.differentials.map(player => `<span>${this.escapeHTML(player.name)} ${player.weekly[0].xPts.toFixed(1)}</span>`).join('') || '<span>None</span>'}</div></div></article>`).join('') : '<div class="decision-quiet">Enter rival manager IDs above to compare squads and projected swings.</div>';

        const chips = document.getElementById('decision-chips');
        if (chips) chips.innerHTML = `<div class="decision-chip-recs">${data.chips.recommendations.map(chip => `<article><span>${chip.confidence}</span><h3>${chip.chip}</h3><strong>GW${chip.gameweek}</strong><p>${this.escapeHTML(chip.reason)} Modeled value: ${chip.expectedGain.toFixed(1)}.</p></article>`).join('')}</div><div class="table-scroll-mobile"><table class="decision-table"><thead><tr><th>GW</th><th>Bench Boost</th><th>Triple Captain</th><th>Free Hit need</th><th>Wildcard need</th><th>Top captain</th></tr></thead><tbody>${data.chips.weeks.map(week => `<tr><td>GW${week.gameweek}</td><td>${week.benchBoostGain.toFixed(1)}</td><td>${week.tripleCaptainGain.toFixed(1)}</td><td>${week.freeHitNeed.toFixed(1)}</td><td>${week.wildcardNeed.toFixed(1)}</td><td>${this.escapeHTML(week.topCaptain)}</td></tr>`).join('')}</tbody></table></div>`;
        const backtest = document.getElementById('decision-backtest');
        if (backtest) backtest.innerHTML = `<div class="decision-model-score"><strong>${data.backtest.mae != null ? data.backtest.mae.toFixed(1) : '--'}</strong><span>${data.backtest.mae != null ? 'baseline MAE' : 'collecting'}</span></div><p>${this.escapeHTML(data.backtest.message)}</p><small>${data.backtest.sample} completed comparisons · ${data.meta.modelVersion}</small>`;
        const warnings = document.getElementById('decision-warnings');
        if (warnings) warnings.innerHTML = data.meta.warnings.map(warning => `<div class="decision-assumption"><span class="material-symbols-outlined">info</span><p>${this.escapeHTML(warning)}</p></div>`).join('');
        this.setDecisionView(this.state.decisionView || 'overview');
    },

    renderDecisionComparison() {
        const data = this.state.decisionData;
        const container = document.getElementById('decision-comparison');
        if (!data || !container) return;
        const first = data.comparisonPool.find(player => player.id === Number(document.getElementById('decision-compare-a')?.value)) || data.comparisonPool[0];
        const second = data.comparisonPool.find(player => player.id === Number(document.getElementById('decision-compare-b')?.value)) || data.comparisonPool[1];
        if (!first || !second) return;
        const card = player => `<article class="decision-compare-card"><div class="decision-compare-name"><span>${player.position}</span><div><h3>${this.escapeHTML(player.name)}</h3><small>${player.team} · £${player.cost.toFixed(1)}m</small></div></div><div class="decision-range"><span style="left:${Math.min(88, player.range.low * 2)}%;width:${Math.max(6, (player.range.high - player.range.low) * 2)}%"></span><i style="left:${Math.min(96, player.range.expected * 2)}%"></i></div><div class="decision-compare-metrics"><span><b>${player.totalXpts.toFixed(1)}</b> xPts</span><span><b>${player.range.low.toFixed(1)}-${player.range.high.toFixed(1)}</b> range</span><span><b>${player.weekly[0].xMins}</b> xMins</span><span><b>${player.xGI90.toFixed(2)}</b> xGI/90</span><span><b>${player.returnProbability}%</b> return</span><span><b>${player.haulProbability}%</b> haul</span><span><b>${player.ownership.toFixed(1)}%</b> owned</span><span><b>${player.xPtsPerMillion.toFixed(2)}</b> xPts/£m</span></div></article>`;
        const winner = first.totalXpts >= second.totalXpts ? first : second;
        container.innerHTML = `<div class="decision-compare-grid">${card(first)}${card(second)}</div><div class="decision-verdict"><span class="material-symbols-outlined">analytics</span><p><b>${this.escapeHTML(winner.name)}</b> leads the ${data.meta.gameweeks.length}-gameweek projection by ${Math.abs(first.totalXpts - second.totalXpts).toFixed(1)} xPts. Use the range and xMins to judge whether that edge fits your risk mode.</p></div>`;
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
            case 'decision': this.renderDecisionCentre(); break;
            case 'setpieces': this.renderSetPieces(); break;
        }
    },

    _managerSearchTimers: {},
    _selectedLeagueId: {},

    searchManager(inputId, resultsId) {
        const input = document.getElementById(inputId);
        const resultsEl = document.getElementById(resultsId);
        if (!input || !resultsEl) return;
        const val = input.value.trim();
        clearTimeout(this._managerSearchTimers[inputId]);

        // Numeric ID lookup via FPL API
        if (/^\d{3,}$/.test(val)) {
            resultsEl.innerHTML = '<div style="padding:8px 12px;color:var(--md-sys-color-on-surface-variant);font-size:12px;">Searching...</div>';
            resultsEl.style.display = 'block';
            this._managerSearchTimers[inputId] = setTimeout(async () => {
                try {
                    const data = await this.apiFetch(this.API.managerLookup(val));
                    const name = data.name || 'Unknown Team';
                    const owner = [data.playerFirstName, data.playerLastName].filter(Boolean).join(' ');
                    const nameEsc = this.escapeHTML(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                    const ownerEsc = this.escapeHTML(owner).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                    resultsEl.innerHTML = `<div class="fpl-mgr-result" data-manager-id="${data.id}" style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;" onclick="event.stopPropagation();FPL.selectManagerAndLoadLeagues('${inputId}','${resultsId}',${data.id},'${nameEsc}','${ownerEsc}')"><span class="material-symbols-outlined" style="font-size:16px;color:#00FF85;">check_circle</span><div><div style="font-size:13px;font-weight:600;color:var(--md-sys-color-on-surface);">${this.escapeHTML(name)}</div><div style="font-size:11px;color:var(--md-sys-color-on-surface-variant);">${this.escapeHTML(owner)} · ID: ${data.id}</div></div></div>`;
                    resultsEl.style.display = 'block';
                } catch {
                    resultsEl.innerHTML = '<div style="padding:8px 12px;color:var(--md-sys-color-error,#f44336);font-size:12px;">Manager not found</div>';
                    resultsEl.style.display = 'block';
                }
            }, 300);
            return;
        }

        // Name search in connected_managers table
        if (val.length >= 2) {
            resultsEl.innerHTML = '<div style="padding:8px 12px;color:var(--md-sys-color-on-surface-variant);font-size:12px;">Searching connected managers...</div>';
            resultsEl.style.display = 'block';
            this._managerSearchTimers[inputId] = setTimeout(async () => {
                try {
                    const res = await window.fetch(`/api/search-managers?q=${encodeURIComponent(val)}`);
                    const data = await res.json();
                    const managers = data.managers || [];
                    if (managers.length === 0) {
                        resultsEl.innerHTML = '<div style="padding:8px 12px;color:var(--md-sys-color-on-surface-variant);font-size:12px;">No managers found. Try entering their numeric ID.</div>';
                    } else {
                        resultsEl.innerHTML = managers.map(m => {
                            const name = m.team_name || 'Unknown Team';
                            const owner = [m.player_first_name, m.player_last_name].filter(Boolean).join(' ');
                            const nameEsc = this.escapeHTML(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                            const ownerEsc = this.escapeHTML(owner).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                            return `<div class="fpl-mgr-result" data-manager-id="${m.manager_id}" style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;" onclick="event.stopPropagation();FPL.selectManagerAndLoadLeagues('${inputId}','${resultsId}',${m.manager_id},'${nameEsc}','${ownerEsc}')"><span class="material-symbols-outlined" style="font-size:16px;color:#00FF85;">check_circle</span><div><div style="font-size:13px;font-weight:600;color:var(--md-sys-color-on-surface);">${this.escapeHTML(name)}</div><div style="font-size:11px;color:var(--md-sys-color-on-surface-variant);">${this.escapeHTML(owner)} · ID: ${m.manager_id}</div></div></div>`;
                        }).join('');
                    }
                    resultsEl.style.display = 'block';
                } catch {
                    resultsEl.innerHTML = '<div style="padding:8px 12px;color:var(--md-sys-color-on-surface-variant);font-size:12px;">Search unavailable. Try entering the numeric ID.</div>';
                    resultsEl.style.display = 'block';
                }
            }, 300);
            return;
        }

        resultsEl.innerHTML = '';
        resultsEl.style.display = 'none';
        this._selectedLeagueId[inputId] = null;
    },

    async selectManagerAndLoadLeagues(inputId, resultsId, id, name, owner) {
        const input = document.getElementById(inputId);
        const resultsEl = document.getElementById(resultsId);
        if (input) input.value = id;
        if (!resultsEl) return;
        this._selectedLeagueId[inputId] = null;
        resultsEl.innerHTML = `<div style="padding:8px 12px;display:flex;align-items:center;gap:8px;"><span class="material-symbols-outlined" style="font-size:16px;color:#00FF85;">check_circle</span><div><div style="font-size:13px;font-weight:600;color:var(--md-sys-color-on-surface);">${name}</div><div style="font-size:11px;color:var(--md-sys-color-on-surface-variant);">${owner} · ID: ${id}</div></div></div><div style="padding:4px 12px 8px;color:var(--md-sys-color-on-surface-variant);font-size:11px;">Loading leagues...</div>`;
        try {
            const leagueData = await this.apiFetch(this.API.managerLeagues(id));
            const leagues = leagueData.leagues || [];
            const privateLeagues = leagues.filter(l => l.type === 'private');
            const systemLeagues = leagues.filter(l => l.type === 'system');
            let html = `<div style="padding:8px 12px;display:flex;align-items:center;gap:8px;"><span class="material-symbols-outlined" style="font-size:16px;color:#00FF85;">check_circle</span><div><div style="font-size:13px;font-weight:600;color:var(--md-sys-color-on-surface);">${name}</div><div style="font-size:11px;color:var(--md-sys-color-on-surface-variant);">${owner} · ID: ${id}</div></div></div>`;
            if (privateLeagues.length > 0) {
                html += '<div style="padding:6px 12px 4px;font-size:10px;font-weight:600;color:var(--md-sys-color-primary,#00FF85);text-transform:uppercase;letter-spacing:0.08em;">Your Leagues</div>';
                privateLeagues.forEach(l => {
                    const rankText = l.rank ? `#${l.rank}` : l.percentileRank ? `Top ${l.percentileRank}%` : '';
                    html += `<div class="fpl-league-item" data-league-id="${l.id}" data-input-id="${inputId}" data-results-id="${resultsId}" style="padding:6px 12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--md-sys-color-on-surface);border-radius:4px;margin:0 4px;border:1px solid transparent;" onmouseover="this.style.background='rgba(0,255,133,0.1)'" onmouseout="if(!this.classList.contains('fpl-league-selected')){this.style.background='';this.style.border='1px solid transparent'}"><span style="display:flex;align-items:center;gap:6px;"><span class="material-symbols-outlined" style="font-size:14px;color:var(--md-sys-color-on-surface-variant);">shield</span>${this.escapeHTML(l.name)}${l.admin ? '<span style="font-size:9px;padding:1px 4px;background:rgba(0,255,133,0.15);color:#00FF85;border-radius:4px;">Admin</span>' : ''}</span><span style="font-size:11px;color:var(--md-sys-color-on-surface-variant);font-family:var(--font-mono);">${rankText}</span></div>`;
                });
            }
            if (systemLeagues.length > 0) {
                html += '<div style="padding:6px 12px 4px;font-size:10px;font-weight:600;color:var(--md-sys-color-on-surface-variant);text-transform:uppercase;letter-spacing:0.08em;">System Leagues</div>';
                systemLeagues.slice(0, 3).forEach(l => {
                    html += `<div class="fpl-league-item" data-league-id="${l.id}" data-input-id="${inputId}" data-results-id="${resultsId}" style="padding:6px 12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--md-sys-color-on-surface);border-radius:4px;margin:0 4px;border:1px solid transparent;" onmouseover="this.style.background='rgba(0,255,133,0.1)'" onmouseout="if(!this.classList.contains('fpl-league-selected')){this.style.background='';this.style.border='1px solid transparent'}"><span style="display:flex;align-items:center;gap:6px;"><span class="material-symbols-outlined" style="font-size:14px;color:var(--md-sys-color-on-surface-variant);">public</span>${this.escapeHTML(l.name)}</span><span style="font-size:11px;color:var(--md-sys-color-on-surface-variant);font-family:var(--font-mono);">${l.rank ? '#' + l.rank : ''}</span></div>`;
                });
            }
            html += '<div style="padding:6px 12px 4px;font-size:10px;font-weight:600;color:var(--md-sys-color-on-surface-variant);text-transform:uppercase;letter-spacing:0.08em;">Or enter custom league</div>';
            html += `<div style="padding:6px 12px 8px;display:flex;gap:6px;margin:0 4px;"><input type="number" id="${inputId}-custom-league" placeholder="League ID" min="1" inputmode="numeric" style="flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:6px 8px;color:var(--md-sys-color-on-surface);font-size:12px;font-family:var(--font-mono);outline:none;" onfocus="this.style.borderColor='rgba(0,255,133,0.5)'" onblur="this.style.borderColor='rgba(255,255,255,0.1)'" oninput="FPL.onCustomLeagueInput('${inputId}')"><button type="button" onclick="FPL.selectCustomLeague('${inputId}','${resultsId}')" style="background:rgba(0,255,133,0.15);border:1px solid rgba(0,255,133,0.3);color:#00FF85;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:600;cursor:pointer;">Set</button></div>`;
            resultsEl.innerHTML = html;
            resultsEl.querySelectorAll('.fpl-league-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const lid = Number(item.dataset.leagueId);
                    const lidInputId = item.dataset.inputId;
                    const lidResultsId = item.dataset.resultsId;
                    this.selectLeague(lidInputId, lidResultsId, lid);
                });
            });
        } catch {
            resultsEl.innerHTML = `<div style="padding:8px 12px;display:flex;align-items:center;gap:8px;"><span class="material-symbols-outlined" style="font-size:16px;color:#00FF85;">check_circle</span><div><div style="font-size:13px;font-weight:600;color:var(--md-sys-color-on-surface);">${name}</div><div style="font-size:11px;color:var(--md-sys-color-on-surface-variant);">${owner} · ID: ${id}</div></div></div><div style="padding:4px 12px 8px;font-size:11px;color:var(--md-sys-color-on-surface-variant);">Could not load leagues. You can still connect.</div>`;
        }
    },

    selectLeague(inputId, resultsId, leagueId) {
        this._selectedLeagueId[inputId] = leagueId;
        const resultsEl = document.getElementById(resultsId);
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
        }
        if (inputId === 'league-id-input') {
            const input = document.getElementById(inputId);
            if (input) input.value = '';
            this.switchLeague(leagueId);
        } else if (inputId === 'connect-manager-id') {
            this.hideDialog('connect-dialog');
            this.connectManager();
        } else {
            this.connectManagerFromInput();
        }
    },

    onCustomLeagueInput(inputId) {
        const customInput = document.getElementById(inputId + '-custom-league');
        if (!customInput) return;
        const val = customInput.value.trim();
        if (/^\d+$/.test(val) && Number(val) > 0) {
            this._selectedLeagueId[inputId] = Number(val);
        } else {
            this._selectedLeagueId[inputId] = null;
        }
        const resultsEl = document.getElementById(inputId === 'connect-manager-id' ? 'connect-manager-results' : 'manager-id-results');
        if (resultsEl) {
            resultsEl.querySelectorAll('.fpl-league-item').forEach(item => {
                item.classList.remove('fpl-league-selected');
                item.style.background = '';
                item.style.border = '1px solid transparent';
            });
        }
    },

    selectCustomLeague(inputId, resultsId) {
        const customInput = document.getElementById(inputId + '-custom-league');
        if (!customInput) return;
        const val = customInput.value.trim();
        if (!/^\d+$/.test(val) || Number(val) < 1) return;
        this._selectedLeagueId[inputId] = Number(val);
        const resultsEl = document.getElementById(resultsId);
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
        }
        if (inputId === 'league-id-input') {
            const input = document.getElementById(inputId);
            if (input) input.value = '';
            this.switchLeague(Number(val));
        } else if (inputId === 'connect-manager-id') {
            this.hideDialog('connect-dialog');
            this.connectManager();
        } else {
            this.connectManagerFromInput();
        }
    },

    selectManagerResult(inputId, resultsId, id, name) {
        const input = document.getElementById(inputId);
        const resultsEl = document.getElementById(resultsId);
        if (input) input.value = id;
        if (resultsEl) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; }
    },

    getSelectedLeagueId(inputId) {
        if (this._selectedLeagueId[inputId]) return this._selectedLeagueId[inputId];
        const customInput = document.getElementById(inputId + '-custom-league');
        if (customInput) {
            const val = customInput.value.trim();
            if (/^\d+$/.test(val) && Number(val) > 0) return Number(val);
        }
        if (inputId === 'connect-manager-id') {
            const leagueInput = document.getElementById('connect-league-id');
            if (leagueInput) {
                const val = leagueInput.value.trim();
                if (/^\d+$/.test(val) && Number(val) > 0) return Number(val);
            }
        }
        return null;
    },

    connectManagerFromInput() {
        const input = document.getElementById('manager-id-input-field');
        const id = input?.value?.trim();
        if (!/^\d+$/.test(id || '') || Number(id) < 1) {
            this.showError('Enter a valid Manager ID');
            input?.focus();
            return;
        }
        const leagueId = this.getSelectedLeagueId('manager-id-input-field');
        this.state.managerId = id;
        localStorage.setItem('fplManagerId', id);
        if (leagueId) {
            this.state.leagueId = String(leagueId);
            localStorage.setItem('fplLeagueId', String(leagueId));
        }
        this.loadManagerData(id).then(() => {
            this.refreshConnectionUI();
            this.renderTeamAnalysis();
        });
    },

    connectManager() {
        const input = document.getElementById('connect-manager-id');
        const id = input?.value?.trim();
        if (!/^\d+$/.test(id || '') || Number(id) < 1) {
            this.showError('Enter a valid Manager ID');
            input?.focus();
            return;
        }
        const leagueId = this.getSelectedLeagueId('connect-manager-id');
        this.state.managerId = id;
        localStorage.setItem('fplManagerId', id);
        if (leagueId) {
            this.state.leagueId = String(leagueId);
            localStorage.setItem('fplLeagueId', String(leagueId));
        }
        this.hideDialog('connect-dialog');
        this.loadManagerData(id).then(() => {
            this.refreshConnectionUI();
            this.render();
        });
    },

    openPlayersByPosition(pos) {
        this.state.playerFilter = pos;
        this.navigateTo('players');
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
        this.loadManagerData(id).then(() => {
            this.refreshConnectionUI();
            this.render();
        });
    },

    clearData() {
        this.confirmDialog({
            title: 'Clear all data?',
            message: 'Your saved manager ID, league ID and local preferences will be permanently removed and the page will reload.',
            confirmLabel: 'Clear everything',
            danger: true
        }).then(confirmed => {
            if (!confirmed) return;
            localStorage.removeItem('fplManagerId');
            localStorage.removeItem('fplLeagueId');
            this.state.managerId = null;
            this.state.managerData = null;
            this.state.leagueData = null;
            location.reload();
        });
    },

    initHistory() {
        const container = document.getElementById('history-section');
        if (!container) return;
        if (!this.state.managerData) {
            container.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><span class="material-symbols-outlined">history</span><p>Connect an FPL ID to see your gameweek history.</p><button class="btn btn-primary" onclick="FPL.hideDialog(\'history-dialog\');FPL.showDialog(\'connect-dialog\')">Connect ID</button></div></div></div>';
            this.showDialog('history-dialog');
            return;
        }
        const m = this.state.managerData;
        const weeklyPts = m.weeklyPoints || [];
        const weeklyRanks = m.weeklyRanks || [];
        const benchPts = m.weeklyPointsLostBench || [];
        const chips = m.managerInfo?.chipsUsed || [];
        const seasonHistory = m.seasonHistory || [];
        const info = m.managerInfo || {};

        if (weeklyPts.length === 0) {
            container.innerHTML = '<div class="card"><div class="card-body"><div class="empty-state"><span class="material-symbols-outlined">history</span><p>No gameweek history available yet.</p></div></div></div>';
            this.showDialog('history-dialog');
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
                                                <div style="height:100%;width:${barWidth}%;background:${ptsColor};border-radius:2px;"></div>
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
        this.showDialog('history-dialog');
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
                        <div class="settings-save-row" style="display:flex;gap:8px;">
                            <input type="number" class="input" id="settings-manager-id" placeholder="e.g. 123456" value="${this.state.managerId || ''}" style="flex:1;">
                            <button class="btn btn-primary" onclick="FPL.updateManagerId()">Save</button>
                        </div>
                        <small style="color:var(--md-sys-color-on-surface-variant);">Find your ID in the URL on the FPL website.</small>
                    </div>
                    <div class="input-group">
                        <label class="input-label">League ID (optional)</label>
                        <div class="settings-save-row" style="display:flex;gap:8px;">
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
        this.showDialog('settings-dialog');
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
    },

    // ==================== RENDER: SET PIECE TAKERS ====================
    async renderSetPieces() {
        const container = document.getElementById('setpieces-table-container');
        const tbody = document.getElementById('setpieces-tbody');
        if (!tbody) return;

        try {
            let data = this.getCachedTabData('setpieces');
            if (!data) {
                data = await this.apiFetch('/api/set-pieces');
                this.setCachedTabData('setpieces', data);
            }
            if (!data || !data.setPieces) return;
            const sp = data.setPieces;

            const teamEntries = Object.entries(sp).sort((a, b) => a[1].teamFull.localeCompare(b[1].teamFull));

            const posColors = { FWD: '#FF005A', MID: '#37DB59', DEF: '#6496ff', GKP: '#ffa600' };

            const renderPlayer = (p, idx, total) => {
                if (!p.found) {
                    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;color:#5a7a66;font-size:12px;">' + p.name + ' (not in FPL)</div>';
                }
                const isPrimary = idx === 0;
                const bg = isPrimary ? 'rgba(0,255,133,0.06)' : 'transparent';
                const borderL = isPrimary ? 'border-left:2px solid #00ff85;' : 'border-left:2px solid transparent;';
                const posColor = posColors[p.position] || '#8ba396';

                return '<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:' + bg + ';' + borderL + 'border-radius:6px;margin-bottom:2px;">'
                    + '<div class="player-photo-shell" style="width:34px;height:34px;border-radius:50%;border:1px solid #1A2E28;">'
                    + this.playerPhotoMarkup(p, p.name, '', 'width:100%;height:100%;object-fit:cover;object-position:50% 15%;')
                    + '</div>'
                    + '<div style="flex:1;min-width:0;">'
                    + '<div style="font-size:14px;font-weight:' + (isPrimary ? '700' : '500') + ';color:' + (isPrimary ? '#fff' : '#ccc') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + p.name + '</div>'
                    + '<div style="display:flex;align-items:center;gap:6px;margin-top:2px;">'
                    + '<span style="font-size:11px;font-weight:700;padding:1px 5px;border-radius:3px;background:' + posColor + '22;color:' + posColor + ';">' + p.position + '</span>'
                    + '<span style="font-size:12px;color:#00ff85;font-family:var(--font-mono);font-weight:600;">' + p.costStr + '</span>'
                    + '</div>'
                    + '</div>'
                    + '<div style="text-align:right;font-family:var(--font-mono);font-size:12px;white-space:nowrap;">'
                    + '<div style="color:#fff;font-weight:600;">' + p.goals + '<span style="color:#5a7a66;">G</span> ' + p.assists + '<span style="color:#5a7a66;">A</span></div>'
                    + '<div style="color:#5a7a66;margin-top:1px;">' + p.totalPoints + ' pts</div>'
                    + '</div>'
                    + '</div>';
            };

            let html = '';
            teamEntries.forEach(([shortName, team]) => {
                html += '<tr style="border-bottom:1px solid #1A2E28;vertical-align:top;">';

                // Team cell
                html += '<td style="padding:16px 14px;min-width:140px;">'
                    + '<div style="display:flex;align-items:center;gap:10px;">'
                    + this.teamBadge(shortName, 36)
                    + '<div>'
                    + '<div style="font-size:14px;font-weight:700;color:#fff;">' + team.teamFull + '</div>'
                    + '</div>'
                    + '</div>'
                    + '</td>';

                // Penalties
                html += '<td style="padding:16px 12px;min-width:250px;">'
                    + '<div style="font-size:10px;font-weight:700;color:#ffa600;text-transform:uppercase;letter-spacing:0.08em;font-family:var(--font-mono);margin-bottom:8px;display:flex;align-items:center;gap:6px;">'
                    + '<span style="color:#ffa600;font-size:14px;">⚽</span> Penalties'
                    + '</div>';
                team.penalties.forEach((p, i) => { html += renderPlayer(p, i, team.penalties.length); });
                html += '</td>';

                // Direct Free-Kicks
                html += '<td style="padding:16px 12px;min-width:250px;">'
                    + '<div style="font-size:10px;font-weight:700;color:#6496ff;text-transform:uppercase;letter-spacing:0.08em;font-family:var(--font-mono);margin-bottom:8px;display:flex;align-items:center;gap:6px;">'
                    + '<span style="color:#6496ff;font-size:14px;">🎯</span> Direct Free-Kicks'
                    + '</div>';
                team.freeKicks.forEach((p, i) => { html += renderPlayer(p, i, team.freeKicks.length); });
                html += '</td>';

                // Corners
                html += '<td style="padding:16px 12px;min-width:250px;">'
                    + '<div style="font-size:10px;font-weight:700;color:#c084fc;text-transform:uppercase;letter-spacing:0.08em;font-family:var(--font-mono);margin-bottom:8px;display:flex;align-items:center;gap:6px;">'
                    + '<span style="color:#c084fc;font-size:14px;">📐</span> Corners & Indirect FKs'
                    + '</div>';
                team.corners.forEach((p, i) => { html += renderPlayer(p, i, team.corners.length); });
                html += '</td>';

                html += '</tr>';
            });

            tbody.innerHTML = html;
        } catch (e) {
            console.error('Set pieces render error:', e);
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:40px;color:#ff4d4d;">Failed to load set piece data</td></tr>';
        }
    },

    // ==================== PLAYER DETAIL OVERLAY ====================
    showPlayerDetail(playerId) {
        const bootstrap = this.state.bootstrapData;
        if (!bootstrap || !playerId) return;
        const player = bootstrap.elements.find(e => e.id === playerId);
        if (!player) return;
        const team = bootstrap.teams.find(t => t.id === player.team);
        const posNames = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
        const posColors = { 1: '#FFD700', 2: '#4FC3F7', 3: '#81C784', 4: '#E57373' };
        const posStr = posNames[player.element_type] || 'MID';
        const posColor = posColors[player.element_type] || '#4FC3F7';
        const price = (player.now_cost / 10).toFixed(1);
        const form = parseFloat(player.form || 0);
        const mins = player.minutes || 0;
        const nineties = mins > 0 ? mins / 90 : 0;
        const xG = parseFloat(player.expected_goals || 0);
        const xA = parseFloat(player.expected_assists || 0);
        const xGI = parseFloat(player.expected_goal_involvements || 0);
        const xGI90 = parseFloat(player.expected_goal_involvements_per_90 || 0);
        const defcon = parseFloat(player.defensive_contribution || 0);
        const ict = parseFloat(player.ict_index || 0);
        const own = parseFloat(player.selected_by_percent || 0);

        // Next 5 fixtures
        const fixtures = this.state.fixtures || [];
        const nextFixtures = [];
        const currentGW = this.state.currentGW || 1;
        for (let gw = currentGW; gw <= Math.min(38, currentGW + 4); gw++) {
            const fx = fixtures.find(f => f.event === gw && (f.team_h === player.team || f.team_a === player.team));
            if (fx) {
                const isHome = fx.team_h === player.team;
                const oppId = isHome ? fx.team_a : fx.team_h;
                const opp = bootstrap.teams.find(t => t.id === oppId);
                const diff = isHome ? (fx.team_h_difficulty || 3) : (fx.team_a_difficulty || 3);
                nextFixtures.push({ gw, opp: opp?.short_name || '?', isHome, diff });
            } else {
                nextFixtures.push({ gw, opp: 'BLANK', isHome: null, diff: 3 });
            }
        }

        const fdrColors = { 1: '#1A9F39', 2: '#42B659', 3: '#F9D243', 4: '#F0613D', 5: '#E21C3D' };
        const photoUrl = `https://resources.premierleague.com/premierleague25/photos/players/110x140/${player.code}.png`;
        const formBars = [form >= 5 ? 1 : 2, form >= 4 ? 2 : 3, form >= 3 ? 1 : 2, form >= 2 ? 3 : 4, form >= 1 ? 1 : 5];

        const html = `
            <div class="player-detail-header">
                <div class="player-detail-photo">
                    <img src="${photoUrl}" alt="${player.web_name} photo" onerror="this.style.display='none'" loading="lazy">
                </div>
                <div class="player-detail-info">
                    <h3 class="player-detail-name">${this.escapeHTML(player.web_name)}</h3>
                    <div class="player-detail-meta">
                        <span class="player-detail-pos" style="background:${posColor}20;color:${posColor};">${posStr}</span>
                        <span>${this.teamBadge(team?.short_name, 14)} ${team?.short_name || 'FPL'}</span>
                        <span style="font-family:var(--font-mono);color:#00FF85;">£${price}m</span>
                        <span style="font-family:var(--font-mono);">${own.toFixed(1)}% owned</span>
                    </div>
                </div>
            </div>
            <div class="player-detail-stats">
                <div class="player-detail-stat"><div class="player-detail-stat-label">Points</div><div class="player-detail-stat-value">${player.total_points}</div></div>
                <div class="player-detail-stat"><div class="player-detail-stat-label">Form</div><div class="player-detail-stat-value" style="display:flex;align-items:center;justify-content:center;gap:4px;">${form.toFixed(1)}<span style="display:flex;gap:1px;align-items:flex-end;">${formBars.map(h => `<span style="width:3px;height:${h * 3}px;border-radius:1px;background:var(--fdr-${h});"></span>`).join('')}</span></div></div>
                <div class="player-detail-stat"><div class="player-detail-stat-label">Minutes</div><div class="player-detail-stat-value">${mins.toLocaleString()}</div></div>
                <div class="player-detail-stat"><div class="player-detail-stat-label">ICT Index</div><div class="player-detail-stat-value">${ict.toFixed(1)}</div></div>
            </div>
            <div class="player-detail-section">
                <div class="player-detail-section-title">Expected Stats</div>
                <div class="player-detail-xg-breakdown">
                    <div class="player-detail-xg-item"><div class="val" style="color:${xG >= 5 ? '#00FF85' : '#ffffff'}">${xG.toFixed(1)}</div><div class="lbl">xG</div></div>
                    <div class="player-detail-xg-item"><div class="val" style="color:${xA >= 3 ? '#00FF85' : '#ffffff'}">${xA.toFixed(1)}</div><div class="lbl">xA</div></div>
                    <div class="player-detail-xg-item"><div class="val" style="color:${xGI >= 5 ? '#00FF85' : '#ffffff'}">${xGI.toFixed(1)}</div><div class="lbl">xGI</div></div>
                </div>
                <div style="display:flex;justify-content:center;gap:24px;margin-top:12px;font-size:0.75rem;color:#8ba396;font-family:var(--font-mono);">
                    <span>xGI/90: <b style="color:#ffffff;">${xGI90.toFixed(2)}</b></span>
                    <span>DefCon: <b style="color:#ffffff;">${defcon.toFixed(1)}</b></span>
                    <span>Goals: <b style="color:#ffffff;">${player.goals_scored || 0}</b></span>
                    <span>Assists: <b style="color:#ffffff;">${player.assists || 0}</b></span>
                </div>
            </div>
            <div class="player-detail-section">
                <div class="player-detail-section-title">Next 5 Fixtures</div>
                <div class="player-detail-fixtures">
                    ${nextFixtures.map(f => `<div class="player-detail-fixture" style="background:${fdrColors[f.diff]}20;color:${fdrColors[f.diff]};border:1px solid ${fdrColors[f.diff]}40;"><div style="font-size:9px;opacity:0.7;">GW${f.gw}</div><div style="font-weight:700;font-size:13px;">${f.opp}</div><div style="font-size:9px;">${f.isHome === null ? '' : f.isHome ? 'H' : 'A'}</div></div>`).join('')}
                </div>
            </div>
            <div class="player-detail-section" style="border-top:1px solid #1A2E28;">
                <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
                    <a href="https://fantasy.premierleague.com/entry/${this.state.managerId || ''}/event/${this.state.currentGW || 1}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:var(--radius-pill);background:#141916;border:1px solid #1A2E28;color:#ffffff;text-decoration:none;font-size:0.8125rem;font-weight:600;cursor:pointer;transition:all var(--transition-fast);"><span class="material-symbols-outlined" style="font-size:16px;">open_in_new</span> View on FPL</a>
                </div>
            </div>
        `;

        const body = document.getElementById('player-detail-body');
        if (body) body.innerHTML = html;
        this.showDialog('player-detail-dialog');
    },

    // ==================== SIDEBAR & COLLAPSE ====================
    initSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        const mobileBtn = document.getElementById('mobile-menu-btn');
        const closeBtn = document.getElementById('sidebar-mobile-close-btn');

        const closeMobile = () => {
            sidebar?.classList.remove('mobile-open');
            overlay?.classList.remove('active');
            if (mobileBtn) mobileBtn.setAttribute('aria-expanded', 'false');
        };

        const openMobile = () => {
            sidebar?.classList.add('mobile-open');
            overlay?.classList.add('active');
            if (mobileBtn) mobileBtn.setAttribute('aria-expanded', 'true');
        };

        if (mobileBtn && mobileBtn.dataset.bound !== 'true' && mobileBtn.dataset.sidebarBound !== 'true' && mobileBtn.dataset.shellBound !== 'true') {
            mobileBtn.dataset.bound = 'true';
            mobileBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (sidebar?.classList.contains('mobile-open')) closeMobile();
                else openMobile();
            });
        }

        if (closeBtn && closeBtn.dataset.bound !== 'true') {
            closeBtn.dataset.bound = 'true';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeMobile();
            });
        }

        if (overlay && overlay.dataset.bound !== 'true') {
            overlay.dataset.bound = 'true';
            overlay.addEventListener('click', closeMobile);
        }

        document.querySelectorAll('.sidebar-nav-item').forEach(item => {
            if (item.dataset.mobileCloseBound !== 'true') {
                item.dataset.mobileCloseBound = 'true';
                item.addEventListener('click', () => {
                    if (window.innerWidth <= 1024) closeMobile();
                });
            }
        });

        // Auto-expand section containing active tab
        this._expandActiveSection();

        this.initSidebarCollapse();
    },

    _expandActiveSection() {
        const activeTab = this.state.activeTab;
        if (!activeTab) return;
        const activeItem = document.querySelector(`.sidebar-nav-item[data-tab="${activeTab}"]`);
        if (activeItem) {
            const section = activeItem.closest('div');
            if (section && section.classList.contains('collapsed')) {
                section.classList.remove('collapsed');
                const idx = Array.from(document.querySelectorAll('#sidebar .sidebar-section-toggle')).indexOf(section.querySelector('.sidebar-section-toggle'));
                if (idx >= 0) localStorage.setItem('fplSection_' + idx, 'false');
            }
        }
    },

    toggleSidebarCollapse() {
        const sidebar = document.getElementById('sidebar');
        const btn = document.getElementById('sidebar-collapse-btn');
        if (!sidebar || !btn) return;
        if (window.innerWidth <= 1024) return;
        const collapsed = !sidebar.classList.contains('collapsed');
        sidebar.classList.toggle('collapsed', collapsed);
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        const icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = collapsed ? 'chevron_right' : 'chevron_left';
        localStorage.setItem('fplSidebarCollapsed', String(collapsed));
    },

    initSidebarCollapse() {
        const sidebar = document.getElementById('sidebar');
        const btn = document.getElementById('sidebar-collapse-btn');
        if (!sidebar || !btn) return;
        const saved = localStorage.getItem('fplSidebarCollapsed');
        const icon = btn.querySelector('.material-symbols-outlined');
        const isCollapsed = saved === 'true' && window.innerWidth > 1024;
        sidebar.classList.toggle('collapsed', isCollapsed);
        btn.setAttribute('aria-expanded', String(!isCollapsed));
        btn.setAttribute('aria-label', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
        btn.title = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
        if (icon) icon.textContent = isCollapsed ? 'chevron_right' : 'chevron_left';

        // Restore section collapsed states
        document.querySelectorAll('#sidebar .sidebar-section-toggle').forEach((toggle, idx) => {
            const sectionDiv = toggle.parentElement;
            const key = 'fplSection_' + idx;
            const collapsed = localStorage.getItem(key) === 'true';
            sectionDiv.classList.toggle('collapsed', collapsed);
            toggle.addEventListener('click', () => {
                sectionDiv.classList.toggle('collapsed');
                localStorage.setItem(key, String(sectionDiv.classList.contains('collapsed')));
            });
        });

        if (btn.dataset.bound !== 'true') {
            btn.dataset.bound = 'true';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleSidebarCollapse();
            });
            window.addEventListener('resize', () => {
                if (window.innerWidth <= 1024) {
                    sidebar.classList.remove('collapsed');
                } else {
                    const collapsed = localStorage.getItem('fplSidebarCollapsed') === 'true';
                    sidebar.classList.toggle('collapsed', collapsed);
                }
            });
        }
    },

    initBottomNavOverflow() {
        // Click outside to close overflow menu
        document.addEventListener('click', (e) => {
            const overflow = document.getElementById('bottom-nav-overflow');
            const menu = document.getElementById('bottom-nav-overflow-menu');
            const btn = document.getElementById('bottom-nav-overflow-btn');
            if (!overflow || !menu || !btn) return;
            if (!overflow.contains(e.target)) {
                this.closeOverflowMenu();
            }
        });
    },

    toggleBottomNavOverflow() {
        const menu = document.getElementById('bottom-nav-overflow-menu');
        const trigger = document.getElementById('bottom-nav-overflow-btn');
        if (!menu || !trigger) return;
        const isOpen = menu.classList.contains('open');
        if (isOpen) {
            this.closeOverflowMenu();
        } else {
            menu.classList.add('open');
            trigger.setAttribute('aria-expanded', 'true');
        }
    },

    closeOverflowMenu() {
        const menu = document.getElementById('bottom-nav-overflow-menu');
        const trigger = document.getElementById('bottom-nav-overflow-btn');
        if (menu) menu.classList.remove('open');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
    },

    // ==================== AI TEAM MODEL UPDATE ====================
    async confirmAITeamRebuild() {
        const result = await this.confirmDialog({
            title: 'Update the AI model?',
            message: 'Re-run squad selection against the latest FPL availability, fixtures and projections. No reset step is required.',
            confirmLabel: 'Update model',
            cancelLabel: 'Cancel'
        });
        if (result) this.loadAITeam(true);
    },

    // ==================== RESIZABLE PANELS ====================
    initResizablePanels() {
        document.querySelectorAll('.resizer-col').forEach(resizer => {
            const container = resizer.parentElement;
            if (!container) return;
            const prev = resizer.previousElementSibling;
            const next = resizer.nextElementSibling;
            if (!prev || !next) return;
            let startX, startPrevWidth, startNextWidth;
            const onMouseMove = (e) => {
                const dx = e.clientX - startX;
                const containerWidth = container.offsetWidth;
                const newPrevWidth = Math.max(200, Math.min(containerWidth - 200, startPrevWidth + dx));
                const newNextWidth = Math.max(200, startNextWidth - dx);
                prev.style.flex = 'none';
                prev.style.width = newPrevWidth + 'px';
                next.style.flex = '1';
                next.style.width = '';
                resizer.classList.add('dragging');
            };
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                resizer.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };
            resizer.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startX = e.clientX;
                startPrevWidth = prev.offsetWidth;
                startNextWidth = next.offsetWidth;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        });
    }
};

window.FPL = FPL;
