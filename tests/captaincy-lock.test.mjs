import { describe, it, expect } from 'vitest';
import miscRoutes from '../src/server/routes/misc.js';

describe('Captaincy Model Deadline Locking', () => {
  it('exports getOrSaveCaptainSnapshot helper', () => {
    expect(typeof miscRoutes.getOrSaveCaptainSnapshot).toBe('function');
  });

  it('locks captaincy choice permanently when deadline has passed', async () => {
    const mockGw = 999;
    const pastDeadline = new Date(Date.now() - 3600 * 1000).toISOString();
    const bootstrapEvents = [
      { id: mockGw, deadline_time: pastDeadline }
    ];

    const initialModel = {
      gameweek: mockGw,
      generatedAt: '2026-08-15T10:58:00Z',
      modelVersion: '2.0.0',
      bestPick: { id: 1, name: 'Erling Haaland', compositeScore: 8.5 },
      differentialPick: { id: 2, name: 'Cole Palmer', compositeScore: 7.8 },
      topPicks: [
        { id: 1, name: 'Erling Haaland', compositeScore: 8.5 },
        { id: 2, name: 'Cole Palmer', compositeScore: 7.8 }
      ]
    };

    // First call at/after deadline saves initial snapshot locked
    const snapshot1 = await miscRoutes.getOrSaveCaptainSnapshot(mockGw, initialModel, bootstrapEvents);
    expect(snapshot1.bestPick.id).toBe(1);
    expect(snapshot1.bestPick.name).toBe('Erling Haaland');
    expect(snapshot1.isDeadlineLocked).toBe(true);

    // Subsequent call with different model projections (e.g. after model update) MUST return the locked choice!
    const modifiedModel = {
      gameweek: mockGw,
      generatedAt: '2026-08-15T14:00:00Z',
      modelVersion: '2.1.0',
      bestPick: { id: 3, name: 'Mohamed Salah', compositeScore: 9.9 },
      differentialPick: { id: 4, name: 'Bukayo Saka', compositeScore: 9.0 },
      topPicks: [
        { id: 3, name: 'Mohamed Salah', compositeScore: 9.9 }
      ]
    };

    const snapshot2 = await miscRoutes.getOrSaveCaptainSnapshot(mockGw, modifiedModel, bootstrapEvents);
    expect(snapshot2.bestPick.id).toBe(1);
    expect(snapshot2.bestPick.name).toBe('Erling Haaland');
    expect(snapshot2.isDeadlineLocked).toBe(true);
  });
});
