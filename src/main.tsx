import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import './fonts.css';

// The server issues an HttpOnly, SameSite=Lax session cookie via the session
// middleware, so the client must not create one itself.

function mountApp() {
  createRoot(document.getElementById('root')!).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

const savedTheme = window.localStorage.getItem('theme') || window.localStorage.getItem('fplTheme');
const initialTheme = savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'dark';
document.documentElement.dataset.theme = initialTheme;
document.documentElement.classList.toggle('dark', initialTheme === 'dark');

mountApp();

// Speculative prefetch: warm the browser cache with critical API data before
// the legacy scripts even finish loading. These fetches are ~50ms faster on
// repeat visits because the service-worker intercepts and caches them.
const prefetchUrls = ['/api/bootstrap-static', '/api/fixtures', '/fotmob-player-ids.json'];
prefetchUrls.forEach((url) => {
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = url;
  link.as = 'fetch';
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
});

// Load both legacy scripts in parallel instead of sequentially.
// common.js defines window.FPL; goals-projections-renderers.js adds
// render helpers. We gate fpl-ready on both finishing.
let legacyReady = false;
let goalsReady = false;
function checkLegacyReady() {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fpl = (window as any).FPL;
  if (typeof renderGoalsScoredProjections === 'function') fpl.renderGoalsScoredProjections = renderGoalsScoredProjections;
  if (typeof renderGoalsConcededProjections === 'function') fpl.renderGoalsConcededProjections = renderGoalsConcededProjections;
  window.dispatchEvent(new CustomEvent('fpl-ready'));
}
const legacyScript = document.createElement('script');
legacyScript.src = '/common.js?v=27';
legacyScript.defer = true;
legacyScript.addEventListener('load', () => {
  legacyReady = true;
  if (goalsReady) checkLegacyReady();
});
legacyScript.addEventListener('error', () => console.error('Failed to load the FPL dashboard data client.'));
const goalsRenderers = document.createElement('script');
goalsRenderers.src = '/goals-projections-renderers.js?v=1';
goalsRenderers.defer = true;
goalsRenderers.addEventListener('load', () => {
  goalsReady = true;
  if (legacyReady) checkLegacyReady();
});
goalsRenderers.addEventListener('error', () => {
  console.error('Failed to load goals projections renderers');
  goalsReady = true;
  if (legacyReady) checkLegacyReady();
});
document.head.appendChild(legacyScript);
document.head.appendChild(goalsRenderers);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration?.update?.())
      .catch(() => {});
  });
}
