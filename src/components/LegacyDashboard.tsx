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
  }, [activeTab]);

  return (
    <>
      <style>{styles}</style>
      <div ref={dashboardRef} dangerouslySetInnerHTML={{ __html: markup }} />
    </>
  );
}

export const LegacyDashboard = memo(LegacyDashboardComponent);
