export interface FixtureSettings {
  cdpUrl: string;
  windowA?: number;
  windowB?: number;
  second?: boolean;
  interactive?: boolean;
  paused?: boolean;
  hostForm?: boolean;
  colorSchemeA?: "light" | "dark" | "system";
  colorSchemeB?: "light" | "dark" | "system";
}

declare global {
  interface Window {
    configureViewers?: (settings: FixtureSettings) => Promise<void>;
    removeFirstViewer?: () => void;
    restoreFirstViewer?: () => void;
  }
}
