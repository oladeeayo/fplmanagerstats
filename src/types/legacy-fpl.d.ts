export {};

declare global {
  interface Window {
    FPL: {
      state: {
        activeTab: string;
        managerId: string | null;
        bootstrap?: any;
        currentGameweek?: number;
        fixtures?: any[];
        teamMap?: Record<number, any>;
        [key: string]: any;
      };
      renderGoalsScoredProjections?: () => Promise<void>;
      renderGoalsConcededProjections?: () => Promise<void>;
      init(): Promise<void>;
      initSidebar(): void;
      initSidebarCollapse(): void;
      initBottomNavOverflow(): void;
      initDialogs(): void;
      loadTabData(tab: string): Promise<void>;
      navigateTo(tab: string): void;
      setSquadView(view: string): void;
      [key: string]: any;
    };
  }

  declare function renderGoalsScoredProjections(): Promise<void>;
  declare function renderGoalsConcededProjections(): Promise<void>;
}
