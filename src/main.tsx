import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import './fonts.css';

if (!document.cookie.split('; ').some((cookie) => cookie.startsWith('fpl_analytics_session='))) {
  const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  document.cookie = `fpl_analytics_session=${sessionId}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

function mountApp() {
  createRoot(document.getElementById('root')!).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

mountApp();

const legacyScript = '/common.js?v=7';
void import(/* @vite-ignore */ legacyScript).then(() => {
  window.dispatchEvent(new CustomEvent('fpl-ready'));
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => registration.update());
  });
}
