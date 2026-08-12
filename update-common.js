const fs = require('fs');

let js = fs.readFileSync('c:/Users/User/Desktop/fplmanagerstats/public/common.js', 'utf8');

const replacement = `    loaderInterval: null,
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
    },`;

js = js.replace(/showLoading\(\)\s*\{[\s\S]*?hideLoading\(\)\s*\{[\s\S]*?\},/m, replacement);
fs.writeFileSync('c:/Users/User/Desktop/fplmanagerstats/public/common.js', js, 'utf8');
console.log('Successfully updated common.js loading methods!');
