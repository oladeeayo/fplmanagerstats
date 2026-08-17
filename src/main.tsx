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
  const legacyScript = document.createElement('script');
  legacyScript.src = '/common.js?v=15';
  legacyScript.defer = true;
  legacyScript.addEventListener('load', () => window.dispatchEvent(new CustomEvent('fpl-ready')));
  legacyScript.addEventListener('error', () => console.error('Failed to load the FPL dashboard data client.'));
  document.head.appendChild(legacyScript);
});
importScript.addEventListener('error', () => console.error('Failed to load the squad import helper.'));
document.head.appendChild(importScript);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => registration.update());
  });
}
