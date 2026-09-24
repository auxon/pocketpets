import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider } from "@1sat/react";
import App from "./App";
import "./styles.css";

// A deploy replaces hashed chunks; a long-lived tab that lazily imports an
// old chunk gets a 404 from the asset server. Vite surfaces that as
// vite:preloadError — reload once so the tab picks up the new build.
window.addEventListener("vite:preloadError", (event) => {
  const key = "pocketpets.reloadedAt";
  const last = Number(sessionStorage.getItem(key) ?? 0);
  if (Date.now() - last > 60_000) {
    sessionStorage.setItem(key, String(Date.now()));
    window.location.reload();
  } else {
    event.preventDefault();
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider autoReconnect>
      <App />
    </WalletProvider>
  </StrictMode>
);
