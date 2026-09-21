// Components partners embed. Each needs a CapitalProvider from @stacks-capital/react above it.
export { EarnComparison, PositionsSummary, QuoteSummary, WorkflowHistory } from "./widgets.tsx";
export { Amount, Panel, StateNote, Unavailable } from "./primitives.tsx";

// The rules the components follow, usable without React.
export {
  type BorrowAction,
  type BorrowInputs,
  type BorrowProjection,
  deltasFor,
  nextBorrowStep,
  oracleProvenance,
  projectBorrow,
  quoteSafety,
  QUOTE_ACTION,
} from "./borrow.ts";
export {
  addRates,
  type Comparison,
  type ComparisonGroup,
  type ComparisonRow,
  compareEarn,
  compareRates,
  formatRate,
  GROUPING_NOTE,
  type Rate,
} from "./compare.ts";
export {
  canSign,
  clearPending,
  type EarnStage,
  loadPending,
  type Pending,
  pendingKey,
  type QuoteView,
  reviewQuote,
  savePending,
  type Scope as PendingScope,
  stageFor,
} from "./earn.ts";
export {
  type Available,
  type Calculated,
  type Concentration,
  type ConcentrationSlice,
  concentrationBy,
  DEFAULT_SHIFTS,
  type Scenario,
  type ScenarioAssumptions,
  scenarios,
  type Unavailable as UnavailableCalculation,
  unavailable as unavailableCalculation,
  wouldLiquidate,
} from "./exposure.ts";
export {
  type Balance,
  buildPortfolio,
  type Portfolio,
  type PortfolioRow,
  type PortfolioTotal,
  type Position as HoldingPosition,
  type RowKind,
} from "./holdings.ts";
export { type ConnectedWallet, type MessageSigner, type SignInResult, signIn } from "./session.ts";
export {
  askWallet,
  assertWalletAllowed,
  type WalletAnswer,
  encodeArgument,
  encodePostCondition,
  type PostConditionRequest,
  toWalletRequest,
  type WalletRequest,
} from "./signing.ts";
export { messageFor, type PanelState, panelState, type QueryLike, UNAVAILABLE } from "./state.ts";
export {
  canApprove,
  priceImpactBps,
  REFRESH_MARGIN_SECONDS,
  type RouteLeg,
  type SwapAssets,
  type SwapView,
  swapView,
} from "./swap.ts";
export {
  connectWallet,
  findProvider,
  findStacksAddress,
  installedWallets,
  messageSigner,
  type WalletProvider,
} from "./wallet.ts";
