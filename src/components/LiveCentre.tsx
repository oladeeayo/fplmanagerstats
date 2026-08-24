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

interface FeedRow {
  time: string;
  playerName: string;
  teamShort: string;
  eventType: string;
  pointsStr: string;
  points: number;
  fixtureId: number;
  sortKey: number;
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

function isToday(dateStr: string): boolean {
  const d = new Date(dateStr);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

/** Points the FPL system awards for each event type */
const EVENT_POINTS: Record<string, number> = {
  goal: 5,       // depends on position, but 5 is a rough mid
  assist: 3,
  yellow: -1,
  red: -3,
  save: 1,       // per 3 saves = 1 pt, we show per-save
  bonus: 0,      // value is BPS count, bonus pts are 3/2/1
};

/* ── Component ─────────────────────────────────────────────────────────── */

function LiveCentreComponent() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [teams, setTeams] = useState<Map<number, Team>>(new Map());
  const [players, setPlayers] = useState<Map<number, Player>>(new Map());
  const [feedRows, setFeedRows] = useState<FeedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFixture, setSelectedFixture] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [hasManager, setHasManager] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      // Check if manager is connected
      const managerId = window.FPL?.state?.managerId || localStorage.getItem('fplManagerId');
      setHasManager(!!managerId);

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

      const fixtureRes = await fetch('/api/fixtures?live=1');
      const allFixtures: Fixture[] = await fixtureRes.json();
      const gwFixtures = Array.isArray(allFixtures)
        ? allFixtures.filter((f: Fixture) => f.event === currentGW)
        : [];
      setFixtures(gwFixtures);

      // Only live fixtures that are today
      const liveFixtures = gwFixtures.filter(f => isLive(f));
      const todayLive = liveFixtures.filter(f => isToday(f.kickoff_time));

      if (todayLive.length > 0) {
        const rows: FeedRow[] = [];

        for (const fx of todayLive) {
          const homeShort = teamMap.get(fx.team_h)?.short_name ?? '';
          const awayShort = teamMap.get(fx.team_a)?.short_name ?? '';

          for (const stat of fx.stats) {
            const processEntries = (
              entries: Array<{ value: number; element: number }>,
              side: 'h' | 'a',
            ) => {
              const teamShort = side === 'h' ? homeShort : awayShort;
              const teamId = side === 'h' ? fx.team_h : fx.team_a;

              if (stat.identifier === 'goals_scored') {
                for (const entry of entries) {
                  const p = playerMap.get(entry.element);
                  rows.push({
                    time: new Date(fx.kickoff_time).toLocaleString([], {
                      weekday: 'short', hour: '2-digit', minute: '2-digit',
                      month: 'short', day: 'numeric',
                    }),
                    playerName: p?.web_name ?? `#${entry.element}`,
                    teamShort,
                    eventType: 'Goal',
                    pointsStr: '+5 pts',
                    points: 5,
                    fixtureId: fx.id,
                    sortKey: fx.minutes * 10000 + rows.length,
                  });
                }
              }
              if (stat.identifier === 'assists') {
                for (const entry of entries) {
                  const p = playerMap.get(entry.element);
                  rows.push({
                    time: new Date(fx.kickoff_time).toLocaleString([], {
                      weekday: 'short', hour: '2-digit', minute: '2-digit',
                      month: 'short', day: 'numeric',
                    }),
                    playerName: p?.web_name ?? `#${entry.element}`,
                    teamShort,
                    eventType: 'Assist',
                    pointsStr: '+3 pts',
                    points: 3,
                    fixtureId: fx.id,
                    sortKey: fx.minutes * 10000 + rows.length,
                  });
                }
              }
              if (stat.identifier === 'yellow_cards') {
                for (const entry of entries) {
                  const p = playerMap.get(entry.element);
                  rows.push({
                    time: new Date(fx.kickoff_time).toLocaleString([], {
                      weekday: 'short', hour: '2-digit', minute: '2-digit',
                      month: 'short', day: 'numeric',
                    }),
                    playerName: p?.web_name ?? `#${entry.element}`,
                    teamShort,
                    eventType: 'Yellow Card',
                    pointsStr: '-1 pts',
                    points: -1,
                    fixtureId: fx.id,
                    sortKey: fx.minutes * 10000 + rows.length,
                  });
                }
              }
              if (stat.identifier === 'red_cards') {
                for (const entry of entries) {
                  const p = playerMap.get(entry.element);
                  rows.push({
                    time: new Date(fx.kickoff_time).toLocaleString([], {
                      weekday: 'short', hour: '2-digit', minute: '2-digit',
                      month: 'short', day: 'numeric',
                    }),
                    playerName: p?.web_name ?? `#${entry.element}`,
                    teamShort,
                    eventType: 'Red Card',
                    pointsStr: '-3 pts',
                    points: -3,
                    fixtureId: fx.id,
                    sortKey: fx.minutes * 10000 + rows.length,
                  });
                }
              }
              if (stat.identifier === 'saves') {
                for (const entry of entries) {
                  if (entry.value >= 3) {
                    const p = playerMap.get(entry.element);
                    rows.push({
                      time: new Date(fx.kickoff_time).toLocaleString([], {
                        weekday: 'short', hour: '2-digit', minute: '2-digit',
                        month: 'short', day: 'numeric',
                      }),
                      playerName: p?.web_name ?? `#${entry.element}`,
                      teamShort,
                      eventType: `${entry.value} Saves`,
                      pointsStr: '+1 pts',
                      points: 1,
                      fixtureId: fx.id,
                      sortKey: fx.minutes * 10000 + rows.length,
                    });
                  }
                }
              }
              if (stat.identifier === 'bonus') {
                for (const entry of entries) {
                  const p = playerMap.get(entry.element);
                  const pts = entry.value >= 3 ? 3 : entry.value >= 2 ? 2 : 1;
                  rows.push({
                    time: new Date(fx.kickoff_time).toLocaleString([], {
                      weekday: 'short', hour: '2-digit', minute: '2-digit',
                      month: 'short', day: 'numeric',
                    }),
                    playerName: p?.web_name ?? `#${entry.element}`,
                    teamShort,
                    eventType: `${entry.value} Bonus pts`,
                    pointsStr: `+${pts} pts`,
                    points: pts,
                    fixtureId: fx.id,
                    sortKey: fx.minutes * 10000 + rows.length,
                  });
                }
              }
            };

            processEntries(stat.h, 'h');
            processEntries(stat.a, 'a');
          }
        }

        // Sort by match minute (most recent first)
        rows.sort((a, b) => b.sortKey - a.sortKey);
        setFeedRows(rows);

        // Auto-focus the single live match
        if (todayLive.length === 1) {
          setSelectedFixture(todayLive[0].id);
        }
      } else {
        setFeedRows([]);
        setSelectedFixture(null);
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
      intervalRef.current = setInterval(fetchData, 15_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchData]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [feedRows]);

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

  const liveFixtures = fixtures.filter(f => isLive(f) && isToday(f.kickoff_time));
  const hasLive = liveFixtures.length > 0;

  const filteredRows = selectedFixture
    ? feedRows.filter(r => r.fixtureId === selectedFixture)
    : feedRows;

  /* ── No live matches ──────────────────────────────────────────────── */

  if (!hasLive) {
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

  /* ── Live matches active ──────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Controls Bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderRadius: 12,
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
            {liveFixtures.length} {liveFixtures.length === 1 ? 'match' : 'matches'} today
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

      {/* Match selector tabs */}
      {liveFixtures.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => setSelectedFixture(null)}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: !selectedFixture ? '1px solid rgba(255,0,90,0.4)' : '1px solid rgba(255,255,255,0.08)',
              background: !selectedFixture ? 'rgba(255,0,90,0.1)' : 'rgba(255,255,255,0.03)',
              color: !selectedFixture ? '#FF005A' : 'var(--md-sys-color-on-surface-variant)',
              cursor: 'pointer',
            }}
          >
            All
          </button>
          {liveFixtures.map(f => {
            const home = teams.get(f.team_h);
            const away = teams.get(f.team_a);
            const isActive = f.id === selectedFixture;
            return (
              <button
                key={f.id}
                onClick={() => setSelectedFixture(f.id)}
                style={{
                  padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  border: isActive ? '1px solid rgba(255,0,90,0.4)' : '1px solid rgba(255,255,255,0.08)',
                  background: isActive ? 'rgba(255,0,90,0.1)' : 'rgba(255,255,255,0.03)',
                  color: isActive ? '#FF005A' : 'var(--md-sys-color-on-surface-variant)',
                  cursor: 'pointer',
                }}
              >
                {home?.short_name} {f.team_h_score ?? 0}-{f.team_a_score ?? 0} {away?.short_name}
              </button>
            );
          })}
        </div>
      )}

      {/* Score cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(liveFixtures.length, 3)}, 1fr)`,
        gap: 16,
      }}>
        {liveFixtures.map(f => (
          <MatchCard
            key={f.id}
            fixture={f}
            teams={teams}
            players={players}
            selected={selectedFixture === f.id}
            onSelect={() => setSelectedFixture(selectedFixture === f.id ? null : f.id)}
          />
        ))}
      </div>

      {/* Event Feed Table */}
      <div>
        <h2 style={{
          fontSize: 16, fontWeight: 700, color: '#ffffff', margin: '0 0 12px',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span className="material-symbols-outlined" style={{ color: '#00FF85', fontSize: 20 }}>
            bolt
          </span>
          My Feed
          {hasManager && (
            <span style={{
              fontSize: 11, fontWeight: 500, color: 'var(--md-sys-color-on-surface-variant)',
              fontFamily: 'var(--font-mono)',
            }}>
              · Impact vs league
            </span>
          )}
        </h2>

        <div style={{
          borderRadius: 14, overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: hasManager ? '140px 1fr 1fr 90px' : '140px 1fr 1fr',
            padding: '10px 16px',
            background: 'rgba(255,255,255,0.04)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
            color: 'var(--md-sys-color-on-surface-variant)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>
            <span>Time</span>
            <span>Player</span>
            <span>Event</span>
            {hasManager && <span style={{ textAlign: 'right' }}>Impact</span>}
          </div>

          {/* Table rows */}
          <div style={{ maxHeight: 500, overflowY: 'auto' }}>
            {filteredRows.length === 0 && (
              <div style={{
                textAlign: 'center', padding: 32,
                color: 'var(--md-sys-color-on-surface-variant)', fontSize: 13,
              }}>
                No events yet.
              </div>
            )}
            {filteredRows.map((row, i) => (
              <div
                key={`${row.fixtureId}-${row.playerName}-${row.eventType}-${i}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: hasManager ? '140px 1fr 1fr 90px' : '140px 1fr 1fr',
                  padding: '12px 16px',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  fontSize: 13,
                  alignItems: 'center',
                  background: i % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent',
                }}
              >
                {/* Time */}
                <span style={{
                  fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)',
                  fontFamily: 'var(--font-mono)', lineHeight: 1.4,
                }}>
                  {row.time}
                </span>

                {/* Player + Team */}
                <span>
                  <span style={{ fontWeight: 600, color: '#ffffff' }}>
                    {row.playerName}
                  </span>
                  <br />
                  <span style={{
                    fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)',
                  }}>
                    {row.teamShort}
                  </span>
                </span>

                {/* Event */}
                <span>
                  <span style={{ fontWeight: 600, color: '#ffffff' }}>
                    {row.eventType}
                  </span>
                  <br />
                  <span style={{
                    fontSize: 11,
                    color: row.points >= 0 ? '#00FF85' : '#FF4444',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {row.pointsStr}
                  </span>
                </span>

                {/* Impact (only if manager connected) */}
                {hasManager && (
                  <span style={{
                    textAlign: 'right', fontSize: 12, fontWeight: 600,
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {/* Placeholder — real impact requires league data */}
                    <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>—</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div ref={eventsEndRef} />
      </div>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────────── */

function MatchCard({
  fixture, teams, players, selected, onSelect,
}: {
  fixture: Fixture;
  teams: Map<number, Team>;
  players: Map<number, Player>;
  selected: boolean;
  onSelect: () => void;
}) {
  const home = teams.get(fixture.team_h);
  const away = teams.get(fixture.team_a);
  const status = fixtureStatus(fixture);
  const live = isLive(fixture);
  const statusColor = live ? '#FF005A' : 'var(--md-sys-color-on-surface-variant)';

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

  const yellowH = fixture.stats.find(s => s.identifier === 'yellow_cards')?.h.length ?? 0;
  const yellowA = fixture.stats.find(s => s.identifier === 'yellow_cards')?.a.length ?? 0;
  const redH = fixture.stats.find(s => s.identifier === 'red_cards')?.h.length ?? 0;
  const redA = fixture.stats.find(s => s.identifier === 'red_cards')?.a.length ?? 0;

  const savesStat = fixture.stats.find(s => s.identifier === 'saves');
  let totalSaves = 0;
  if (savesStat) {
    for (const entry of savesStat.h) totalSaves += entry.value;
    for (const entry of savesStat.a) totalSaves += entry.value;
  }

  const hasCards = (yellowH + yellowA + redH + redA) > 0;

  return (
    <div
      onClick={onSelect}
      style={{
        borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
        background: selected ? 'rgba(0,255,133,0.06)' : 'rgba(255,255,255,0.03)',
        border: selected ? '1px solid rgba(0,255,133,0.3)' : '1px solid rgba(255,255,255,0.06)',
        transition: 'all 0.15s ease',
      }}
    >
      <div style={{
        padding: '6px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: live ? 'rgba(255,0,90,0.08)' : 'rgba(255,255,255,0.02)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <span style={{
          fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
          color: statusColor,
        }}>
          {live && <span style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: '#FF005A', marginRight: 6, animation: 'pulse 1.5s infinite',
          }} />}
          {status}
        </span>
      </div>

      <div style={{ padding: '16px 12px 12px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#ffffff', marginBottom: 4 }}>
              {home?.short_name ?? '???'}
            </div>
          </div>
          <div style={{
            fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-mono)',
            color: live ? '#FF005A' : '#ffffff',
            minWidth: 60,
          }}>
            {fixture.team_h_score ?? 0} - {fixture.team_a_score ?? 0}
          </div>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#ffffff', marginBottom: 4 }}>
              {away?.short_name ?? '???'}
            </div>
          </div>
        </div>

        {goalEvents.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {goalEvents.map((ge, i) => (
              <div key={i} style={{
                fontSize: 11, color: 'var(--md-sys-color-on-surface-variant)',
                fontFamily: 'var(--font-mono)',
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

        {(hasCards || totalSaves > 0) && (
          <div style={{
            display: 'flex', justifyContent: 'center', gap: 12, marginTop: 10,
            fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)',
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

export const LiveCentre = memo(LiveCentreComponent);
