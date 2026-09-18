import { createRoot } from "react-dom/client";
import { readEmbedConfig } from "./config.ts";
import { PartnerPage } from "./partner.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");

try {
  createRoot(root).render(
    <PartnerPage config={readEmbedConfig(import.meta.env as Record<string, string | undefined>)} />,
  );
} catch (error) {
  root.textContent = error instanceof Error ? error.message : "The page could not start";
}
