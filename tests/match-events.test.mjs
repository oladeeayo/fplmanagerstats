import { describe, it, expect } from 'vitest';
import { _internals } from '../src/server/matchEventsCache.js';

const { parseClock, parseAssist, parseScorer, normalizeEvent } = _internals;

const liveEvent = {
  id: '401879999',
  date: '2026-09-29T19:00:00.000Z',
  competitions: [
    {
      date: '2026-09-29T19:00:00.000Z',
      status: {
        clock: 4082,
        displayClock: "67'+2'",
        period: 2,
        type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, detail: '2nd Half' },
      },
      competitors: [
        {
          homeAway: 'home',
          score: '2',
          team: { id: '359', name: 'Arsenal', displayName: 'Arsenal', abbreviation: 'ARS' },
        },
        {
          homeAway: 'away',
          score: '1',
          team: { id: '366', name: 'Sunderland', displayName: 'Sunderland', abbreviation: 'SUN' },
        },
      ],
      details: [
        {
          type: { id: '70', text: 'Goal' },
          clock: { value: 900, displayValue: "15'" },
          team: { id: '359' },
          penaltyKick: false,
          ownGoal: false,
          athletesInvolved: [{ id: '231182', displayName: 'Kai Havertz' }],
        },
        {
          type: { id: '70', text: 'Goal - Own Goal' },
          clock: { value: 2720, displayValue: "45'+2'" },
          team: { id: '366' },
          ownGoal: true,
          athletesInvolved: [{ id: '999', displayName: 'Wrong Footer' }],
        },
        {
          type: { id: '94', text: 'Yellow Card' },
          clock: { value: 600, displayValue: "10'" },
          team: { id: '366' },
          athletesInvolved: [{ id: '1', displayName: 'Player A' }],
        },
        {
          type: { id: '107', text: 'Red Card' },
          clock: { value: 3000, displayValue: "50'" },
          team: { id: '359' },
          athletesInvolved: [{ id: '2', displayName: 'Player B' }],
        },
        {
          type: { id: '111', text: 'Substitution' },
          clock: { value: 2700, displayValue: "45'" },
          team: { id: '359' },
          athletesInvolved: [],
        },
      ],
    },
  ],
};

function eventWithState(state) {
  const clone = JSON.parse(JSON.stringify(liveEvent));
  clone.competitions[0].status.type = { name: `STATUS_${state}`, state, completed: state !== 'pre' };
  clone.competitions[0].details = [];
  return clone;
}

describe('worldcup26.ir match event normalisation', () => {
  it('maps provider status states to FPL-friendly statuses', () => {
    expect(normalizeEvent(eventWithState('in')).status).toBe('IN_PLAY');
    expect(normalizeEvent(eventWithState('post')).status).toBe('FINISHED');
    expect(normalizeEvent(eventWithState('pre')).status).toBe('TIMED');
  });

  it('exposes teams with provider id, name and TLA for FPL lookup', () => {
    const match = normalizeEvent(liveEvent);
    expect(match.homeTeam).toEqual({ id: 359, name: 'Arsenal', tla: 'ARS' });
    expect(match.awayTeam).toEqual({ id: 366, name: 'Sunderland', tla: 'SUN' });
    expect(match.score.fullTime).toEqual({ home: 2, away: 1 });
    expect(match.minute).toBe(67);
    expect(match.displayClock).toBe("67'+2'");
  });

  it('parses goals with minute, injury time, scorer and side', () => {
    const match = normalizeEvent(liveEvent);
    expect(match.goals).toHaveLength(1);
    expect(match.goals[0]).toMatchObject({
      minute: 15,
      injuryTime: 0,
      side: 'home',
      scorer: { name: 'Kai Havertz' },
      assist: null,
      team: { id: 359, name: 'Arsenal' },
    });
  });

  it('skips own goals because FPL awards no points for them', () => {
    const match = normalizeEvent(liveEvent);
    expect(match.goals.some(g => g.scorer?.name === 'Wrong Footer')).toBe(false);
  });

  it('keeps bookings with card type and side', () => {
    const match = normalizeEvent(liveEvent);
    expect(match.bookings).toEqual([
      expect.objectContaining({ minute: 10, card: 'YELLOW', side: 'away', player: { id: 1, name: 'Player A' } }),
      expect.objectContaining({ minute: 50, card: 'RED', side: 'home', player: { id: 2, name: 'Player B' } }),
    ]);
    expect(match.substitutions).toHaveLength(1);
  });

  it('ignores events without a home/away pair', () => {
    expect(normalizeEvent({ competitions: [] })).toBeNull();
    expect(normalizeEvent({})).toBeNull();
  });
});

describe('clock and play-by-play parsing', () => {
  it('parses regulation and stoppage clocks', () => {
    expect(parseClock("45'+2'")).toEqual({ minute: 45, injuryTime: 2 });
    expect(parseClock("90'+7'")).toEqual({ minute: 90, injuryTime: 7 });
    expect(parseClock("67'")).toEqual({ minute: 67, injuryTime: 0 });
    expect(parseClock('')).toEqual({ minute: null, injuryTime: 0 });
  });

  it('extracts the scorer from a goal description', () => {
    expect(parseScorer('Goal! Manchester City 1, Sunderland 1. Brian Brobbey (Sunderland) right footed shot. Assisted by Enzo Le Fée with a through ball.'))
      .toBe('Brian Brobbey');
  });

  it('extracts assist credits and stops before the description', () => {
    expect(parseAssist('Goal! Manchester City 1, Sunderland 1. Brian Brobbey (Sunderland) shot. Assisted by Enzo Le Fée with a through ball.'))
      .toBe('Enzo Le Fée');
    expect(parseAssist('Goal! X 1, Y 0. A Player (X) shot. Assisted by Marc Guéhi following a corner.'))
      .toBe('Marc Guéhi');
    expect(parseAssist('Assisted by Thomas Meunier.Goal confirmed following VAR Review.'))
      .toBe('Thomas Meunier');
    expect(parseAssist('Goal! X 1, Y 0. A Player (X) shot. Assisted by N. Mateta with a cross.'))
      .toBe('N. Mateta');
    expect(parseAssist('Goal! X 1, Y 0. A Player (X) shot from distance.'))
      .toBeNull();
  });
});
