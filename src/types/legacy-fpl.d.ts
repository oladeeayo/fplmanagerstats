export {};

declare global {
  interface Window {
    createFplOcrWorker: typeof import('tesseract.js').createWorker;
    FPLSquadImport: {
      normalize(value: string): string;
      normalizeUpper(value: string): string;
      scoreLine(line: string, player: { name: string; fullName?: string }): number;
      matchPlayers(text: string, players: unknown[], limit?: number): Array<{
        line: string;
        playerId: number;
        confidence: 'high' | 'medium' | 'low' | 'confirmed';
        score: number;
        position?: string;
        price?: number;
        alternatives: Array<{ id: number; name: string; team: string; position: string; score: number }>;
      }>;
      matchPlayersFPL(text: string, players: unknown[], limit?: number): Array<{
        line: string;
        playerId: number;
        confidence: 'high' | 'medium' | 'low' | 'confirmed';
        score: number;
        position?: string;
        price?: number;
        alternatives: Array<{ id: number; name: string; team: string; position: string; score: number }>;
      }>;
      matchPlayersGeneric(text: string, players: unknown[], limit?: number): Array<{
        line: string;
        playerId: number;
        confidence: 'high' | 'medium' | 'low' | 'confirmed';
        score: number;
        position?: string;
        price?: number;
        alternatives: Array<{ id: number; name: string; team: string; position: string; score: number }>;
      }>;
      isFPLScreenshot(text: string): boolean;
      extractPrice(text: string): number | null;
      extractPosition(text: string): string | null;
      isPlayerName(text: string): boolean;
      extractPlayerCandidates(text: string): Array<{
        text: string;
        normalized: string;
        price: number | null;
        position: string | null;
        lineIndex: number;
        confidence: number;
      }>;
    };
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
      autoFillTeamBuilder(): void;
      reRollTeamBuilderAutoFill(): void;
      clearTeamBuilder(): void;
      [key: string]: any;
    };
  }

  declare function renderGoalsScoredProjections(): Promise<void>;
  declare function renderGoalsConcededProjections(): Promise<void>;
}
