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
  minute: string;
  playerName: string;
  teamId: number;
  teamShort: string;
  eventType: string;
  pointsStr: string;
  points: number;
  fixtureId: number;
  sortKey: number;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

const TEAM_BADGE = (id: number) =>
  `https://resources.premierleague.com/premierleague/badges/rb/t${id}.svg`;

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
  return d.toDateString() === new Date().toDateString();
}

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
  const [hasLeague, setHasLeague] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      // Check league membership
      const leagueId = window.FPL?.state?.leagueId || localStorage.getItem('fplLeagueId');
      setHasLeague(!!leagueId);

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

      // Only today's live fixtures
      const todayLive = gwFixtures.filter(f => isLive(f) && isToday(f.kickoff_time));

      if (todayLive.length > 0) {
        const rows: FeedRow[] = [];

        for (const fx of todayLive) {
          const homeShort = teamMap.get(fx.team_h)?.short_name ?? '';
          const awayShort = teamMap.get(fx.team_a)?.short_name ?? '';

          const processEntries = (
            entries: Array<{ value: number; element: number }>,
            side: 'h' | 'a',
          ) => {
            const teamShort = side === 'h' ? homeShort : awayShort;
            const teamId = side === 'h' ? fx.team_h : fx.team_a;
            const minute = `${fx.minutes}'`;

            if (stat.identifier === 'goals_scored') {
              for (const entry of entries) {
                const p = playerMap.get(entry.element);
                rows.push({
                  minute, playerName: p?.web_name ?? `#${entry.element}`,
                  teamId, teamShort, eventType: 'Goal', pointsStr: '+5 pts',
                  points: 5, fixtureId: fx.id,
                  sortKey: fx.minutes * 10000 + rows.length,
                });
              }
            }
            if (stat.identifier === 'assists') {
              for (const entry of entries) {
                const p = playerMap.get(entry.element);
                rows.push({
                  minute, playerName: p?.web_name ?? `#${entry.element}`,
                  teamId, teamShort, eventType: 'Assist', pointsStr: '+3 pts',
                  points: 3, fixtureId: fx.id,
                  sortKey: fx.minutes * 10000 + rows.length,
                });
              }
            }
            if (stat.identifier === 'yellow_cards') {
              for (const entry of entries) {
                const p = playerMap.get(entry.element);
                rows.push({
                  minute, playerName: p?.web_name ?? `#${entry.element}`,
                  teamId, teamShort, eventType: 'Yellow Card', pointsStr: '-1 pts',
                  points: -1, fixtureId: fx.id,
                  sortKey: fx.minutes * 10000 + rows.length,
                });
              }
            }
            if (stat.identifier === 'red_cards') {
              for (const entry of entries) {
                const p = playerMap.get(entry.element);
                rows.push({
                  minute, playerName: p?.web_name ?? `#${entry.element}`,
                  teamId, teamShort, eventType: 'Red Card', pointsStr: '-3 pts',
                  points: -3, fixtureId: fx.id,
                  sortKey: fx.minutes * 10000 + rows.length,
                });
              }
            }
            if (stat.identifier === 'saves') {
              for (const entry of entries) {
                if (entry.value >= 3) {
                  const p = playerMap.get(entry.element);
                  rows.push({
                    minute, playerName: p?.web_name ?? `#${entry.element}`,
                    teamId, teamShort, eventType: `${entry.value} Saves`, pointsStr: '+1 pts',
                    points: 1, fixtureId: fx.id,
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
                  minute, playerName: p?.web_name ?? `#${entry.element}`,
                  teamId, teamShort, eventType: `${entry.value} Bonus pts`,
                  pointsStr: `+${pts} pts`, points: pts, fixtureId: fx.id,
                  sortKey: fx.minutes * 10000 + rows.length,
                });
              }
            }
          };

          for (const stat of fx.stats) {
            processEntries(stat.h, 'h');
            processEntries(stat.a, 'a');
          }
        }

        rows.sort((a, b) => b.sortKey - a.sortKey);
        setFeedRows(rows);

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

  /* ── No live ──────────────────────────────────────────────────────── */

  if (!hasLive) {
    const upcoming = fixtures
      .filter(f => !f.started && !f.finished)
      .sort((a, b) => new Date(a.kickoff_time).getTime() - new Date(b.kickoff_time).getTime());
    const next = upcoming[0];

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
            {next
              ? `Next: ${teams.get(next.team_h)?.short_name ?? '???'} vs ${teams.get(next.team_a)?.short_name ?? '???'} — ${new Date(next.kickoff_time).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
              : 'Matches for this gameweek haven\'t started yet.'
            }
          </p>
        </div>
        <button onClick={() => fetchData()} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          border: '1px solid rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.04)',
          color: 'var(--md-sys-color-on-surface-variant)', cursor: 'pointer',
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
          Refresh
        </button>
      </div>
    );
  }

  /* ── Live ─────────────────────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Controls */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderRadius: 10,
        background: 'rgba(255,0,90,0.06)', border: '1px solid rgba(255,0,90,0.15)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 10px', borderRadius: 16,
            background: 'rgba(255,0,90,0.15)', color: '#FF005A',
            fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#FF005A', animation: 'pulse 1.5s infinite',
            }} />
            LIVE
          </span>
          <span style={{ fontSize: 12, color: '#ffffff', fontWeight: 600 }}>
            {liveFixtures.length} {liveFixtures.length === 1 ? 'match' : 'matches'}
          </span>
        </div>
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
            border: '1px solid rgba(255,255,255,0.1)',
            background: autoRefresh ? 'rgba(0,255,133,0.12)' : 'rgba(255,255,255,0.04)',
            color: autoRefresh ? '#00FF85' : 'var(--md-sys-color-on-surface-variant)',
            cursor: 'pointer',
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
            {autoRefresh ? 'sync' : 'sync_disabled'}
          </span>
          {autoRefresh ? 'Auto' : 'Off'}
        </button>
      </div>

      {/* Match tabs */}
      {liveFixtures.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <MatchTab label="All" active={!selectedFixture} onClick={() => setSelectedFixture(null)} />
          {liveFixtures.map(f => (
            <MatchTab
              key={f.id}
              label={`${teams.get(f.team_h)?.short_name} ${f.team_h_score ?? 0}-${f.team_a_score ?? 0} ${teams.get(f.team_a)?.short_name}`}
              active={f.id === selectedFixture}
              onClick={() => setSelectedFixture(f.id)}
              teamH={f.team_h}
              teamA={f.team_a}
            />
          ))}
        </div>
      )}

      {/* Score Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(liveFixtures.length, 3)}, 1fr)`,
        gap: 14,
      }}>
        {liveFixtures.map(f => (
          <ScoreCard
            key={f.id}
            fixture={f}
            teams={teams}
            players={players}
            selected={selectedFixture === f.id}
            onSelect={() => setSelectedFixture(selectedFixture === f.id ? null : f.id)}
          />
        ))}
      </div>

      {/* Feed Table */}
      <div>
        <h2 style={{
          fontSize: 15, fontWeight: 700, color: '#ffffff', margin: '0 0 10px',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span className="material-symbols-outlined" style={{ color: '#00FF85', fontSize: 18 }}>bolt</span>
          My Feed
          {hasLeague && (
            <span style={{
              fontSize: 11, fontWeight: 500, color: 'var(--md-sys-color-on-surface-variant)',
            }}>
              · Impact vs league
            </span>
          )}
        </h2>

        <div style={{
          borderRadius: 12, overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.02)',
        }}>
          {/* Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '60px 1fr 1fr' + (hasLeague ? ' 80px' : ''),
            padding: '8px 16px',
            background: 'rgba(255,255,255,0.04)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
            color: 'var(--md-sys-color-on-surface-variant)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>
            <span></span>
            <span>Player</span>
            <span>Event</span>
            {hasLeague && <span style={{ textAlign: 'right' }}>Impact</span>}
          </div>

          {/* Rows */}
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {filteredRows.length === 0 && (
              <div style={{
                textAlign: 'center', padding: 28,
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
                  gridTemplateColumns: '60px 1fr 1fr' + (hasLeague ? ' 80px' : ''),
                  padding: '10px 16px',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                  fontSize: 13, alignItems: 'center',
                }}
              >
                {/* Minute */}
                <span style={{
                  fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)',
                  color: '#FF005A',
                }}>
                  {row.minute}
                </span>

                {/* Player + badge */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <img
                    src={TEAM_BADGE(row.teamId)}
                    alt={row.teamShort}
                    style={{ width: 20, height: 20, flexShrink: 0 }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: '#ffffff', fontSize: 13, lineHeight: 1.2 }}>
                      {row.playerName}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--md-sys-color-on-surface-variant)' }}>
                      {row.teamShort}
                    </div>
                  </div>
                </div>

                {/* Event */}
                <div>
                  <div style={{ fontWeight: 600, color: '#ffffff', fontSize: 13, lineHeight: 1.2 }}>
                    {row.eventType}
                  </div>
                  <div style={{
                    fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
                    color: row.points >= 0 ? '#00FF85' : '#FF4444',
                  }}>
                    {row.pointsStr}
                  </div>
                </div>

                {/* Impact */}
                {hasLeague && (
                  <span style={{
                    textAlign: 'right', fontSize: 11, fontWeight: 600,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--md-sys-color-on-surface-variant)',
                  }}>
                    —
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Small helpers ─────────────────────────────────────────────────────── */

function MatchTab({ label, active, onClick }: {
  label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600,
        border: active ? '1px solid rgba(255,0,90,0.4)' : '1px solid rgba(255,255,255,0.08)',
        background: active ? 'rgba(255,0,90,0.1)' : 'rgba(255,255,255,0.03)',
        color: active ? '#FF005A' : 'var(--md-sys-color-on-surface-variant)',
        cursor: 'pointer', fontFamily: 'var(--font-mono)',
      }}
    >
      {label}
    </button>
  );
}

/* ── Score Card ────────────────────────────────────────────────────────── */

function ScoreCard({
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
  const live = isLive(fixture);
  const status = fixtureStatus(fixture);

  // Goals
  const goals: Array<{ scorer: string; assister?: string }> = [];
  const gs = fixture.stats.find(s => s.identifier === 'goals_scored');
  const as = fixture.stats.find(s => s.identifier === 'assists');
  if (gs) {
    for (const e of gs.h) goals.push({ scorer: players.get(e.element)?.web_name ?? '' });
    for (const e of gs.a) goals.push({ scorer: players.get(e.element)?.web_name ?? '' });
  }
  if (as) {
    let hi = 0, ai = 0;
    for (const g of goals) {
      if (as.h[hi]) { g.assister = players.get(as.h[hi].element)?.web_name; hi++; }
      else if (as.a[ai]) { g.assister = players.get(as.a[ai].element)?.web_name; ai++; }
    }
  }

  const yh = fixture.stats.find(s => s.identifier === 'yellow_cards')?.h.length ?? 0;
  const ya = fixture.stats.find(s => s.identifier === 'yellow_cards')?.a.length ?? 0;
  const rh = fixture.stats.find(s => s.identifier === 'red_cards')?.h.length ?? 0;
  const ra = fixture.stats.find(s => s.identifier === 'red_cards')?.a.length ?? 0;
  const ss = fixture.stats.find(s => s.identifier === 'saves');
  let saves = 0;
  if (ss) { for (const e of ss.h) saves += e.value; for (const e of ss.a) saves += e.value; }

  return (
    <div
      onClick={onSelect}
      style={{
        borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
        background: selected ? 'rgba(0,255,133,0.06)' : 'rgba(255,255,255,0.03)',
        border: selected ? '1px solid rgba(0,255,133,0.3)' : '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Status */}
      <div style={{
        padding: '5px 12px', textAlign: 'center',
        background: live ? 'rgba(255,0,90,0.08)' : 'rgba(255,255,255,0.02)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
          color: live ? '#FF005A' : 'var(--md-sys-color-on-surface-variant)',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
          {live && <span style={{
            width: 5, height: 5, borderRadius: '50%', background: '#FF005A',
            animation: 'pulse 1.5s infinite',
          }} />}
          {status}
        </span>
      </div>

      {/* Teams + Score */}
      <div style={{ padding: '14px 10px 10px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          {/* Home */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 }}>
            <img
              src={TEAM_BADGE(fixture.team_h)}
              alt={home?.short_name}
              style={{ width: 28, height: 28 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <span style={{ fontSize: 11, fontWeight: 600, color: '#ffffff' }}>
              {home?.short_name ?? '???'}
            </span>
          </div>

          {/* Score */}
          <div style={{
            fontSize: 26, fontWeight: 800, fontFamily: 'var(--font-mono)',
            color: live ? '#FF005A' : '#ffffff', minWidth: 50,
          }}>
            {fixture.team_h_score ?? 0} - {fixture.team_a_score ?? 0}
          </div>

          {/* Away */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 }}>
            <img
              src={TEAM_BADGE(fixture.team_a)}
              alt={away?.short_name}
              style={{ width: 28, height: 28 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            <span style={{ fontSize: 11, fontWeight: 600, color: '#ffffff' }}>
              {away?.short_name ?? '???'}
            </span>
          </div>
        </div>

        {/* Goals */}
        {goals.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {goals.map((g, i) => (
              <div key={i} style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)' }}>
                ⚽ <span style={{ color: '#fff', fontWeight: 600 }}>{g.scorer}</span>
                {g.assister && <span> (ast: {g.assister})</span>}
              </div>
            ))}
          </div>
        )}

        {/* Mini stats */}
        {(yh + ya + rh + ra + saves > 0) && (
          <div style={{
            display: 'flex', justifyContent: 'center', gap: 10, marginTop: 8,
            fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)',
          }}>
            {yh + ya > 0 && <span>🟨 {yh + ya}</span>}
            {rh + ra > 0 && <span>🟥 {rh + ra}</span>}
            {saves > 0 && <span>🧤 {saves}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export const LiveCentre = memo(LiveCentreComponent);
