import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider } from "@1sat/react";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletProvider autoReconnect>
      <App />
    </WalletProvider>
  </StrictMode>
);
