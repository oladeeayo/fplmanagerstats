import { memo, useEffect, useMemo, useRef } from 'react';
import legacyDocument from '../legacy/dashboard.html?raw';

function extractBody(documentSource: string) {
  const match = documentSource.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!match) throw new Error('Legacy dashboard body could not be loaded');
  return match[1].replace(/<script[\s\S]*?<\/script>/gi, '');
}

function extractInlineStyles(documentSource: string) {
  return [...documentSource.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .join('\n');
}

function prepareMarkup(documentSource: string, activeTab: string) {
  const template = document.createElement('template');
  template.innerHTML = extractBody(documentSource);
  template.content.querySelectorAll<HTMLElement>('.tab-content').forEach((element) => {
    element.classList.toggle('active', element.id === `content-${activeTab}`);
  });
  template.content.querySelectorAll<HTMLElement>('[data-tab]').forEach((element) => {
    element.classList.toggle('active', element.dataset.tab === activeTab);
  });
  return template.innerHTML;
}

interface LegacyDashboardProps {
  activeTab: string;
}

function LegacyDashboardComponent({ activeTab }: LegacyDashboardProps) {
  const dashboardRef = useRef<HTMLDivElement>(null);
  const initialTab = useRef(activeTab);
  const markup = useMemo(() => prepareMarkup(legacyDocument, initialTab.current), []);
  const styles = useMemo(() => extractInlineStyles(legacyDocument), []);

  useEffect(() => {
    const dashboard = dashboardRef.current;
    if (!dashboard) return;

    dashboard.querySelectorAll<HTMLElement>('.tab-content').forEach((element) => {
      element.classList.toggle('active', element.id === `content-${activeTab}`);
    });
    dashboard.querySelectorAll<HTMLElement>('[data-tab]').forEach((element) => {
      element.classList.toggle('active', element.dataset.tab === activeTab);
    });

    const sidebar = dashboard.querySelector<HTMLElement>('#sidebar');
    const overlay = dashboard.querySelector<HTMLElement>('#sidebar-overlay');
    const menuButton = dashboard.querySelector<HTMLButtonElement>('#mobile-menu-btn');
    const closeButton = dashboard.querySelector<HTMLButtonElement>('#sidebar-mobile-close-btn');
    if (sidebar && overlay && menuButton && menuButton.dataset.shellBound !== 'true' && menuButton.dataset.sidebarBound !== 'true' && menuButton.dataset.bound !== 'true') {
      const closeSidebar = () => {
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('active');
        menuButton.setAttribute('aria-expanded', 'false');
      };
      // Share the legacy binding marker so the data client does not attach a
      // second toggle handler and immediately undo the drawer state.
      menuButton.dataset.shellBound = 'true';
      menuButton.dataset.sidebarBound = 'true';
      menuButton.dataset.bound = 'true';
      menuButton.addEventListener('click', () => {
        const open = sidebar.classList.toggle('mobile-open');
        overlay.classList.toggle('active', open);
        menuButton.setAttribute('aria-expanded', String(open));
      });
      overlay.addEventListener('click', closeSidebar);
      closeButton?.addEventListener('click', closeSidebar);
      dashboard.querySelectorAll<HTMLElement>('.sidebar-nav-item').forEach((item) => {
        item.addEventListener('click', () => {
          if (window.innerWidth <= 1024) closeSidebar();
        });
      });
    }
  }, [activeTab]);

  return (
    <>
      <style>{styles}</style>
      <div ref={dashboardRef} dangerouslySetInnerHTML={{ __html: markup }} />
    </>
  );
}

export const LegacyDashboard = memo(LegacyDashboardComponent);
