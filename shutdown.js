const http = require("http");
function setupGracefulShutdown(server, options = {}) {
  const drainTimeout = options.drainTimeout || 30000;
  const persistTimeout = options.persistTimeout || 10000;
  const forceTimeout = options.forceTimeout || 60000;
  let isShuttingDown = false;
  const activeConnections = new Set();
  server.on("connection", (s) => {
    activeConnections.add(s);
    s.on("close", () => activeConnections.delete(s));
  });
  async function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    setTimeout(() => process.exit(1), forceTimeout);
    try {
      await new Promise((r) => {
        server.close(() => r());
        for (const s of activeConnections) {
          if (!s.writableEnded && s.setHeader) {
            s.setHeader("Connection", "close");
          }
        }
      });
      await new Promise((r) => {
        const t = setTimeout(() => r(), drainTimeout);
        const c = setInterval(() => {
          if (activeConnections.size === 0) {
            clearInterval(c); clearTimeout(t); r();
          }
        }, 100);
      });
      await new Promise((r, j) => {
        const t = setTimeout(() => j(), persistTimeout);
        if (options.onPersist) {
          options.onPersist().then(() => {
            clearTimeout(t); r();
          }).catch((e) => {
            clearTimeout(t); j(e);
          });
        } else {
          clearTimeout(t); r();
        }
      });
      process.exit(0);
    } catch (e) {
      process.exit(1);
    }
  }
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}
module.exports = setupGracefulShutdown;
