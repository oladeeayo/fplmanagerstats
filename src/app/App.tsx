import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { InstallPrompt } from '../components/InstallPrompt';
import { LegacyDashboard } from '../components/LegacyDashboard';
import { appRoutes, isAppTab, tabFromPath, type AppTab } from './routes';

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  const initPromise = useRef<Promise<void> | null>(null);
  const [ready, setReady] = useState(false);
  const pathTab = tabFromPath(location.pathname);
  const legacyTab = new URLSearchParams(location.search).get('tab');
  const activeTab = pathTab ?? (location.pathname === '/' && isAppTab(legacyTab) ? legacyTab : 'general');

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    if (location.pathname === '/' && isAppTab(legacyTab) && legacyTab !== 'general') {
      navigate(appRoutes[legacyTab], { replace: true });
    } else if (!pathTab) {
      navigate(appRoutes.general, { replace: true });
    }
  }, [legacyTab, location.pathname, navigate, pathTab]);

  useEffect(() => {
    let disposed = false;
    let originalNavigate: ((tab: string) => void) | null = null;
    const initialize = () => {
      const fpl = window.FPL;
      if (!fpl || disposed) return;
      originalNavigate = fpl.navigateTo.bind(fpl);
      fpl.navigateTo = (tab: string) => {
        const path = appRoutes[tab as AppTab] ?? appRoutes.general;
        navigateRef.current(path);
        window.scrollTo(0, 0);
      };
      if (!initPromise.current) {
        fpl.state.activeTab = activeTab;
        fpl.initSidebar();
        fpl.initDialogs();
        initPromise.current = fpl.init();
      }
      void initPromise.current.finally(() => {
        if (!disposed) setReady(true);
      });
    };
    if (window.FPL) initialize();
    else window.addEventListener('fpl-ready', initialize, { once: true });

    return () => {
      disposed = true;
      window.removeEventListener('fpl-ready', initialize);
      if (originalNavigate && window.FPL) window.FPL.navigateTo = originalNavigate;
    };
  }, []);

  useEffect(() => {
    if (!ready || !window.FPL) return;
    window.FPL.state.activeTab = activeTab;
    void window.FPL.loadTabData(activeTab);
    window.FPL.initSidebar();

    document.querySelectorAll<HTMLElement>('.sidebar-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === activeTab);
    });
    document.querySelectorAll<HTMLElement>('.bottom-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === activeTab);
    });
  }, [activeTab, ready]);

  return (
    <>
      <LegacyDashboard activeTab={activeTab} />
      <InstallPrompt />
    </>
  );
}
