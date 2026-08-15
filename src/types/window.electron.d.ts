declare global {
  interface Window {
    electronAPI?: {
      getScreenSources: () => Promise<Array<{
        id: string;
        name: string;
        appIcon?: string | null;
        display_id?: string | null;
      }>>;
    };
  }
}

export {};
