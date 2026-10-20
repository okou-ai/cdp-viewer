export function prepareConsumer(): Promise<{
  directory: string;
  dist: string;
  cleanup: () => Promise<void>;
}>;
export function savePackageReceipt(): Promise<void>;
