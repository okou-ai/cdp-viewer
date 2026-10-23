export function prepareConsumer(): Promise<{
  directory: string;
  dist: string;
  receipt: {
    source: string;
    specifier: string;
    packageManager: string;
    react: string;
    lifecycleScripts: boolean;
    frozenReinstall: boolean;
    lockfileSha256: string;
    documentationLinks: boolean;
    publicTypes: boolean;
    build: boolean;
    ssr: boolean;
  };
  cleanup: () => Promise<void>;
}>;
export function writePackageReceipt(
  consumer: Awaited<ReturnType<typeof prepareConsumer>>,
): Promise<void>;
export function savePackageReceipt(): Promise<void>;
