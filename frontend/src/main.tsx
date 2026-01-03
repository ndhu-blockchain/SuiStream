import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "@/app/router";
import { AppProviders } from "@/app/providers";
import { StrictMode } from "react";
import "@/index.css";
import "@mysten/dapp-kit/dist/index.css";

// Slush / window-wallet-core uses `crypto.randomUUID()`.
// Some mobile browsers/webviews don't support it, which can leave a popup stuck on `about:blank`.
(() => {
  const cryptoObj = globalThis.crypto as
    | (Crypto & { randomUUID?: () => string })
    | undefined;
  if (!cryptoObj || typeof cryptoObj.randomUUID === "function") return;

  const bytesToHex = (bytes: Uint8Array) =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  cryptoObj.randomUUID = () => {
    // Prefer cryptographically-strong randomness when available.
    const bytes = new Uint8Array(16);
    if (typeof cryptoObj.getRandomValues === "function") {
      cryptoObj.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = Math.floor(Math.random() * 256);
    }

    // RFC 4122 version 4
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
})();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>
);
