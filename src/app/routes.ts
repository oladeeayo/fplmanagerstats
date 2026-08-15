export const appRoutes = {
  general: '/',
  manager: '/manager',
  decision: '/decision-lab',
  league: '/league',
  players: '/players',
  zones: '/tactics',
  fixtures: '/fixtures',
  captain: '/captaincy',
  ownership: '/ownership',
  setpieces: '/set-pieces',
  aiteam: '/ai-team',
} as const;

export type AppTab = keyof typeof appRoutes;

export function isAppTab(value: string | null): value is AppTab {
  return Boolean(value && value in appRoutes);
}

export function tabFromPath(pathname: string): AppTab | null {
  const match = Object.entries(appRoutes).find(([, path]) => path === pathname);
  return (match?.[0] as AppTab | undefined) ?? null;
}
