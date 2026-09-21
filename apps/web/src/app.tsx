import { type CapitalClient, createClient } from "@stacks-capital/client";
import type { CapitalError, StacksNetwork } from "@stacks-capital/core";
import { CapitalProvider, useMarkets, useWorkflows } from "@stacks-capital/react";
import {
  type ConnectedWallet,
  connectWallet,
  installedWallets,
  messageSigner,
  PositionsSummary,
  ScreenHeader,
  SHELL_NAV_TABS,
  ShellHeader,
  ShellNavigation,
  signIn,
  UnsupportedStateView,
  type ViewMode,
  WorkflowAnnouncer,
  WorkflowDrawer,
} from "@stacks-capital/ui";
import type { WalletId } from "@stacks-capital/wallets";
import { useMemo, useState } from "react";
import { Borrow } from "./borrowScreen.tsx";
import { NETWORKS, testnetNote, type WebConfig } from "./config.ts";
import { DepositBtcScreen } from "./depositBtcScreen.tsx";
import { Earn } from "./earnScreen.tsx";
import { Risk } from "./riskScreen.tsx";
import { Activity, Markets, Portfolio } from "./screens.tsx";
import { Swap } from "./swapScreen.tsx";

const NAV_TABS = SHELL_NAV_TABS;
type NavTab = (typeof NAV_TABS)[number] | "Portfolio";

function AppShell({
  network,
  setNetwork,
  tab,
  setTab,
  wallet,
  setWallet,
  sessionToken,
  setSessionToken,
  problem,
  setProblem,
  wallets,
  client,
}: {
  network: StacksNetwork;
  setNetwork: (n: StacksNetwork) => void;
  tab: NavTab;
  setTab: (t: NavTab) => void;
  wallet: ConnectedWallet | null;
  setWallet: (w: ConnectedWallet | null) => void;
  sessionToken: string | null;
  setSessionToken: (s: string | null) => void;
  problem: CapitalError | Error | null;
  setProblem: (p: CapitalError | Error | null) => void;
  wallets: readonly WalletId[];
  client: CapitalClient;
}) {
  const [mode, setMode] = useState<ViewMode>("simple");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const signedIn = sessionToken !== null;

  // Read block height from market data context
  const marketsQuery = useMarkets({ limit: 5 });
  const blockHeight = marketsQuery.data?.context?.blockHeight;

  // Workflows belong to a signed in address, so asking before sign in is refused. Same rule as positions.
  const workflowsQuery = useWorkflows({ limit: 10, enabled: signedIn });
  const recentWorkflows = (workflowsQuery.data?.items ?? []).map((wf) => ({
    id: wf.id,
    action: wf.action,
    state: wf.state,
    updatedAt: wf.updatedAt,
  }));

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
      setSessionToken(null);
      const result = await signIn(client, connected, messageSigner(id));
      if (result.ok) {
        setSessionToken(result.session.token);
      } else {
        setProblem(result.error);
      }
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
    <div className="app-container">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <WorkflowAnnouncer workflows={recentWorkflows} />
      <ShellHeader
        network={network}
        networks={NETWORKS}
        onSelectNetwork={(n) => selectNetwork(n as StacksNetwork)}
        blockHeight={blockHeight}
        address={wallet?.address ?? null}
        signedIn={signedIn}
        wallets={wallets}
        onConnect={(id) => void connect(id as WalletId)}
        onDisconnect={disconnect}
        onOpenDrawer={() => setDrawerOpen(true)}
        drawerBadgeCount={recentWorkflows.length}
      />

      <ShellNavigation
        tabs={NAV_TABS}
        activeTab={tab === "Portfolio" ? "Overview" : tab}
        onSelectTab={(selected) => setTab(selected as NavTab)}
      />

      {testnet === null ? null : (
        <aside className="panel panel-notice panel-notice-warn">
          <p className="warn">
            <strong>Testnet notice:</strong> {testnet}
          </p>
        </aside>
      )}

      {problem === null ? null : (
        <div className="panel panel-notice panel-notice-error" role="alert">
          <p className="error">{problem.message}</p>
        </div>
      )}

      <main id="main-content">
        {(tab === "Overview" || tab === "Portfolio") && (
          <>
            <ScreenHeader
              title="Your Bitcoin capital"
              subtitle="Where it sits, what it earns, what can go wrong, and what you can safely do next."
              mode={mode}
              onModeChange={setMode}
            />
            <Portfolio address={wallet?.address ?? null} signedIn={signedIn} />
            {/* The nav is fixed at the ten wireframe tabs, so the capability table lives under Overview. */}
            <Markets />
          </>
        )}

        {tab === "Deposit BTC" && (
          <>
            <ScreenHeader
              title="Deposit & Withdraw Bitcoin"
              subtitle="Move native Bitcoin to sBTC on Stacks or withdraw sBTC back to Bitcoin."
              mode={mode}
              onModeChange={setMode}
            />
            <DepositBtcScreen wallet={wallet} signedIn={signedIn} />
          </>
        )}

        {tab === "Earn" && (
          <>
            <ScreenHeader
              title="Earn marketplace"
              subtitle="Evidence-gated protocol comparison and vault supply."
              mode={mode}
              onModeChange={setMode}
            />
            <Earn wallet={wallet} signedIn={signedIn} />
          </>
        )}

        {tab === "Borrow" && (
          <>
            <ScreenHeader
              title="Borrow & Credit"
              subtitle="Isolated sBTC collateral and USDCx debt."
              mode={mode}
              onModeChange={setMode}
            />
            <Borrow wallet={wallet} signedIn={signedIn} />
          </>
        )}

        {tab === "Swap" && (
          <>
            <ScreenHeader
              title="Swap assets"
              subtitle="Bitflow routing and quote verification."
              mode={mode}
              onModeChange={setMode}
            />
            <Swap wallet={wallet} signedIn={signedIn} />
          </>
        )}

        {tab === "Liquidity" && (
          <>
            <ScreenHeader
              title="Liquidity provision"
              subtitle="Automated market maker pool deposits."
              mode={mode}
              onModeChange={setMode}
            />
            <UnsupportedStateView
              state={{
                kind: "unsupported",
                assetOrProtocol: "Bitflow Liquidity Pools",
                reason: "Live pool principals are not pinned on mainnet (Pilot Blocker B6).",
              }}
            />
          </>
        )}

        {tab === "Staking" && (
          <>
            <ScreenHeader
              title="Bitcoin Staking"
              subtitle="Stacking and yield generation."
              mode={mode}
              onModeChange={setMode}
            />
            <UnsupportedStateView
              state={{
                kind: "unsupported",
                assetOrProtocol: "Proof of Transfer (PoX) Staking",
                reason: "Stacking is deliberately disabled in Capital OS (K16 exclusion).",
              }}
            />
          </>
        )}

        {tab === "Positions" && (
          <>
            <ScreenHeader
              title="Verified positions"
              subtitle="Decoded protocol positions across vaults and markets."
              mode={mode}
              onModeChange={setMode}
            />
            <PositionsSummary signedIn={signedIn} />
          </>
        )}

        {tab === "Risk" && (
          <>
            <ScreenHeader
              title="Risk & Scenarios"
              subtitle="Concentration, stress testing, and liquidation buffers."
              mode={mode}
              onModeChange={setMode}
            />
            <Risk wallet={wallet} signedIn={signedIn} />
          </>
        )}

        {tab === "Activity" && (
          <>
            <ScreenHeader
              title="Activity & Workflows"
              subtitle="Recent transactions, workflow states, and recovery receipts."
              mode={mode}
              onModeChange={setMode}
            />
            <Activity signedIn={signedIn} />
          </>
        )}
      </main>

      <WorkflowDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} workflows={recentWorkflows} />
    </div>
  );
}

export function App({ config }: { config: WebConfig }) {
  const [tab, setTab] = useState<NavTab>("Overview");
  const [network, setNetwork] = useState<StacksNetwork>(config.network);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [problem, setProblem] = useState<CapitalError | Error | null>(null);
  const wallets = useMemo(() => installedWallets(), []);

  const base = useMemo(
    () => createClient({ baseUrl: config.apiBaseUrl, network, clientId: config.clientId }),
    [config, network],
  );

  const client: CapitalClient = useMemo(
    () => (sessionToken === null ? base : base.withSession(sessionToken)),
    [base, sessionToken],
  );

  return (
    <CapitalProvider client={client} address={wallet?.address ?? null}>
      <AppShell
        network={network}
        setNetwork={setNetwork}
        tab={tab}
        setTab={setTab}
        wallet={wallet}
        setWallet={setWallet}
        sessionToken={sessionToken}
        setSessionToken={setSessionToken}
        problem={problem}
        setProblem={setProblem}
        wallets={wallets}
        client={base}
      />
    </CapitalProvider>
  );
}
