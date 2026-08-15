import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import './fonts.css';

if (!document.cookie.split('; ').some((cookie) => cookie.startsWith('fpl_analytics_session='))) {
  const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  document.cookie = `fpl_analytics_session=${sessionId}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

async function start() {
  const legacyScript = '/common.js?v=6';
  await import(/* @vite-ignore */ legacyScript);
  createRoot(document.getElementById('root')!).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

void start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => registration.update());
  });
}
