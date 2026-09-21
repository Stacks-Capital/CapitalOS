import { certifyBuiltinAdapters } from "../../packages/adapters/src/index.ts";

const reports = certifyBuiltinAdapters();
process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`);
