export {};

declare global {
  interface Window {
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
