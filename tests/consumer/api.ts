export interface FixtureSettings {
  cdpUrl: string;
  windowA?: number;
  windowB?: number;
  second?: boolean;
  interactive?: boolean;
  paused?: boolean;
}

declare global {
  interface Window {
    configureViewers?: (settings: FixtureSettings) => Promise<void>;
    removeFirstViewer?: () => void;
    restoreFirstViewer?: () => void;
  }
}
