import { type CapitalClient, createClient } from "@stacks-capital/client";
import type { CapitalError, StacksNetwork } from "@stacks-capital/core";
import { CapitalProvider } from "@stacks-capital/react";
import { type ConnectedWallet, connectWallet, installedWallets, messageSigner, signIn } from "@stacks-capital/ui";
import type { WalletId } from "@stacks-capital/wallets";
import { useMemo, useState } from "react";
import { Borrow } from "./borrowScreen.tsx";
import { NETWORKS, testnetNote, type WebConfig } from "./config.ts";
import { Earn } from "./earnScreen.tsx";
import { Risk } from "./riskScreen.tsx";
import { Activity, Markets, Portfolio } from "./screens.tsx";
import { Swap } from "./swapScreen.tsx";

const TABS = ["Portfolio", "Earn", "Borrow", "Swap", "Risk", "Markets", "Activity"] as const;
type Tab = (typeof TABS)[number];

export function App({ config }: { config: WebConfig }) {
  const [tab, setTab] = useState<Tab>("Portfolio");
  const [network, setNetwork] = useState<StacksNetwork>(config.network);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [problem, setProblem] = useState<CapitalError | Error | null>(null);
  const wallets = useMemo(() => installedWallets(), []);

  const base = useMemo(
    () => createClient({ baseUrl: config.apiBaseUrl, network, clientId: config.clientId }),
    [config, network],
  );
  // The session token turns the same client into one that speaks for the signed in address.
  const client: CapitalClient = useMemo(
    () => (sessionToken === null ? base : base.withSession(sessionToken)),
    [base, sessionToken],
  );

  function selectNetwork(next: StacksNetwork) {
    if (next === network) return;
    setNetwork(next);
    setWallet(null);
    setSessionToken(null);
    setProblem(null);
  }

  async function connect(id: WalletId) {
    setProblem(null);
    try {
      const connected = await connectWallet(id, network);
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

  const testnet = testnetNote(network);

  return (
    <CapitalProvider client={client} address={wallet?.address ?? null}>
      <header className="shell">
        <h1>Capital OS</h1>
        <fieldset className="networks">
          <legend>Network</legend>
          {NETWORKS.map((name) => (
            <button
              key={name}
              type="button"
              className="network"
              aria-pressed={network === name}
              onClick={() => selectNetwork(name)}
            >
              {name}
            </button>
          ))}
        </fieldset>
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

      {testnet === null ? null : <p className="muted">{testnet}</p>}

      {problem === null ? null : (
        <p className="error" role="alert">
          {problem.message}
        </p>
      )}

      <main>
        {tab === "Portfolio" ? <Portfolio address={wallet?.address ?? null} signedIn={sessionToken !== null} /> : null}
        {tab === "Earn" ? <Earn wallet={wallet} signedIn={sessionToken !== null} /> : null}
        {tab === "Borrow" ? <Borrow wallet={wallet} signedIn={sessionToken !== null} /> : null}
        {tab === "Swap" ? <Swap wallet={wallet} signedIn={sessionToken !== null} /> : null}
        {tab === "Risk" ? <Risk wallet={wallet} signedIn={sessionToken !== null} /> : null}
        {tab === "Markets" ? <Markets /> : null}
        {tab === "Activity" ? <Activity signedIn={sessionToken !== null} /> : null}
      </main>
    </CapitalProvider>
  );
}
