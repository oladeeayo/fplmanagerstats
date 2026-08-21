import { memo } from 'react';

const skeletonStyles: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  background: 'var(--md-sys-color-background)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '16px',
  padding: '24px',
  animation: 'fadeIn 150ms ease',
};

const barStyle = (width: string, delay = 0): React.CSSProperties => ({
  height: '12px',
  borderRadius: '6px',
  background: 'linear-gradient(90deg, var(--md-sys-color-surface-container) 25%, var(--md-sys-color-surface-container-high) 50%, var(--md-sys-color-surface-container) 75%)',
  backgroundSize: '200% 100%',
  animation: `shimmer 1.5s ease-in-out ${delay}s infinite`,
  width,
});

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '800px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const keyframes = `
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

function TabSkeletonComponent() {
  return (
    <div style={skeletonStyles}>
      <style>{keyframes}</style>
      <div style={cardStyle}>
        <div style={barStyle('60%', 0)} />
        <div style={barStyle('100%', 0.1)} />
        <div style={barStyle('80%', 0.2)} />
        <div style={barStyle('45%', 0.3)} />
        <div style={{ height: '8px' }} />
        <div style={barStyle('90%', 0.4)} />
        <div style={barStyle('70%', 0.5)} />
        <div style={barStyle('55%', 0.6)} />
      </div>
    </div>
  );
}

export const TabSkeleton = memo(TabSkeletonComponent);
