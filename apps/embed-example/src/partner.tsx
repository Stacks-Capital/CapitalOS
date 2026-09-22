import { createClient } from "@stacks-capital/client";
import { CapitalProvider } from "@stacks-capital/react";
import {
  type ConnectedWallet,
  connectWallet,
  EarnComparison,
  installedWallets,
  messageSigner,
  PositionsSummary,
  signIn,
  WorkflowHistory,
} from "@stacks-capital/ui";
import { useMemo, useState } from "react";
import type { EmbedConfig } from "./config.ts";

/**
 * A partner's own page: their header, their layout, Stacks Capital embedded in the middle.
 * It uses only the public packages: the client for the API, the hooks for state, the ui for widgets.
 * Quoting, planning and provider reads all stay behind the API (see docs/engineering/embedding.md).
 */
export function PartnerPage({ config }: { config: EmbedConfig }) {
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const base = useMemo(
    () => createClient({ baseUrl: config.apiBaseUrl, network: config.network, clientId: config.clientId }),
    [config],
  );
  const client = useMemo(() => (session === null ? base : base.withSession(session)), [base, session]);

  async function connect() {
    setProblem(null);
    const [id] = installedWallets();
    if (id === undefined) {
      setProblem("Install Leather or Xverse to continue.");
      return;
    }
    try {
      const connected = await connectWallet(id, config.network);
      setWallet(connected);
      const result = await signIn(base, connected, messageSigner(id));
      if (result.ok) setSession(result.session.token);
      else setProblem(result.error.message);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not connect");
    }
  }

  return (
    <CapitalProvider client={client} address={wallet?.address ?? null}>
      <header>
        <h1>Acme Wallet</h1>
        {wallet === null ? (
          <button type="button" onClick={() => void connect()}>
            Connect
          </button>
        ) : (
          <span>{wallet.address}</span>
        )}
      </header>
      <p>Put your sBTC to work, without leaving Acme.</p>
      {problem === null ? null : <p className="error">{problem}</p>}

      <EarnComparison />
      <PositionsSummary signedIn={session !== null} />
      <WorkflowHistory signedIn={session !== null} />

      <p className="muted">Earn data provided by Stacks Capital.</p>
    </CapitalProvider>
  );
}
