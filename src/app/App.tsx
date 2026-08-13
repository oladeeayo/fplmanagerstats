import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LegacyDashboard } from '../components/LegacyDashboard';
import { appRoutes, isAppTab, tabFromPath, type AppTab } from './routes';

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const initPromise = useRef<Promise<void> | null>(null);
  const [ready, setReady] = useState(false);
  const pathTab = tabFromPath(location.pathname);
  const legacyTab = new URLSearchParams(location.search).get('tab');
  const activeTab = pathTab ?? (location.pathname === '/' && isAppTab(legacyTab) ? legacyTab : 'general');

  useEffect(() => {
    if (location.pathname === '/' && isAppTab(legacyTab) && legacyTab !== 'general') {
      navigate(appRoutes[legacyTab], { replace: true });
    } else if (!pathTab) {
      navigate(appRoutes.general, { replace: true });
    }
  }, [legacyTab, location.pathname, navigate, pathTab]);

  useEffect(() => {
    const fpl = window.FPL;
    const originalNavigate = fpl.navigateTo.bind(fpl);

    fpl.navigateTo = (tab: string) => {
      const path = appRoutes[tab as AppTab] ?? appRoutes.general;
      navigate(path);
      window.scrollTo(0, 0);
    };

    if (!initPromise.current) {
      fpl.state.activeTab = activeTab;
      fpl.initSidebar();
      fpl.initDialogs();
      initPromise.current = fpl.init();
    }
    void initPromise.current.finally(() => setReady(true));

    return () => {
      fpl.navigateTo = originalNavigate;
    };
  }, [activeTab, navigate]);

  useEffect(() => {
    if (!ready) return;
    window.FPL.state.activeTab = activeTab;
    void window.FPL.loadTabData(activeTab);
  }, [activeTab, ready]);

  return <LegacyDashboard activeTab={activeTab} />;
}
