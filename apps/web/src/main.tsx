import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { readConfig } from "./config.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");

try {
  createRoot(root).render(<App config={readConfig(import.meta.env as Record<string, string | undefined>)} />);
} catch (error) {
  root.textContent = error instanceof Error ? error.message : "The app could not start";
}
