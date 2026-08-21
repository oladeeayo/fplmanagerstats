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

const legacyScript = document.createElement('script');
legacyScript.src = '/common.js?v=26';
legacyScript.defer = true;
legacyScript.addEventListener('load', () => {
  const goalsRenderers = document.createElement('script');
  goalsRenderers.src = '/goals-projections-renderers.js?v=1';
  goalsRenderers.defer = true;
  goalsRenderers.addEventListener('load', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const fpl = (window as any).FPL;
    if (typeof renderGoalsScoredProjections === 'function') fpl.renderGoalsScoredProjections = renderGoalsScoredProjections;
    if (typeof renderGoalsConcededProjections === 'function') fpl.renderGoalsConcededProjections = renderGoalsConcededProjections;
    window.dispatchEvent(new CustomEvent('fpl-ready'));
  });
  goalsRenderers.addEventListener('error', () => {
    console.error('Failed to load goals projections renderers');
    window.dispatchEvent(new CustomEvent('fpl-ready'));
  });
  document.head.appendChild(goalsRenderers);
});
legacyScript.addEventListener('error', () => console.error('Failed to load the FPL dashboard data client.'));
document.head.appendChild(legacyScript);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration?.update?.())
      .catch(() => {});
  });
}
