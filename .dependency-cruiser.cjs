/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-undeclared-dependency",
      comment: "A package may only import what its own package.json declares.",
      severity: "error",
      from: { path: "^(packages|apps|prototypes)/" },
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "core-has-no-internal-dependencies",
      comment: "core is the base every other package builds on.",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { path: "^(packages|apps)/", pathNot: "^packages/core/" },
    },
    {
      name: "packages-do-not-import-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "adapters-do-not-import-ui",
      comment: "Page 01: an adapter cannot import web UI.",
      severity: "error",
      from: { path: "^packages/adapters/" },
      to: { path: "^(apps/|packages/(ui|react)/)" },
    },
    {
      name: "web-does-not-import-adapters",
      comment: "Page 01: the web application calls public SDK methods, not adapter transaction builders.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/adapters/" },
    },
    {
      name: "no-relative-import-into-another-package",
      comment: "Import other workspace packages by name so package exports stay the only entry point.",
      severity: "error",
      from: { path: "^(packages|apps)/([^/]+)/" },
      to: { path: "^(packages|apps)/", pathNot: "^$1/$2/", dependencyTypes: ["local"] },
    },
    {
      name: "browser-packages-avoid-node-builtins",
      comment: "Page 06: browser exports must not import Node only modules.",
      severity: "error",
      from: { path: "^packages/(core|sdk|wallets|react|ui)/src/", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["core"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|node_modules)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".json"],
    },
  },
};
