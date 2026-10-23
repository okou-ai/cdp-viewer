import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

/** The entry owns the host DOM root; rendering stays free of resource acquisition. */
export function mountDemo(children: ReactNode): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("The demo root is missing.");
  createRoot(root).render(children);
}
