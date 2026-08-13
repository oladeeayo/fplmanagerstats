import { memo, useEffect, useMemo } from 'react';
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

interface LegacyDashboardProps {
  activeTab: string;
}

function LegacyDashboardComponent({ activeTab }: LegacyDashboardProps) {
  const markup = useMemo(() => extractBody(legacyDocument), []);
  const styles = useMemo(() => extractInlineStyles(legacyDocument), []);

  useEffect(() => {
    document.querySelectorAll<HTMLElement>('.tab-content').forEach((element) => {
      element.classList.toggle('active', element.id === `content-${activeTab}`);
    });
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach((element) => {
      element.classList.toggle('active', element.dataset.tab === activeTab);
    });
  }, [activeTab]);

  return (
    <>
      <style>{styles}</style>
      <div dangerouslySetInnerHTML={{ __html: markup }} />
    </>
  );
}

export const LegacyDashboard = memo(LegacyDashboardComponent);
