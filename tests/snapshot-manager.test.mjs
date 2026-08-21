import { describe, it, expect, beforeEach } from 'vitest';
import snapshotManager from '../src/server/snapshotManager.js';

describe('SnapshotManager', () => {
  const mockBootstrap = {
    events: [
      {
        id: 1,
        name: 'Gameweek 1',
        deadline_time: '2026-08-15T11:00:00Z',
        is_current: true,
        is_next: false,
        finished: false,
      },
    ],
  };

  const mockFixtures = [
    {
      id: 101,
      event: 1,
      kickoff_time: '2026-08-15T12:30:00Z',
      team_h: 1,
      team_a: 2,
    },
  ];

  beforeEach(() => {
    snapshotManager.setForceMode(null);
  });

  describe('calculateSchedule', () => {
    it('correctly calculates 2m pre-deadline and 20m pre-match timing windows', () => {
      const schedule = snapshotManager.calculateSchedule(mockBootstrap, mockFixtures);
      expect(schedule).not.toBeNull();
      expect(schedule.gwId).toBe(1);

      // Deadline: 11:00:00Z
      expect(schedule.deadlineTime).toBe('2026-08-15T11:00:00.000Z');

      // 2 mins before deadline: 10:58:00Z
      expect(schedule.snapshotStartTime).toBe('2026-08-15T10:58:00.000Z');

      // First match kickoff: 12:30:00Z
      expect(schedule.firstMatchTime).toBe('2026-08-15T12:30:00.000Z');

      // 20 mins before first match: 12:10:00Z
      expect(schedule.snapshotEndTime).toBe('2026-08-15T12:10:00.000Z');
    });

    it('falls back to deadline + 90 mins if no fixture kickoff time exists', () => {
      const schedule = snapshotManager.calculateSchedule(mockBootstrap, []);
      expect(schedule).not.toBeNull();

      // Deadline: 11:00:00Z -> fallback kickoff: 12:30:00Z -> 20m before fallback kickoff: 12:10:00Z
      expect(schedule.firstMatchTime).toBe('2026-08-15T12:30:00.000Z');
      expect(schedule.snapshotEndTime).toBe('2026-08-15T12:10:00.000Z');
    });
  });

  describe('evaluateSnapshotState and Window Logic', () => {
    it('activates snapshot mode during the pre-deadline to pre-match window', async () => {
      const mockFetcher = async (url) => {
        if (url.includes('bootstrap')) return mockBootstrap;
        if (url.includes('fixtures')) return mockFixtures;
        return {};
      };

      // Mock time at 11:00:00Z (right at deadline - inside window 10:58 to 12:10)
      const realNow = Date.now;
      Date.now = () => new Date('2026-08-15T11:00:00Z').getTime();

      try {
        await snapshotManager.evaluateSnapshotState(mockFetcher);
        expect(snapshotManager.isSnapshotActive()).toBe(true);

        const status = snapshotManager.getSnapshotStatus();
        expect(status.mode).toBe('snapshot');
        expect(status.hasSnapshotData).toBe(true);
      } finally {
        Date.now = realNow;
      }
    });

    it('deactivates snapshot mode when current time is after 20 mins before first match', async () => {
      const mockFetcher = async (url) => {
        if (url.includes('bootstrap')) return mockBootstrap;
        if (url.includes('fixtures')) return mockFixtures;
        return {};
      };

      // Mock time at 12:15:00Z (after 12:10 restore time)
      const realNow = Date.now;
      Date.now = () => new Date('2026-08-15T12:15:00Z').getTime();

      try {
        await snapshotManager.evaluateSnapshotState(mockFetcher);
        expect(snapshotManager.isSnapshotActive()).toBe(false);

        const status = snapshotManager.getSnapshotStatus();
        expect(status.mode).toBe('live');
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('Force mode / Manual override', () => {
    it('allows overriding snapshot mode manually', () => {
      snapshotManager.setForceMode('snapshot');
      expect(snapshotManager.isSnapshotActive()).toBe(true);

      snapshotManager.setForceMode('live');
      expect(snapshotManager.isSnapshotActive()).toBe(false);

      snapshotManager.setForceMode(null);
    });
  });
});
