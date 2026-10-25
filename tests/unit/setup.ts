import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

const base64Descriptor = Object.getOwnPropertyDescriptor(
  Uint8Array,
  "fromBase64",
);

// HappyDOM uses Node's typed arrays; explicitly provide the required browser API.
beforeEach(() => {
  Object.defineProperty(Uint8Array, "fromBase64", {
    configurable: true,
    writable: true,
    value: (value: string) =>
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  });
});

afterEach(() => {
  cleanup();
  if (base64Descriptor)
    Object.defineProperty(Uint8Array, "fromBase64", base64Descriptor);
  else Reflect.deleteProperty(Uint8Array, "fromBase64");
});
