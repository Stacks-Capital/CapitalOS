import { requireNetwork } from "@stacks-capital/core";
import {
  API_SCOPES,
  type ApiScope,
  clearCapabilityOverride,
  connect,
  createApiKey,
  revokeApiKey,
  listCapabilityOverrides,
  metricsSnapshot,
  openAlerts,
  requireDatabaseUrl,
  setCapabilityOverride,
} from "@stacks-capital/database";

/*
 * Operator commands (I17).
 *
 *   pnpm ops:status  <network>
 *   pnpm ops:disable <network> <market> <action> <reason...>
 *   pnpm ops:pause   <network> <market> <action> <reason...>
 *   pnpm ops:enable  <network> <market> <action>
 *   pnpm keys:create <app id> <scope...>
 *   pnpm keys:revoke <key id>
 *
 * Switching off takes effect on the next request: market lists, earn options, quotes, plans and new
 * workflows all read the effective state. Switching back on only removes the override; it can never
 * enable something the registry itself disables.
 */

const [command, networkArg, marketId, action, ...reasonWords] = process.argv.slice(2);
const usage = "Usage: ops <status|disable|pause|enable> <network> [market] [action] [reason...]";

// Keys belong to an app, not a network, so they are handled before the network is read.
if (command === "key-create" || command === "key-revoke") {
  const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
  try {
    if (command === "key-create") {
      const appId = networkArg;
      const scopes = [marketId, action, ...reasonWords].filter((scope): scope is string => scope !== undefined);
      const unknown = scopes.filter((scope) => !(API_SCOPES as readonly string[]).includes(scope));
      if (appId === undefined || scopes.length === 0 || unknown.length > 0) {
        console.error(`Usage: keys:create <app id> <scope...>. Scopes: ${API_SCOPES.join(", ")}`);
        process.exitCode = 2;
      } else {
        const { keyId, token } = await createApiKey(sql, { appId, scopes: scopes as ApiScope[] });
        // The secret is shown once and stored only as a hash. It cannot be recovered later.
        console.log(`Created ${keyId}. Store this now, it is not shown again:\n${token}`);
      }
    } else {
      if (networkArg === undefined) {
        console.error("Usage: keys:revoke <key id>");
        process.exitCode = 2;
      } else {
        await revokeApiKey(sql, networkArg, new Date());
        console.log(`Revoked ${networkArg}. Requests with it are refused from now on.`);
      }
    }
  } finally {
    await sql.end();
  }
  process.exit();
}

if (command === undefined || networkArg === undefined) {
  console.error(usage);
  process.exit(2);
}

const network = requireNetwork(networkArg);
const sql = connect(requireDatabaseUrl(process.env.DATABASE_URL));
const operator = process.env.OPERATOR ?? process.env.USER ?? "unknown";

try {
  if (command === "status") {
    const snapshot = await metricsSnapshot(sql, { network, at: new Date(), windowSeconds: 15 * 60 });
    console.log(
      JSON.stringify(
        {
          metrics: snapshot,
          alerts: await openAlerts(sql, network),
          overrides: await listCapabilityOverrides(sql, network),
        },
        null,
        2,
      ),
    );
  } else if (command === "disable" || command === "pause") {
    if (marketId === undefined || action === undefined || reasonWords.length === 0) {
      console.error("A market, an action and a reason are all required. The reason is shown to users.");
      process.exit(2);
    }
    await setCapabilityOverride(sql, {
      network,
      marketId,
      action,
      state: command === "disable" ? "disabled" : "paused",
      reason: reasonWords.join(" "),
      setBy: operator,
      setAt: new Date(),
    });
    console.log(`${marketId} ${action} on ${network} is now ${command === "disable" ? "disabled" : "paused"}.`);
  } else if (command === "enable") {
    if (marketId === undefined || action === undefined) {
      console.error("A market and an action are required.");
      process.exit(2);
    }
    const removed = await clearCapabilityOverride(sql, { network, marketId, action });
    console.log(
      removed ? `Override removed for ${marketId} ${action}.` : `No override was set for ${marketId} ${action}.`,
    );
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
