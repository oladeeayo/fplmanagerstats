// FPL Manager Stats - Common JavaScript Utilities
const FPL = {
    state: {
        managerData: null,
        bootstrapData: null,
        leagueData: null,
        gameweekHistory: null,
        fixtures: null,
        currentGW: null,
        selectedGW: null,
        teamMap: {},
        playerMap: {},
        positionMap: { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' },
        isLoading: false,
        error: null,
        activeTab: null,
        managerId: localStorage.getItem('fplManagerId') || null,
        theme: 'dark'
    },

    API: {
        bootstrap: '/api/bootstrap-static',
        manager: (id) => `/api/manager/${id}`,
        history: (id) => `/api/manager/${id}/history`,
        league: (id) => `/api/league/${id}`,
        leagueStandings: (id) => `/api/league/${id}/standings`,
        fixtures: '/api/fixtures',
        playerStats: '/api/player-stats',
        captaincy: '/api/captaincy',
        ownership: '/api/ownership',
        zones: '/api/zones',
        live: (gw) => `/api/live/${gw}`
    },

    async fetch(url) {
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
        try {
            const bootstrap = await this.fetch(this.API.bootstrap);
            this.state.bootstrapData = bootstrap;
            this.state.currentGW = bootstrap.currentGameweek;
            this.state.selectedGW = bootstrap.currentGameweek;

            bootstrap.teams.forEach(t => { this.state.teamMap[t.id] = t; });
            bootstrap.players.forEach(p => {
                this.state.playerMap[p.id] = p;
                p.teamName = this.state.teamMap[p.team]?.name || '';
                p.teamShort = this.state.teamMap[p.team]?.short_name || '';
                p.positionName = this.state.positionMap[p.element_type] || '';
            });

            if (this.state.managerId) {
                await this.loadManagerData(this.state.managerId);
            }

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
            const [manager, history, league] = await Promise.all([
                this.fetch(this.API.manager(managerId)),
                this.fetch(this.API.history(managerId)),
                this.fetch(this.API.league(managerId))
            ]);

            this.state.managerData = manager;
            this.state.gameweekHistory = history;
            this.state.leagueData = league;
            this.state.managerId = managerId;
            localStorage.setItem('fplManagerId', managerId);
        } catch (err) {
            console.error('Error loading manager data:', err);
            this.showError('Failed to load manager data');
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
        if (num === null || num === undefined) return '-';
        return num.toLocaleString();
    },

    formatPrice(price) {
        if (!price) return '-';
        return (price / 10).toFixed(1);
    },

    formatPoints(points) {
        if (points === null || points === undefined) return '-';
        return points >= 0 ? `+${points}` : points;
    },

    formatPercent(pct) {
        if (pct === null || pct === undefined) return '-';
        return pct.toFixed(1) + '%';
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

    getDiffClass(diff) {
        if (diff >= 10) return 'diff-green';
        if (diff >= 5) return 'diff-yellow';
        if (diff >= 0) return 'diff-orange';
        return 'diff-red';
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

    getTeamBadge(teamId) {
        const team = this.state.teamMap[teamId];
        if (!team) return '';
        return `<span style="display:inline-flex;align-items:center;gap:4px;">
            <span style="width:20px;height:20px;border-radius:50%;background:${team.team_colour || '#333'};display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:white;">${team.short_name}</span>
        </span>`;
    },

    getPlayerName(playerId) {
        const player = this.state.playerMap[playerId];
        if (!player) return 'Unknown';
        return `${player.first_name} ${player.second_name}`;
    },

    getPlayerWebName(playerId) {
        const player = this.state.playerMap[playerId];
        return player?.web_name || 'Unknown';
    },

    getTeamName(teamId) {
        return this.state.teamMap[teamId]?.name || 'Unknown';
    },

    getTeamShort(teamId) {
        return this.state.teamMap[teamId]?.short_name || '???';
    },

    getPosition(elementType) {
        return this.state.positionMap[elementType] || 'UNK';
    },

    navigateTo(tab) {
        this.state.activeTab = tab;
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));

        const tabEl = document.getElementById(`tab-${tab}`);
        const contentEl = document.getElementById(`content-${tab}`);
        if (tabEl) tabEl.classList.add('active');
        if (contentEl) contentEl.classList.add('active');

        // Update bottom nav
        document.querySelectorAll('.bottom-nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.tab === tab);
        });

        // Update URL
        const url = new URL(window.location);
        url.searchParams.set('tab', tab);
        window.history.pushState({}, '', url);

        // Scroll to top
        window.scrollTo(0, 0);
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

        // Close sidebar on nav click (mobile)
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

    createSortHandler(tableId, columnIndex, type = 'string') {
        return (e) => {
            const table = document.getElementById(tableId);
            if (!table) return;
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            const th = e.target.closest('th');
            const isAsc = th.classList.contains('sort-active') && th.classList.contains('asc');

            // Reset all headers
            table.querySelectorAll('th').forEach(h => h.classList.remove('sort-active', 'asc'));

            // Sort
            rows.sort((a, b) => {
                let aVal = a.cells[columnIndex]?.textContent?.trim() || '';
                let bVal = b.cells[columnIndex]?.textContent?.trim() || '';

                if (type === 'number') {
                    aVal = parseFloat(aVal.replace(/[^0-9.-]/g, '')) || 0;
                    bVal = parseFloat(bVal.replace(/[^0-9.-]/g, '')) || 0;
                } else if (type === 'rank') {
                    aVal = parseInt(aVal) || 999;
                    bVal = parseInt(bVal) || 999;
                }

                if (type === 'string') {
                    return isAsc ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
                }
                return isAsc ? bVal - aVal : aVal - bVal;
            });

            th.classList.add('sort-active');
            if (isAsc) th.classList.remove('asc');
            else th.classList.add('asc');

            rows.forEach(row => tbody.appendChild(row));
        };
    },

    debounce(fn, delay = 300) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    },

    initHistory() {
        const container = document.getElementById('history-section');
        if (!container) return;

        const managerId = this.state.managerId || this.state.managerData?.id;
        if (!managerId) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="material-symbols-outlined">history</span>
                    <p>Connect your FPL ID to view history</p>
                </div>`;
            return;
        }

        const history = this.state.gameweekHistory;
        if (!history || !history.current) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="material-symbols-outlined">hourglass_empty</span>
                    <p>No history data available</p>
                </div>`;
            return;
        }

        const chips = history.current.map(gw =>
            `<span class="history-badge" onclick="FPL.showGWDetail(${gw.gameweek})">
                GW${gw.gameweek}: ${this.formatPoints(gw.points)} pts
            </span>`
        ).join('');

        container.innerHTML = `
            <div class="card">
                <div class="card-header">
                    <h3><span class="material-symbols-outlined" style="font-size:20px">history</span> Gameweek History</h3>
                </div>
                <div class="card-body">
                    <div style="display:flex;flex-wrap:wrap;gap:8px;">${chips}</div>
                </div>
            </div>`;
    },

    showGWDetail(gw) {
        // Placeholder for GW detail modal
        console.log('Show GW detail:', gw);
    },

    initSettings() {
        const container = document.getElementById('settings-section');
        if (!container) return;

        container.innerHTML = `
            <div class="card">
                <div class="card-header">
                    <h3><span class="material-symbols-outlined" style="font-size:20px">settings</span> Settings</h3>
                </div>
                <div class="card-body">
                    <div class="input-group mb-md">
                        <label class="input-label">FPL Manager ID</label>
                        <div style="display:flex;gap:8px;">
                            <input type="number" class="input" id="settings-manager-id"
                                placeholder="Enter your FPL Manager ID"
                                value="${this.state.managerId || ''}">
                            <button class="btn btn-primary" onclick="FPL.updateManagerId()">Save</button>
                        </div>
                        <small style="color:var(--md-sys-color-on-surface-variant)">
                            Find your Manager ID in the URL when viewing your team.
                        </small>
                    </div>
                    <div class="divider"></div>
                    <div class="flex items-center justify-between">
                        <span>Clear saved data</span>
                        <button class="btn btn-outline" onclick="FPL.clearData()" style="border-color:var(--md-sys-color-error);color:var(--md-sys-color-error)">
                            Clear Data
                        </button>
                    </div>
                </div>
            </div>`;
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
        this.state.managerId = null;
        this.state.managerData = null;
        this.state.gameweekHistory = null;
        this.state.leagueData = null;
        location.reload();
    },

    render() {
        // Override in page-specific JS
    }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    FPL.initSidebar();
    FPL.initDialogs();
    FPL.initFromURL();
});

// Handle browser back/forward
window.addEventListener('popstate', () => {
    FPL.initFromURL();
});
