import { useEffect, useRef, useState, memo } from 'react';
import { useFPL } from '../context/FPLContext';

// Generic slot renderer that mounts a React component into a legacy DOM slot
interface ReactSlotProps {
  slotId: string;
  children: React.ReactNode;
}

function ReactSlotComponent({ slotId, children }: ReactSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Hide the legacy content once React takes over
    const slot = slotRef.current;
    if (!slot) return;
    const parent = slot.closest('.tab-content');
    if (parent) {
      (parent as HTMLElement).dataset.reactContent = 'true';
    }
  }, []);

  return (
    <div ref={slotRef} id={`react-slot-${slotId}`} data-react-slot="true">
      {children}
    </div>
  );
}

export const ReactSlot = memo(ReactSlotComponent);

// Example: A self-contained React component for the Set Pieces tab
// This demonstrates the migration pattern for a relatively simple tab

interface SetPiecePlayer {
  name: string;
  team: string;
  role: string;
  minutes: number;
  webName: string;
}

export function SetPiecesTab() {
  const { apiFetch, getCachedTabData, setCachedTabData } = useFPL();
  const [data, setData] = useState<SetPiecePlayer[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = getCachedTabData('set-pieces');
    if (cached) {
      setData(cached);
      setLoading(false);
      return;
    }

    apiFetch('/api/bootstrap-static')
      .then(res => {
        const players = (res.elements || []).filter((p: any) => {
          // Filter for likely set-piece takers: high set_piece_order, decent minutes
          return p.set_piece_order && p.set_piece_order <= 2 && p.minutes > 500;
        });
        const teams = Object.fromEntries((res.teams || []).map((t: any) => [t.id, t.short_name]));
        const result: SetPiecePlayer[] = players.map((p: any) => ({
          name: p.web_name,
          team: teams[p.team] || '?',
          role: p.set_piece_order === 1 ? 'Primary' : 'Secondary',
          minutes: p.minutes,
          webName: p.web_name,
        })).sort((a: SetPiecePlayer, b: SetPiecePlayer) => b.minutes - a.minutes);
        setData(result);
        setCachedTabData('set-pieces', result);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <span className="material-symbols-outlined" style={{ animation: 'spin 1s linear infinite', fontSize: 32 }}>progress_activity</span>
        <div style={{ marginTop: 8, color: 'var(--md-sys-color-on-surface-variant)' }}>Loading set piece data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: 'var(--md-sys-color-error)' }}>
        {error}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', color: 'var(--md-sys-color-on-surface-variant)' }}>
        No set piece data available
      </div>
    );
  }

  return (
    <div style={{ padding: '16px' }}>
      <h3 style={{ marginBottom: 16, fontSize: 16, fontWeight: 600 }}>Set Piece Takers</h3>
      <div style={{ display: 'grid', gap: 8 }}>
        {data.map(player => (
          <div
            key={player.webName}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              background: 'var(--md-sys-color-surface-container)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{player.name}</div>
              <div style={{ fontSize: 12, color: 'var(--md-sys-color-on-surface-variant)' }}>{player.team}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: player.role === 'Primary' ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-outline)' }}>
                {player.role}
              </div>
              <div style={{ fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)' }}>
                {player.minutes} min
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
