import { useEffect, useState, useCallback, useRef, memo } from 'react';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface Team {
  id: number;
  name: string;
  short_name: string;
  code: number;
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

interface FDGoal {
  minute: number;
  injuryTime: number | null;
  scorer: { id: number; name: string } | null;
  assist: { id: number; name: string } | null;
  team: { id: number; name: string } | null;
}

interface FDBooking {
  minute: number;
  injuryTime?: number | null;
  player: { id: number; name: string } | null;
  team: { id: number; name: string } | null;
  card: string;
}

interface FDMatch {
  id: number;
  homeTeam: { id: number; name: string; tla: string };
  awayTeam: { id: number; name: string; tla: string };
  minute: number | null;
  goals: FDGoal[];
  bookings: FDBooking[];
}

interface FeedRow {
  minute: string;
  playerName: string;
  playerId?: number;
  teamId: number;
  teamCode: number;
  teamShort: string;
  eventType: string;
  pointsStr: string;
  points: number;
  fixtureId: number;
  sortKey: number;
  impact?: string;
  impactColor?: string;
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

const TEAM_BADGE = (code: number) =>
  `https://resources.premierleague.com/premierleague/badges/70/t${code}.png`;

function isLive(f: Fixture): boolean {
  return f.started && !f.finished;
}

function isToday(dateStr: string): boolean {
  return new Date(dateStr).toDateString() === new Date().toDateString();
}

// football-data.org team ID → FPL team ID mapping (2025/26 PL)
const FD_TO_FPL: Record<number, number> = {
  57: 1,   // Arsenal
  58: 2,   // Aston Villa
  1044: 3, // Bournemouth
  402: 4,  // Brentford
  397: 5,  // Brighton
  61: 6,   // Chelsea
  405: 7,  // Coventry City
  354: 8,  // Crystal Palace
  62: 9,   // Everton
  63: 10,  // Fulham
  322: 11, // Hull City
  356: 12, // Ipswich Town
  341: 13, // Leeds
  64: 14,  // Liverpool
  65: 15,  // Man City
  66: 16,  // Man Utd
  67: 17,  // Newcastle
  675: 18, // Nottingham Forest
  73: 19,  // Tottenham
  350: 20, // Sunderland
};

function findFPLTeamById(fdTeamId: number, fplTeams: Map<number, Team>): Team | undefined {
  const fplId = FD_TO_FPL[fdTeamId];
  return fplId ? fplTeams.get(fplId) : undefined;
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
  const [hasMatchEvents, setHasMatchEvents] = useState(false);
  const ownedPlayerIdsRef = useRef<Set<number>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
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

      // Fetch user's squad to determine player ownership for impact column
      try {
        const managerId = (window as any).FPL?.state?.managerId || localStorage.getItem('fplManagerId');
        console.log('[LiveCentre] managerId:', managerId, 'hasLeague:', leagueId);
        if (managerId) {
          const squadRes = await fetch(`/api/manager-squad/${managerId}?gw=${currentGW}`);
          const squadData = await squadRes.json();
          console.log('[LiveCentre] squad response:', { starting11: squadData.starting11?.length, bench: squadData.bench?.length, ids: [...(squadData.starting11 || []), ...(squadData.bench || [])].map((p: any) => p.id) });
          const owned = new Set<number>();
          [...(squadData.starting11 || []), ...(squadData.bench || [])].forEach((p: any) => {
            if (p.id) owned.add(p.id);
          });
          ownedPlayerIdsRef.current = owned;
        } else {
          ownedPlayerIdsRef.current = new Set();
        }
      } catch (e) { ownedPlayerIdsRef.current = new Set(); console.error('[LiveCentre] squad fetch error:', e); }

      const fixtureRes = await fetch('/api/fixtures?live=1');
      const allFixtures: Fixture[] = await fixtureRes.json();
      const gwFixtures = Array.isArray(allFixtures)
        ? allFixtures.filter((f: Fixture) => f.event === currentGW)
        : [];
      setFixtures(gwFixtures);

      const todayLive = gwFixtures.filter(f => isLive(f) && isToday(f.kickoff_time));

      // Try to get real event timestamps from football-data.org
      let fdMatches: FDMatch[] = [];
      try {
        const fdRes = await fetch('/api/match-events');
        const fdData = await fdRes.json();
        fdMatches = fdData.matches || [];
      } catch { /* football-data.org not available, fall back to FPL ordering */ }

      setHasMatchEvents(fdMatches.length > 0);

      if (todayLive.length > 0) {
        const rows: FeedRow[] = [];

        if (fdMatches.length > 0) {
          // Use football-data.org events with real timestamps
          for (const fdMatch of fdMatches) {
            const fplTeam = findFPLTeamById(fdMatch.homeTeam.id, teamMap)
              || findFPLTeamById(fdMatch.awayTeam.id, teamMap);
            if (!fplTeam) continue;

            // Find matching FPL fixture
            const fplFixture = todayLive.find(f =>
              (f.team_h === fplTeam.id) || (f.team_a === fplTeam.id)
            );
            if (!fplFixture) continue;

            const homeTeam = teamMap.get(fplFixture.team_h)!;
            const awayTeam = teamMap.get(fplFixture.team_a)!;

            // Build all events with real minutes
            interface Event {
              minute: number;
              injuryTime: number;
              playerName: string;
              playerId: number;
              teamId: number;
              teamCode: number;
              teamShort: string;
              eventType: string;
              points: number;
            }

            // Helper to find FPL player by full name (with accent normalization)
            const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            const findPlayerByName = (fullName: string, teamId: number): Player | undefined => {
              const normFull = normalize(fullName);
              let best: Player | undefined;
              let bestLen = 0;
              for (const [, p] of playerMap) {
                if (p.team !== teamId) continue;
                const normWeb = normalize(p.web_name);
                // Exact or substring match, prefer longest match
                if (normFull.includes(normWeb) && normWeb.length > bestLen) {
                  best = p;
                  bestLen = normWeb.length;
                }
              }
              // Fallback: check if any player's web_name contains parts of the full name
              if (!best) {
                const nameParts = normFull.split(/\s+/);
                for (const [, p] of playerMap) {
                  if (p.team !== teamId) continue;
                  const normWeb = normalize(p.web_name);
                  if (nameParts.some(part => part.length > 2 && normWeb.includes(part))) {
                    best = p;
                    break;
                  }
                }
              }
              return best;
            };

            const events: Event[] = [];

            // Convert FD team IDs to FPL team IDs for correct comparison
            const fdHomeFplId = FD_TO_FPL[fdMatch.homeTeam.id] ?? fdMatch.homeTeam.id;
            const fdAwayFplId = FD_TO_FPL[fdMatch.awayTeam.id] ?? fdMatch.awayTeam.id;

            for (const goal of fdMatch.goals) {
              const goalFplTeamId = FD_TO_FPL[goal.team?.id ?? 0] ?? goal.team?.id;
              const team = goalFplTeamId === homeTeam.id ? homeTeam : awayTeam;
              events.push({
                minute: goal.minute,
                injuryTime: goal.injuryTime ?? 0,
                playerName: scorerName,
                playerId: scorerPlayer?.id ?? 0,
                teamId: team.id, teamCode: team.code, teamShort: team.short_name,
                eventType: 'Goal', points: 5,
              });
              if (goal.assist) {
                const assistPlayer = findPlayerByName(goal.assist.name, team.id);
                events.push({
                  minute: goal.minute,
                  injuryTime: goal.injuryTime ?? 0,
                  playerName: goal.assist.name,
                  playerId: assistPlayer?.id ?? 0,
                  teamId: team.id, teamCode: team.code, teamShort: team.short_name,
                  eventType: 'Assist', points: 3,
                });
              }
            }

            for (const booking of fdMatch.bookings) {
              const bookFplTeamId = FD_TO_FPL[booking.team?.id ?? 0] ?? booking.team?.id;
              const team = bookFplTeamId === homeTeam.id ? homeTeam : awayTeam;
              const cardType = booking.card === 'RED' ? 'Red Card' : 'Yellow Card';
              const pts = booking.card === 'RED' ? -3 : -1;
              const bookPlayer = findPlayerByName(booking.player?.name ?? '', team.id);
              events.push({
                minute: booking.minute,
                injuryTime: booking.injuryTime ?? 0,
                playerName: booking.player?.name ?? 'Unknown',
                playerId: bookPlayer?.id ?? 0,
                teamId: team.id, teamCode: team.code, teamShort: team.short_name,
                eventType: cardType, points: pts,
              });
            }

            // Sort by minute then injury time
            events.sort((a, b) => a.minute - b.minute || a.injuryTime - b.injuryTime);

            console.log('[LiveCentre] FD events:', events.map(e => ({ name: e.playerName, playerId: e.playerId, teamId: e.teamId, type: e.eventType })));

            // Convert to FeedRows
            for (let i = 0; i < events.length; i++) {
              const ev = events[i];
              const minStr = ev.injuryTime > 0 ? `${ev.minute}+${ev.injuryTime}'` : `${ev.minute}'`;
              const ptsStr = ev.points >= 0 ? `+${ev.points} pts` : `${ev.points} pts`;
              const isOwned = ev.playerId > 0 && ownedPlayerIdsRef.current.has(ev.playerId);
              rows.push({
                minute: minStr,
                playerName: ev.playerName,
                playerId: ev.playerId,
                teamId: ev.teamId,
                teamCode: ev.teamCode,
                teamShort: ev.teamShort,
                eventType: ev.eventType,
                pointsStr: ptsStr,
                points: ev.points,
                fixtureId: fplFixture.id,
                sortKey: i,
                impact: isOwned ? (ev.points >= 0 ? `+${ev.points}` : `${ev.points}`) : undefined,
                impactColor: isOwned ? (ev.points >= 0 ? '#00FF85' : '#FF4444') : undefined,
              });
            }
          }
        } else {
          // Fallback: use FPL fixture stats in API order
          for (const fx of todayLive) {
            const home = teamMap.get(fx.team_h);
            const away = teamMap.get(fx.team_a);
            const minute = `${fx.minutes}'`;

            const makeRow = (
              playerName: string, playerId: number, teamId: number, teamCode: number, teamShort: string,
              eventType: string, pointsStr: string, points: number,
            ): FeedRow => {
              const isOwned = playerId > 0 && ownedPlayerIdsRef.current.has(playerId);
              return {
                minute, playerName, playerId, teamId, teamCode, teamShort,
                eventType, pointsStr, points,
                fixtureId: fx.id, sortKey: rows.length,
                impact: isOwned ? (points >= 0 ? `+${points}` : `${points}`) : undefined,
                impactColor: isOwned ? (points >= 0 ? '#00FF85' : '#FF4444') : undefined,
              };
            };

            const gs = fx.stats.find(s => s.identifier === 'goals_scored');
            const as = fx.stats.find(s => s.identifier === 'assists');
            const yc = fx.stats.find(s => s.identifier === 'yellow_cards');
            const rc = fx.stats.find(s => s.identifier === 'red_cards');
            const sv = fx.stats.find(s => s.identifier === 'saves');
            const bn = fx.stats.find(s => s.identifier === 'bonus');

            const maxGoals = Math.max(gs?.h.length ?? 0, gs?.a.length ?? 0);
            for (let i = 0; i < maxGoals; i++) {
              if (gs?.h[i]) {
                const p = playerMap.get(gs.h[i].element);
                const t = home!;
                rows.push(makeRow(p?.web_name ?? '', p?.id ?? 0, t.id, t.code, t.short_name, 'Goal', '+5 pts', 5));
              }
              if (as?.h[i]) {
                const p = playerMap.get(as.h[i].element);
                const t = home!;
                rows.push(makeRow(p?.web_name ?? '', p?.id ?? 0, t.id, t.code, t.short_name, 'Assist', '+3 pts', 3));
              }
              if (gs?.a[i]) {
                const p = playerMap.get(gs.a[i].element);
                const t = away!;
                rows.push(makeRow(p?.web_name ?? '', p?.id ?? 0, t.id, t.code, t.short_name, 'Goal', '+5 pts', 5));
              }
              if (as?.a[i]) {
                const p = playerMap.get(as.a[i].element);
                const t = away!;
                rows.push(makeRow(p?.web_name ?? '', p?.id ?? 0, t.id, t.code, t.short_name, 'Assist', '+3 pts', 3));
              }
            }

            const processCard = (entries: Array<{ value: number; element: number }>, side: 'h' | 'a', type: string, pts: number, ptsStr: string) => {
              const team = side === 'h' ? home! : away!;
              for (const entry of entries) {
                const p = playerMap.get(entry.element);
                rows.push(makeRow(p?.web_name ?? '', p?.id ?? 0, team.id, team.code, team.short_name, type, ptsStr, pts));
              }
            };
            if (yc) { processCard(yc.h, 'h', 'Yellow Card', -1, '-1 pts'); processCard(yc.a, 'a', 'Yellow Card', -1, '-1 pts'); }
            if (rc) { processCard(rc.h, 'h', 'Red Card', -3, '-3 pts'); processCard(rc.a, 'a', 'Red Card', -3, '-3 pts'); }

            if (sv) {
              for (const side of ['h', 'a'] as const) {
                const team = side === 'h' ? home! : away!;
                for (const entry of (side === 'h' ? sv.h : sv.a)) {
                  if (entry.value >= 3) {
                    const p = playerMap.get(entry.element);
                    rows.push(makeRow(p?.web_name ?? '', p?.id ?? 0, team.id, team.code, team.short_name, `${entry.value} Saves`, '+1 pts', 1));
                  }
                }
              }
            }

            if (bn) {
              for (const side of ['h', 'a'] as const) {
                const team = side === 'h' ? home! : away!;
                for (const entry of (side === 'h' ? bn.h : bn.a)) {
                  const p = playerMap.get(entry.element);
                  const pts = entry.value >= 3 ? 3 : entry.value >= 2 ? 2 : 1;
                  rows.push(makeRow(p?.web_name ?? '', p?.id ?? 0, team.id, team.code, team.short_name, `${entry.value} Bonus pts`, `+${pts} pts`, pts));
                }
              }
            }
          }
        }

        setFeedRows(rows);
        if (todayLive.length === 1) setSelectedFixture(todayLive[0].id);
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

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    if (autoRefresh) intervalRef.current = setInterval(fetchData, 15_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
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
              : 'Matches for this gameweek haven\'t started yet.'}
          </p>
        </div>
        <button onClick={() => fetchData()} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)',
          color: 'var(--md-sys-color-on-surface-variant)', cursor: 'pointer',
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
          Refresh
        </button>
      </div>
    );
  }

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
          <button
            onClick={() => setSelectedFixture(null)}
            style={{
              padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600,
              border: !selectedFixture ? '1px solid rgba(255,0,90,0.4)' : '1px solid rgba(255,255,255,0.08)',
              background: !selectedFixture ? 'rgba(255,0,90,0.1)' : 'rgba(255,255,255,0.03)',
              color: !selectedFixture ? '#FF005A' : 'var(--md-sys-color-on-surface-variant)',
              cursor: 'pointer', fontFamily: 'var(--font-mono)',
            }}
          >All</button>
          {liveFixtures.map(f => {
            const home = teams.get(f.team_h);
            const away = teams.get(f.team_a);
            return (
              <button
                key={f.id}
                onClick={() => setSelectedFixture(f.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                  border: f.id === selectedFixture ? '1px solid rgba(255,0,90,0.4)' : '1px solid rgba(255,255,255,0.08)',
                  background: f.id === selectedFixture ? 'rgba(255,0,90,0.1)' : 'rgba(255,255,255,0.03)',
                  color: f.id === selectedFixture ? '#FF005A' : 'var(--md-sys-color-on-surface-variant)',
                  cursor: 'pointer', fontFamily: 'var(--font-mono)',
                }}
              >
                <img src={TEAM_BADGE(home?.code ?? 0)} style={{ width: 16, height: 16 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                {home?.short_name} {f.team_h_score ?? 0}-{f.team_a_score ?? 0} {away?.short_name}
                <img src={TEAM_BADGE(away?.code ?? 0)} style={{ width: 16, height: 16 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </button>
            );
          })}
        </div>
      )}

      {/* Score Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(liveFixtures.length, 3)}, 1fr)`,
        gap: 14,
      }}>
        {liveFixtures.map(f => (
          <ScoreCard key={f.id} fixture={f} teams={teams} players={players} />
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
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--md-sys-color-on-surface-variant)' }}>
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
            gridTemplateColumns: '50px 1fr 1fr' + (hasLeague ? ' 80px' : ''),
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
              <div style={{ textAlign: 'center', padding: 28, color: 'var(--md-sys-color-on-surface-variant)', fontSize: 13 }}>
                No events yet.
              </div>
            )}
            {filteredRows.map((row, i) => (
              <div
                key={`${row.fixtureId}-${row.playerName}-${row.eventType}-${i}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '50px 1fr 1fr' + (hasLeague ? ' 80px' : ''),
                  padding: '10px 16px',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                  fontSize: 13, alignItems: 'center',
                }}
              >
                {/* Minute */}
                <span style={{
                  fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
                  color: '#FF005A',
                }}>
                  {row.minute}
                </span>

                {/* Player + badge */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <img
                    src={TEAM_BADGE(row.teamCode)}
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
                    color: row.impact ? row.impactColor : 'var(--md-sys-color-on-surface-variant)',
                  }}>{row.impact ?? '—'}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Score Card ────────────────────────────────────────────────────────── */

function ScoreCard({
  fixture, teams, players,
}: {
  fixture: Fixture;
  teams: Map<number, Team>;
  players: Map<number, Player>;
}) {
  const home = teams.get(fixture.team_h);
  const away = teams.get(fixture.team_a);
  const live = isLive(fixture);
  const status = live ? `${fixture.minutes}'` : fixture.finished ? 'FT' : '';

  interface GoalInfo { scorer: string; assister?: string; teamSide: 'h' | 'a'; teamId: number; }
  const goals: GoalInfo[] = [];
  const gs = fixture.stats.find(s => s.identifier === 'goals_scored');
  const as = fixture.stats.find(s => s.identifier === 'assists');

  if (gs) {
    for (const e of gs.h) goals.push({ scorer: players.get(e.element)?.web_name ?? '', teamSide: 'h', teamId: fixture.team_h });
    for (const e of gs.a) goals.push({ scorer: players.get(e.element)?.web_name ?? '', teamSide: 'a', teamId: fixture.team_a });
  }
  if (as) {
    let hi = 0, ai = 0;
    for (const g of goals) {
      if (g.teamSide === 'h' && as.h[hi]) { g.assister = players.get(as.h[hi].element)?.web_name; hi++; }
      else if (g.teamSide === 'a' && as.a[ai]) { g.assister = players.get(as.a[ai].element)?.web_name; ai++; }
    }
  }

  const yh = fixture.stats.find(s => s.identifier === 'yellow_cards')?.h.length ?? 0;
  const ya = fixture.stats.find(s => s.identifier === 'yellow_cards')?.a.length ?? 0;
  const rh = fixture.stats.find(s => s.identifier === 'red_cards')?.h.length ?? 0;
  const ra = fixture.stats.find(s => s.identifier === 'red_cards')?.a.length ?? 0;
  const ss = fixture.stats.find(s => s.identifier === 'saves');
  let hSaves = 0, aSaves = 0;
  if (ss) { for (const e of ss.h) hSaves += e.value; for (const e of ss.a) aSaves += e.value; }

  return (
    <div style={{
      borderRadius: 12, overflow: 'hidden',
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
    }}>
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
          {live && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#FF005A', animation: 'pulse 1.5s infinite' }} />}
          {status}
        </span>
      </div>

      <div style={{ padding: '14px 10px 4px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 }}>
            <img src={TEAM_BADGE(home?.code ?? 0)} alt={home?.short_name} style={{ width: 28, height: 28 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: '#ffffff' }}>{home?.short_name ?? '???'}</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, fontFamily: 'var(--font-mono)', color: live ? '#FF005A' : '#ffffff', minWidth: 50 }}>
            {fixture.team_h_score ?? 0} - {fixture.team_a_score ?? 0}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 }}>
            <img src={TEAM_BADGE(away?.code ?? 0)} alt={away?.short_name} style={{ width: 28, height: 28 }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: '#ffffff' }}>{away?.short_name ?? '???'}</span>
          </div>
        </div>

        <div style={{ marginTop: 8, display: 'flex', gap: 12 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {goals.filter(g => g.teamSide === 'h').map((g, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)', padding: '2px 0' }}>
                <span style={{ color: '#00FF85', fontSize: 12 }}>⚽</span>
                <span style={{ color: '#ffffff', fontWeight: 700 }}>{g.scorer}</span>
                {g.assister && <span style={{ opacity: 0.7 }}>(ast: {g.assister})</span>}
              </div>
            ))}
            {(yh > 0 || rh > 0 || hSaves > 0) && (
              <div style={{ display: 'flex', gap: 10, marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)' }}>
                {yh > 0 && <span>🟨 {yh}</span>}
                {rh > 0 && <span>🟥 {rh}</span>}
                {hSaves > 0 && <span>🧤 {hSaves}</span>}
              </div>
            )}
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            {goals.filter(g => g.teamSide === 'a').map((g, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)', padding: '2px 0' }}>
                <span style={{ color: '#ffffff', fontWeight: 700 }}>{g.scorer}</span>
                {g.assister && <span style={{ opacity: 0.7 }}>(ast: {g.assister})</span>}
                <span style={{ color: '#00FF85', fontSize: 12 }}>⚽</span>
              </div>
            ))}
            {(ya > 0 || ra > 0 || aSaves > 0) && (
              <div style={{ display: 'flex', gap: 10, marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--md-sys-color-on-surface-variant)', justifyContent: 'flex-end' }}>
                {aSaves > 0 && <span>🧤 {aSaves}</span>}
                {ra > 0 && <span>🟥 {ra}</span>}
                {ya > 0 && <span>🟨 {ya}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const LiveCentre = memo(LiveCentreComponent);
