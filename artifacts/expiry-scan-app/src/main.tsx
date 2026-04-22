import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setBaseUrl } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";

setBaseUrl(getApiBase());

const rootEl = document.getElementById("root")!;

window.addEventListener("error", (e) => {
  if (!rootEl.hasChildNodes()) {
    rootEl.innerHTML = `<div style="padding:2rem;font-family:monospace;color:#b91c1c;background:#fef2f2;border-radius:8px;margin:2rem">
      <strong>JS Error:</strong><br/>${e.message}<br/>${e.filename}:${e.lineno}
    </div>`;
  }
});

window.addEventListener("unhandledrejection", (e) => {
  if (!rootEl.hasChildNodes()) {
    rootEl.innerHTML = `<div style="padding:2rem;font-family:monospace;color:#b91c1c;background:#fef2f2;border-radius:8px;margin:2rem">
      <strong>Unhandled Promise Rejection:</strong><br/>${String(e.reason)}
    </div>`;
  }
});

createRoot(rootEl).render(<App />);
