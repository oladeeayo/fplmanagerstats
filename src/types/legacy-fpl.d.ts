export {};

declare global {
  interface Window {
    createFplOcrWorker: typeof import('tesseract.js').createWorker;
    FPLSquadImport: {
      matchPlayers(text: string, players: unknown[]): Array<{ playerId: number }>;
    };
    FPL: {
      state: { activeTab: string; managerId: string | null };
      init(): Promise<void>;
      initSidebar(): void;
      initDialogs(): void;
      loadTabData(tab: string): Promise<void>;
      navigateTo(tab: string): void;
    };
  }
}
