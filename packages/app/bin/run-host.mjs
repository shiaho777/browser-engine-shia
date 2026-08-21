import { startAppServer } from "../dist/server.js";

const port = Number(process.env.PORT || process.argv[2] || 7788);
const host = process.env.HOST || "127.0.0.1";

const server = await startAppServer({ host, port });
console.log(`READY ${server.url}`);

const shutdown = () => {
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// keep event loop alive
setInterval(() => {}, 60_000);
