import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { createWorker } from 'tesseract.js';
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

mountApp();

window.createFplOcrWorker = createWorker;

const importScript = document.createElement('script');
importScript.src = '/squad-import.js?v=1';
importScript.defer = true;
importScript.addEventListener('load', () => {
  const prefScript = document.createElement('script');
  prefScript.src = '/team-preferences.js?v=1';
  prefScript.defer = true;
  prefScript.addEventListener('load', () => {
    const legacyScript = document.createElement('script');
     legacyScript.src = '/common.js?v=22';
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
  });
  prefScript.addEventListener('error', () => console.error('Failed to load the team preferences helper.'));
  document.head.appendChild(prefScript);
});
importScript.addEventListener('error', () => console.error('Failed to load the squad import helper.'));
document.head.appendChild(importScript);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration?.update?.())
      .catch(() => {});
  });
}
