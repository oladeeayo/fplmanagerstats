import { useEffect, useState, useCallback, useRef, memo } from 'react';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface Team {
  id: number;
  name: string;
  short_name: string;
}

interface Player {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
}

interface StatEntry {
  identifier: string;
  a: Array<{ value: number; element: number }>;
  h: Array<{ value: number; element: number }>;
}

interface Fixture {
  id: number;
  event: number;
  kickoff_time: string;
  team_h: number;
  team_a: number;
  team_h_score: number | null;
  team_a_score: number | null;
  started: boolean;
  finished: boolean;
  finished_provisional: boolean;
  minutes: number;
  stats: StatEntry[];
}

interface LiveEvent {
  type: 'goal' | 'assist' | 'yellow' | 'red' | 'save' | 'cs' | 'bonus';
  playerId: number;
  playerName: string;
  teamId: number;
  teamShort: string;
  extra?: string;
  fixtureId: number;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

function fixtureStatus(f: Fixture): string {
  if (f.finished) return 'FT';
  if (f.started) return `${f.minutes}'`;
  return '';
}

function isLive(f: Fixture): boolean {
  return f.started && !f.finished;
}

/* ── Component ─────────────────────────────────────────────────────────── */

function LiveCentreComponent() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [teams, setTeams] = useState<Map<number, Team>>(new Map());
  const [players, setPlayers] = useState<Map<number, Player>>(new Map());
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusFixture, setFocusFixture] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const bootstrapRes = await fetch('/api/bootstrap-static');
      const bootstrap = await bootstrapRes.json();

      const teamMap = new Map<number, Team>();
      if (Array.isArray(bootstrap.teams)) {
        bootstrap.teams.forEach((t: Team) => teamMap.set(t.id, t));
      }
      setTeams(teamMap);

      const playerMap = new Map<number, Player>();
      if (Array.isArray(bootstrap.elements)) {
        bootstrap.elements.forEach((p: Player) => playerMap.set(p.id, p));
      }
      setPlayers(playerMap);

      const currentGW =
        bootstrap.events?.find((e: { is_current: boolean }) => e.is_current)?.id ??
        bootstrap.events?.find((e: { is_next: boolean }) => e.is_next)?.id ??
        1;

      const fixtureRes = await fetch('/api/fixtures');
      const allFixtures: Fixture[] = await fixtureRes.json();
      const gwFixtures = Array.isArray(allFixtures)
        ? allFixtures.filter((f: Fixture) => f.event === currentGW)
        : [];
      setFixtures(gwFixtures);

      // Only build events from live fixtures
      const liveFixtures = gwFixtures.filter(isLive);
      if (liveFixtures.length > 0) {
        const events: LiveEvent[] = [];
        for (const fx of liveFixtures) {
          for (const stat of fx.stats) {
            if (stat.identifier === 'goals_scored') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'goal', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_h, teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'goal', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_a, teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
            }
            if (stat.identifier === 'assists') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'assist', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_h, teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'assist', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_a, teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
            }
            if (stat.identifier === 'yellow_cards') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'yellow', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_h, teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'yellow', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_a, teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
            }
            if (stat.identifier === 'red_cards') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'red', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_h, teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'red', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_a, teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
            }
            if (stat.identifier === 'saves') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.element);
                if (entry.value >= 3) {
                  events.push({
                    type: 'save', playerId: entry.element,
                    playerName: p?.web_name ?? `#${entry.element}`,
                    teamId: fx.team_h, teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                    extra: `${entry.value} saves`, fixtureId: fx.id,
                  });
                }
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.element);
                if (entry.value >= 3) {
                  events.push({
                    type: 'save', playerId: entry.element,
                    playerName: p?.web_name ?? `#${entry.element}`,
                    teamId: fx.team_a, teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                    extra: `${entry.value} saves`, fixtureId: fx.id,
                  });
                }
              }
            }
            if (stat.identifier === 'bonus') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'bonus', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_h, teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  extra: `${entry.value} BPS`, fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.element);
                events.push({
                  type: 'bonus', playerId: entry.element,
                  playerName: p?.web_name ?? `#${entry.element}`,
                  teamId: fx.team_a, teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  extra: `${entry.value} BPS`, fixtureId: fx.id,
                });
              }
            }
          }
        }
        setLiveEvents(events);

        // Auto-focus the single live match
        if (liveFixtures.length === 1) {
          setFocusFixture(liveFixtures[0].id);
        }
      } else {
        setLiveEvents([]);
        setFocusFixture(null);
      }

      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load live data');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchData, 30_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchData]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveEvents]);

  /* ── Loading / Error ──────────────────────────────────────────────── */

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}>
        <div className="spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding: 24, borderRadius: 12,
        background: 'rgba(255,64,64,0.08)', border: '1px solid rgba(255,64,64,0.2)',
        color: '#ff5252', fontSize: 14, textAlign: 'center',
      }}>
        {error}
      </div>
    );
  }

  const liveFixtures = fixtures.filter(isLive);
  const hasLive = liveFixtures.length > 0;

  // Determine which fixture to show
  const activeFixture = liveFixtures.find(f => f.id === focusFixture) ?? liveFixtures[0] ?? null;

  const filteredEvents = activeFixture
    ? liveEvents.filter(e => e.fixtureId === activeFixture.id)
    : [];

  /* ── No live matches ──────────────────────────────────────────────── */

  if (!hasLive || !activeFixture) {
    const upcoming = fixtures
      .filter(f => !f.started && !f.finished)
      .sort((a, b) => new Date(a.kickoff_time).getTime() - new Date(b.kickoff_time).getTime());
    const nextFixture = upcoming[0];

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: 300, gap: 20, textAlign: 'center',
      }}>
        <span className="material-symbols-outlined" style={{ fontSize: 48, color: 'var(--md-sys-color-on-surface-variant)', opacity: 0.4 }}>
          sports_soccer
        </span>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', margin: '0 0 8px' }}>
            No live matches right now
          </h2>
          <p style={{ fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)', margin: 0 }}>
            {nextFixture
              ? `Next: ${teams.get(nextFixture.team_h)?.short_name ?? '???'} vs ${teams.get(nextFixture.team_a)?.short_name ?? '???'} — ${new Date(nextFixture.kickoff_time).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
              : 'Matches for this gameweek haven\'t started yet.'
            }
          </p>
        </div>
        <button
          onClick={() => fetchData()}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--md-sys-color-on-surface-variant)',
            cursor: 'pointer',
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
          Refresh
        </button>
      </div>
    );
  }

  /* ── Live match active ────────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Controls Bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderRadius: 12, width: '100%', maxWidth: 600,
        background: 'rgba(255,0,90,0.06)', border: '1px solid rgba(255,0,90,0.15)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 12px', borderRadius: 20,
            background: 'rgba(255,0,90,0.15)', color: '#FF005A',
            fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: '#FF005A', animation: 'pulse 1.5s infinite',
            }} />
            LIVE
          </span>
          <span style={{ fontSize: 13, color: '#ffffff', fontWeight: 600 }}>
            {activeFixture.minutes}'
          </span>
        </div>
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            border: '1px solid rgba(255,255,255,0.1)',
            background: autoRefresh ? 'rgba(0,255,133,0.12)' : 'rgba(255,255,255,0.04)',
            color: autoRefresh ? '#00FF85' : 'var(--md-sys-color-on-surface-variant)',
            cursor: 'pointer',
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
            {autoRefresh ? 'sync' : 'sync_disabled'}
          </span>
          {autoRefresh ? 'Auto' : 'Off'}
        </button>
      </div>

      {/* Match switcher (only if multiple live) */}
      {liveFixtures.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {liveFixtures.map(f => {
            const home = teams.get(f.team_h);
            const away = teams.get(f.team_a);
            const isActive = f.id === activeFixture.id;
            return (
              <button
                key={f.id}
                onClick={() => setFocusFixture(f.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 16px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                  border: isActive ? '1px solid rgba(255,0,90,0.4)' : '1px solid rgba(255,255,255,0.08)',
                  background: isActive ? 'rgba(255,0,90,0.1)' : 'rgba(255,255,255,0.03)',
                  color: isActive ? '#FF005A' : 'var(--md-sys-color-on-surface-variant)',
                  cursor: 'pointer', transition: 'all 0.15s ease',
                }}
              >
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{f.minutes}'</span>
                {home?.short_name} {f.team_h_score ?? 0} - {f.team_a_score ?? 0} {away?.short_name}
              </button>
            );
          })}
        </div>
      )}

      {/* Score Card — centred */}
      <div style={{ width: '100%', maxWidth: 480 }}>
        <MatchCard
          fixture={activeFixture}
          teams={teams}
          players={players}
        />
      </div>

      {/* Events — centred */}
      <div style={{ width: '100%', maxWidth: 480 }}>
        <h2 style={{
          fontSize: 14, fontWeight: 700, color: '#ffffff', margin: '0 0 10px',
          display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
        }}>
          <span className="material-symbols-outlined" style={{ color: '#00FF85', fontSize: 18 }}>
            bolt
          </span>
          Events
        </h2>
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          maxHeight: 500, overflowY: 'auto',
        }}>
          {filteredEvents.length === 0 && (
            <div style={{
              textAlign: 'center', padding: 24,
              color: 'var(--md-sys-color-on-surface-variant)', fontSize: 13,
            }}>
              No events yet in this match.
            </div>
          )}
          {filteredEvents.map((ev, i) => (
            <EventRow key={`${ev.fixtureId}-${ev.type}-${ev.playerId}-${i}`} event={ev} />
          ))}
          <div ref={eventsEndRef} />
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────────── */

function MatchCard({
  fixture, teams, players,
}: {
  fixture: Fixture;
  teams: Map<number, Team>;
  players: Map<number, Player>;
}) {
  const home = teams.get(fixture.team_h);
  const away = teams.get(fixture.team_a);
  const status = fixtureStatus(fixture);

  // Goal events
  const goalEvents: Array<{ team: 'h' | 'a'; scorer: string; assister?: string }> = [];
  const goalsStat = fixture.stats.find(s => s.identifier === 'goals_scored');
  if (goalsStat) {
    for (const entry of goalsStat.h) {
      const p = players.get(entry.element);
      goalEvents.push({ team: 'h', scorer: p?.web_name ?? `#${entry.element}` });
    }
    for (const entry of goalsStat.a) {
      const p = players.get(entry.element);
      goalEvents.push({ team: 'a', scorer: p?.web_name ?? `#${entry.element}` });
    }
  }

  // Match assists to goals
  const assistStat = fixture.stats.find(s => s.identifier === 'assists');
  if (assistStat) {
    let hIdx = 0;
    let aIdx = 0;
    for (const ge of goalEvents) {
      if (ge.team === 'h' && assistStat.h[hIdx]) {
        const p = players.get(assistStat.h[hIdx].element);
        ge.assister = p?.web_name;
        hIdx++;
      } else if (ge.team === 'a' && assistStat.a[aIdx]) {
        const p = players.get(assistStat.a[aIdx].element);
        ge.assister = p?.web_name;
        aIdx++;
      }
    }
  }

  // Cards
  const yellowH = fixture.stats.find(s => s.identifier === 'yellow_cards')?.h.length ?? 0;
  const yellowA = fixture.stats.find(s => s.identifier === 'yellow_cards')?.a.length ?? 0;
  const redH = fixture.stats.find(s => s.identifier === 'red_cards')?.h.length ?? 0;
  const redA = fixture.stats.find(s => s.identifier === 'red_cards')?.a.length ?? 0;

  // Saves
  const savesStat = fixture.stats.find(s => s.identifier === 'saves');
  let totalSaves = 0;
  if (savesStat) {
    for (const entry of savesStat.h) totalSaves += entry.value;
    for (const entry of savesStat.a) totalSaves += entry.value;
  }

  const hasCards = (yellowH + yellowA + redH + redA) > 0;

  return (
    <div style={{
      borderRadius: 14, overflow: 'hidden',
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
    }}>
      {/* Status bar */}
      <div style={{
        padding: '8px 16px', display: 'flex', justifyContent: 'center', alignItems: 'center',
        background: 'rgba(255,0,90,0.08)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <span style={{
          fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#FF005A',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#FF005A', animation: 'pulse 1.5s infinite',
          }} />
          {status}
        </span>
      </div>

      {/* Score — centred */}
      <div style={{ padding: '20px 16px 16px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
          <div style={{ textAlign: 'right', minWidth: 60 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#ffffff' }}>
              {home?.short_name ?? '???'}
            </div>
          </div>
          <div style={{
            fontSize: 36, fontWeight: 800, fontFamily: 'var(--font-mono)',
            color: '#FF005A', minWidth: 80,
          }}>
            {fixture.team_h_score ?? 0} - {fixture.team_a_score ?? 0}
          </div>
          <div style={{ textAlign: 'left', minWidth: 60 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#ffffff' }}>
              {away?.short_name ?? '???'}
            </div>
          </div>
        </div>

        {/* Goals detail — centred */}
        {goalEvents.length > 0 && (
          <div style={{
            marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6,
            alignItems: 'center',
          }}>
            {goalEvents.map((ge, i) => (
              <div key={i} style={{
                fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'center',
              }}>
                <span style={{ color: '#00FF85' }}>⚽</span>{' '}
                <span style={{ color: '#ffffff', fontWeight: 600 }}>{ge.scorer}</span>
                {ge.assister && (
                  <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
                    {' '}(ast: {ge.assister})
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Stats row — centred */}
        {(hasCards || totalSaves > 0) && (
          <div style={{
            display: 'flex', justifyContent: 'center', gap: 16, marginTop: 14,
            fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)',
          }}>
            {yellowH + yellowA > 0 && <span>🟨 {yellowH + yellowA}</span>}
            {redH + redA > 0 && <span>🟥 {redH + redA}</span>}
            {totalSaves > 0 && <span>🧤 {totalSaves} saves</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: LiveEvent }) {
  const icons: Record<LiveEvent['type'], { emoji: string; color: string; bg: string }> = {
    goal: { emoji: '⚽', color: '#00FF85', bg: 'rgba(0,255,133,0.08)' },
    assist: { emoji: '🅰️', color: '#00BFFF', bg: 'rgba(0,191,255,0.08)' },
    yellow: { emoji: '🟨', color: '#FFD700', bg: 'rgba(255,215,0,0.08)' },
    red: { emoji: '🟥', color: '#FF4444', bg: 'rgba(255,68,68,0.08)' },
    save: { emoji: '🧤', color: '#FF9800', bg: 'rgba(255,152,0,0.08)' },
    cs: { emoji: '🧹', color: '#00FF85', bg: 'rgba(0,255,133,0.08)' },
    bonus: { emoji: '⭐', color: '#FFA600', bg: 'rgba(255,166,0,0.08)' },
  };

  const labels: Record<LiveEvent['type'], string> = {
    goal: 'GOAL',
    assist: 'ASSIST',
    yellow: 'YELLOW CARD',
    red: 'RED CARD',
    save: 'SAVE MILESTONE',
    cs: 'CLEAN SHEET',
    bonus: 'BONUS',
  };

  const { emoji, color, bg } = icons[event.type];

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '12px 16px', borderRadius: 10,
      background: bg, border: `1px solid ${color}22`,
      textAlign: 'center',
    }}>
      <span style={{ fontSize: 20, marginBottom: 4 }}>{emoji}</span>
      <span style={{
        fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
        color, letterSpacing: '0.06em', marginBottom: 4,
      }}>
        {labels[event.type]}
      </span>
      <div style={{
        fontSize: 14, fontWeight: 700, color: '#ffffff',
      }}>
        {event.playerName}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginTop: 4,
      }}>
        <span style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 4,
          background: 'rgba(255,255,255,0.06)',
          color: 'var(--md-sys-color-on-surface-variant)',
          fontFamily: 'var(--font-mono)', fontWeight: 600,
        }}>
          {event.teamShort}
        </span>
        {event.extra && (
          <span style={{
            fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)',
          }}>
            {event.extra}
          </span>
        )}
      </div>
    </div>
  );
}

export const LiveCentre = memo(LiveCentreComponent);
