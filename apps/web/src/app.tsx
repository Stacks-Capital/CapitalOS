import { type CapitalClient, createClient } from "@stacks-capital/client";
import type { CapitalError } from "@stacks-capital/core";
import { CapitalProvider } from "@stacks-capital/react";
import type { WalletId } from "@stacks-capital/wallets";
import { useMemo, useState } from "react";
import type { WebConfig } from "./config.ts";
import { type ConnectedWallet, signIn } from "./session.ts";
import { Activity, Markets, Portfolio } from "./screens.tsx";
import { connectWallet, installedWallets, messageSigner } from "./wallet.ts";

const TABS = ["Portfolio", "Markets", "Activity"] as const;
type Tab = (typeof TABS)[number];

export function App({ config }: { config: WebConfig }) {
  const [tab, setTab] = useState<Tab>("Portfolio");
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [problem, setProblem] = useState<CapitalError | Error | null>(null);
  const wallets = useMemo(() => installedWallets(), []);

  const base = useMemo(
    () => createClient({ baseUrl: config.apiBaseUrl, network: config.network, clientId: config.clientId }),
    [config],
  );
  // The session token turns the same client into one that speaks for the signed in address.
  const client: CapitalClient = useMemo(
    () => (sessionToken === null ? base : base.withSession(sessionToken)),
    [base, sessionToken],
  );

  async function connect(id: WalletId) {
    setProblem(null);
    try {
      const connected = await connectWallet(id, config.network);
      setWallet(connected);
      // A new wallet cannot inherit the previous one's session.
      setSessionToken(null);
      const result = await signIn(base, connected, messageSigner(id));
      if (result.ok) setSessionToken(result.session.token);
      else setProblem(result.error);
    } catch (error) {
      setProblem(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function disconnect() {
    setWallet(null);
    setSessionToken(null);
    setProblem(null);
  }

  return (
    <CapitalProvider client={client} address={wallet?.address ?? null}>
      <header className="shell">
        <h1>Capital OS</h1>
        <span className="network">{config.network}</span>
        <nav>
          {TABS.map((name) => (
            <button key={name} type="button" aria-current={tab === name} onClick={() => setTab(name)}>
              {name}
            </button>
          ))}
        </nav>
        <div className="wallet">
          {wallet === null ? (
            wallets.length === 0 ? (
              <span className="muted">No Stacks wallet found. Install Leather or Xverse.</span>
            ) : (
              wallets.map((id) => (
                <button key={id} type="button" onClick={() => void connect(id)}>
                  Connect {id}
                </button>
              ))
            )
          ) : (
            <>
              <span title={wallet.address}>
                {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
              </span>
              <span className="muted">{sessionToken === null ? "not signed in" : "signed in"}</span>
              <button type="button" onClick={disconnect}>
                Disconnect
              </button>
            </>
          )}
        </div>
      </header>

      {problem === null ? null : (
        <p className="error" role="alert">
          {problem.message}
        </p>
      )}

      <main>
        {tab === "Portfolio" ? <Portfolio address={wallet?.address ?? null} /> : null}
        {tab === "Markets" ? <Markets /> : null}
        {tab === "Activity" ? <Activity signedIn={sessionToken !== null} /> : null}
      </main>
    </CapitalProvider>
  );
}
