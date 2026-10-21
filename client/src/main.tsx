import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import "./styles.css";
import "./pages.css";
import "./game.css";

// Service worker: installs the offline shell and updates itself quietly. An installed phone app can stay
// open for days, so look for a new version whenever it comes back to the screen and once an hour;
// autoUpdate then swaps it in and reloads.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => { if (navigator.onLine) registration.update().catch(() => undefined); };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
    setInterval(check, 60 * 60 * 1000);
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
