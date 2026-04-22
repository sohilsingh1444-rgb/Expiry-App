import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const rootEl = document.getElementById("root")!;

window.addEventListener("error", (e) => {
  rootEl.innerHTML = `<div style="padding:2rem;font-family:monospace;color:#b91c1c;background:#fef2f2;border-radius:8px;margin:2rem">
    <strong>JS Error:</strong><br/>${e.message}<br/>${e.filename}:${e.lineno}
  </div>`;
});

window.addEventListener("unhandledrejection", (e) => {
  rootEl.innerHTML = `<div style="padding:2rem;font-family:monospace;color:#b91c1c;background:#fef2f2;border-radius:8px;margin:2rem">
    <strong>Unhandled Promise Rejection:</strong><br/>${String(e.reason)}
  </div>`;
});

try {
  createRoot(rootEl).render(<App />);
} catch (err: any) {
  rootEl.innerHTML = `<div style="padding:2rem;font-family:monospace;color:#b91c1c;background:#fef2f2;border-radius:8px;margin:2rem">
    <strong>Render Error:</strong><br/>${err?.message ?? String(err)}<br/><pre>${err?.stack ?? ''}</pre>
  </div>`;
}
