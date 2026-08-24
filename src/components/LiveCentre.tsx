import { useEffect, useState, useCallback, useRef, memo } from 'react';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface Team {
  id: number;
  name: string;
  short_name: string;
  strength: number;
}

interface Player {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
}

interface StatEntry {
  identifier: string;
  a: Array<{ value: number }>;
  h: Array<{ value: number }>;
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

interface LiveElement {
  id: number;
  stats: {
    minutes: number;
    goals_scored: number;
    assists: number;
    clean_sheets: number;
    goals_conceded: number;
    own_goals: number;
    penalties_saved: number;
    penalties_missed: number;
    yellow_cards: number;
    red_cards: number;
    saves: number;
    bonus: number;
    bps: number;
    influence: string;
    creativity: string;
    threat: string;
    ict_index: string;
    defensive_contribution: number;
    starts: number;
    expected_goals: string;
    expected_assists: string;
    expected_goal_involvements: string;
    expected_goals_conceded: string;
    total_points: number;
  };
}

interface LiveEvent {
  type: 'goal' | 'assist' | 'yellow' | 'red' | 'defcon' | 'save' | 'cs' | 'bonus';
  minute?: number;
  playerId: number;
  playerName: string;
  teamId: number;
  teamShort: string;
  extra?: string;
  fixtureId: number;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

const POSITION_MAP: Record<number, string> = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const POSITION_COLOR: Record<string, string> = {
  GKP: '#FFD700',
  DEF: '#00BFFF',
  MID: '#FF69B4',
  FWD: '#FF4444',
};

function fixtureStatus(f: Fixture): string {
  if (f.finished) return 'FT';
  if (f.started) return `${f.minutes}'`;
  const ko = new Date(f.kickoff_time).getTime();
  const now = Date.now();
  if (ko > now) {
    const d = new Date(f.kickoff_time);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return 'NS';
}

function isLive(f: Fixture): boolean {
  return f.started && !f.finished;
}

/* ── Component ─────────────────────────────────────────────────────────── */

function LiveCentreComponent() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [liveMap, setLiveMap] = useState<Map<number, LiveElement>>(new Map());
  const [teams, setTeams] = useState<Map<number, Team>>(new Map());
  const [players, setPlayers] = useState<Map<number, Player>>(new Map());
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFixture, setSelectedFixture] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const bootstrapRes = await fetch('/api/bootstrap-static');
      const bootstrap = await bootstrapRes.json();

      const teamMap = new Map<number, Team>();
      bootstrap.teams.forEach((t: Team) => teamMap.set(t.id, t));
      setTeams(teamMap);

      const playerMap = new Map<number, Player>();
      bootstrap.elements.forEach((p: Player) => playerMap.set(p.id, p));
      setPlayers(playerMap);

      const currentGW =
        bootstrap.events.find((e: { is_current: boolean }) => e.is_current)?.id ??
        bootstrap.events.find((e: { is_next: boolean }) => e.is_next)?.id ??
        1;

      const fixtureRes = await fetch(`/api/fixtures?event=${currentGW}`);
      const fixtureData: Fixture[] = await fixtureRes.json();
      setFixtures(fixtureData);

      if (fixtureData.length > 0 && fixtureData.some(isLive)) {
        const liveRes = await fetch(`https://fantasy.premierleague.com/api/event/${currentGW}/live/`);
        const liveData = await liveRes.json();
        const lm = new Map<number, LiveElement>();
        liveData.elements.forEach((el: LiveElement) => lm.set(el.id, el));
        setLiveMap(lm);

        // Build live event feed
        const events: LiveEvent[] = [];
        for (const fx of fixtureData) {
          if (!fx.started) continue;
          for (const stat of fx.stats) {
            const isHome = (arr: Array<{ value: number }>) =>
              arr.some(() => true); // both a and h arrays use element ids
            // FPL stats use a = away, h = home
            if (stat.identifier === 'goals_scored') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'goal',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_h,
                  teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'goal',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_a,
                  teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
            }
            if (stat.identifier === 'assists') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'assist',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_h,
                  teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'assist',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_a,
                  teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
            }
            if (stat.identifier === 'yellow_cards') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'yellow',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_h,
                  teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'yellow',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_a,
                  teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
            }
            if (stat.identifier === 'red_cards') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'red',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_h,
                  teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'red',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_a,
                  teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  fixtureId: fx.id,
                });
              }
            }
            if (stat.identifier === 'saves') {
              for (const entry of stat.h) {
                const el = lm.get(entry.value);
                if (el && el.stats.saves >= 3) {
                  const p = playerMap.get(entry.value);
                  events.push({
                    type: 'save',
                    playerId: entry.value,
                    playerName: p?.web_name ?? `#${entry.value}`,
                    teamId: fx.team_h,
                    teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                    extra: `${el.stats.saves} saves`,
                    fixtureId: fx.id,
                  });
                }
              }
              for (const entry of stat.a) {
                const el = lm.get(entry.value);
                if (el && el.stats.saves >= 3) {
                  const p = playerMap.get(entry.value);
                  events.push({
                    type: 'save',
                    playerId: entry.value,
                    playerName: p?.web_name ?? `#${entry.value}`,
                    teamId: fx.team_a,
                    teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                    extra: `${el.stats.saves} saves`,
                    fixtureId: fx.id,
                  });
                }
              }
            }
            if (stat.identifier === 'bonus') {
              for (const entry of stat.h) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'bonus',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_h,
                  teamShort: teamMap.get(fx.team_h)?.short_name ?? '',
                  extra: '3 BPS',
                  fixtureId: fx.id,
                });
              }
              for (const entry of stat.a) {
                const p = playerMap.get(entry.value);
                events.push({
                  type: 'bonus',
                  playerId: entry.value,
                  playerName: p?.web_name ?? `#${entry.value}`,
                  teamId: fx.team_a,
                  teamShort: teamMap.get(fx.team_a)?.short_name ?? '',
                  extra: '3 BPS',
                  fixtureId: fx.id,
                });
              }
            }
          }
        }
        setLiveEvents(events);
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
      intervalRef.current = setInterval(fetchData, 60_000);
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

  const liveFixtures = fixtures.filter(f => f.started);
  const upcomingFixtures = fixtures.filter(f => !f.started);
  const hasLive = liveFixtures.length > 0;

  const filteredEvents = selectedFixture
    ? liveEvents.filter(e => e.fixtureId === selectedFixture)
    : liveEvents;

  /* ── Render ───────────────────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Controls Bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderRadius: 12,
        background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hasLive && (
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
          )}
          <span style={{
            fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)',
            fontFamily: 'var(--font-mono)',
          }}>
            {liveFixtures.length} in progress · {upcomingFixtures.length} upcoming
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
          {autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
        </button>
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* Match Cards Grid */}
      {liveFixtures.length > 0 && (
        <div>
          <h2 style={{
            fontSize: 16, fontWeight: 700, color: '#ffffff', margin: '0 0 12px',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span className="material-symbols-outlined" style={{ color: '#FF005A', fontSize: 20 }}>
              sports_soccer
            </span>
            In Progress
          </h2>
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
                liveMap={liveMap}
                selected={selectedFixture === f.id}
                onSelect={() => setSelectedFixture(selectedFixture === f.id ? null : f.id)}
              />
            ))}
          </div>
        </div>
      )}

      {upcomingFixtures.length > 0 && (
        <div>
          <h2 style={{
            fontSize: 16, fontWeight: 700, color: 'var(--md-sys-color-on-surface-variant)',
            margin: '0 0 12px',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
              schedule
            </span>
            Upcoming
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(upcomingFixtures.length, 3)}, 1fr)`,
            gap: 16,
          }}>
            {upcomingFixtures.map(f => (
              <MatchCard
                key={f.id}
                fixture={f}
                teams={teams}
                players={players}
                liveMap={liveMap}
                selected={selectedFixture === f.id}
                onSelect={() => setSelectedFixture(selectedFixture === f.id ? null : f.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Live Event Feed */}
      <div>
        <h2 style={{
          fontSize: 16, fontWeight: 700, color: '#ffffff', margin: '0 0 12px',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span className="material-symbols-outlined" style={{ color: '#00FF85', fontSize: 20 }}>
            bolt
          </span>
          Live Feed
          {selectedFixture && (
            <button
              onClick={() => setSelectedFixture(null)}
              style={{
                marginLeft: 8, padding: '2px 10px', borderRadius: 6,
                fontSize: 11, fontWeight: 600, border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(255,255,255,0.06)', color: 'var(--md-sys-color-on-surface-variant)',
                cursor: 'pointer',
              }}
            >
              Show all
            </button>
          )}
        </h2>
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8,
          maxHeight: 500, overflowY: 'auto',
          padding: '12px 16px', borderRadius: 12,
          background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
        }}>
          {filteredEvents.length === 0 && (
            <div style={{
              textAlign: 'center', padding: 32,
              color: 'var(--md-sys-color-on-surface-variant)', fontSize: 13,
            }}>
              {hasLive ? 'Processing live events...' : 'No live events yet. Events will appear when matches kick off.'}
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
  fixture, teams, players, liveMap, selected, onSelect,
}: {
  fixture: Fixture;
  teams: Map<number, Team>;
  players: Map<number, Player>;
  liveMap: Map<number, LiveElement>;
  selected: boolean;
  onSelect: () => void;
}) {
  const home = teams.get(fixture.team_h);
  const away = teams.get(fixture.team_a);
  const status = fixtureStatus(fixture);
  const live = isLive(fixture);
  const statusColor = live ? '#FF005A' : fixture.finished ? 'var(--md-sys-color-on-surface-variant)' : 'var(--md-sys-color-primary)';

  // Collect per-team stats from fixture
  const goalEvents: Array<{ team: 'h' | 'a'; scorer: string; assister?: string }> = [];
  for (const stat of fixture.stats) {
    if (stat.identifier === 'goals_scored') {
      for (const entry of stat.h) {
        const p = players.get(entry.value);
        goalEvents.push({ team: 'h', scorer: p?.web_name ?? '' });
      }
      for (const entry of stat.a) {
        const p = players.get(entry.value);
        goalEvents.push({ team: 'a', scorer: p?.web_name ?? '' });
      }
    }
  }
  // Match assists to goals by index
  const assistEntries = fixture.stats.find(s => s.identifier === 'assists');
  if (assistEntries) {
    let hIdx = 0;
    let aIdx = 0;
    for (const ge of goalEvents) {
      if (ge.team === 'h' && assistEntries.h[hIdx]) {
        const p = players.get(assistEntries.h[hIdx].value);
        ge.assister = p?.web_name;
        hIdx++;
      } else if (ge.team === 'a' && assistEntries.a[aIdx]) {
        const p = players.get(assistEntries.a[aIdx].value);
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

  // DEFCON - sum from live data
  let defconH = 0;
  let defconA = 0;
  for (const el of liveMap.values()) {
    const dc = el.stats.defensive_contribution;
    if (dc > 0) {
      if (players.get(el.id)?.team === fixture.team_h) defconH += dc;
      else if (players.get(el.id)?.team === fixture.team_a) defconA += dc;
    }
  }

  // Saves
  let savesH = 0;
  let savesA = 0;
  for (const el of liveMap.values()) {
    if (el.stats.saves > 0) {
      if (players.get(el.id)?.team === fixture.team_h) savesH += el.stats.saves;
      else if (players.get(el.id)?.team === fixture.team_a) savesA += el.stats.saves;
    }
  }

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
      {/* Status bar */}
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
        {fixture.kickoff_time && (
          <span style={{
            fontSize: 10, color: 'var(--md-sys-color-on-surface-variant)',
            fontFamily: 'var(--font-mono)',
          }}>
            {new Date(fixture.kickoff_time).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      {/* Score */}
      <div style={{ padding: '16px 12px 12px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          {/* Home */}
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: '#ffffff',
              marginBottom: 4,
            }}>
              {home?.short_name ?? '???'}
            </div>
          </div>

          {/* Score */}
          <div style={{
            fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-mono)',
            color: live ? '#FF005A' : '#ffffff',
            minWidth: 60,
          }}>
            {fixture.team_h_score ?? 0} - {fixture.team_a_score ?? 0}
          </div>

          {/* Away */}
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: '#ffffff',
              marginBottom: 4,
            }}>
              {away?.short_name ?? '???'}
            </div>
          </div>
        </div>

        {/* Goals detail */}
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

        {/* Mini stats row */}
        <div style={{
          display: 'flex', justifyContent: 'center', gap: 16, marginTop: 12,
          fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)',
        }}>
          {(yellowH + yellowA > 0) && (
            <span>🟨 {yellowH + yellowA}</span>
          )}
          {(redH + redA > 0) && (
            <span>🟥 {redH + redA}</span>
          )}
          {(defconH + defconA > 0) && (
            <span style={{ color: '#00BFFF' }}>
              🛡 {defconH + defconA}
            </span>
          )}
          {(savesH + savesA > 0) && (
            <span>🧤 {savesH + savesA}</span>
          )}
        </div>
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
    defcon: { emoji: '🛡', color: '#00BFFF', bg: 'rgba(0,191,255,0.08)' },
    save: { emoji: '🧤', color: '#FF9800', bg: 'rgba(255,152,0,0.08)' },
    cs: { emoji: '🧹', color: '#00FF85', bg: 'rgba(0,255,133,0.08)' },
    bonus: { emoji: '⭐', color: '#FFA600', bg: 'rgba(255,166,0,0.08)' },
  };

  const labels: Record<LiveEvent['type'], string> = {
    goal: 'GOAL',
    assist: 'ASSIST',
    yellow: 'YELLOW CARD',
    red: 'RED CARD',
    defcon: 'DEFCON',
    save: 'SAVE MILESTONE',
    cs: 'CLEAN SHEET',
    bonus: 'BONUS',
  };

  const { emoji, color, bg } = icons[event.type];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', borderRadius: 10,
      background: bg,
      border: `1px solid ${color}22`,
    }}>
      <span style={{ fontSize: 18, flexShrink: 0 }}>{emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
            color, letterSpacing: '0.04em',
          }}>
            {labels[event.type]}
          </span>
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 4,
            background: 'rgba(255,255,255,0.06)',
            color: 'var(--md-sys-color-on-surface-variant)',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
          }}>
            {event.teamShort}
          </span>
        </div>
        <div style={{
          fontSize: 13, fontWeight: 600, color: '#ffffff', marginTop: 2,
        }}>
          {event.playerName}
          {event.extra && (
            <span style={{
              marginLeft: 8, fontSize: 11, fontWeight: 500,
              color: 'var(--md-sys-color-on-surface-variant)',
            }}>
              {event.extra}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export const LiveCentre = memo(LiveCentreComponent);
