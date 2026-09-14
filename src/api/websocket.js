import { WebSocketServer } from "ws";

export function attachWebSocket(httpServer, { path = "/stream", heartbeatMs = 30_000 } = {}) {
  const wss = new WebSocketServer({ server: httpServer, path });
  const clients = new Set();
  const heartbeats = new Map();

  wss.on("connection", (ws) => {
    clients.add(ws);
    heartbeats.set(ws, Date.now());
    ws.on("pong", () => heartbeats.set(ws, Date.now()));
    ws.on("close", () => {
      clients.delete(ws);
      heartbeats.delete(ws);
    });
    ws.on("error", () => {
      try {
        ws.terminate();
      } catch {
        /* noop */
      }
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const ws of heartbeats.keys()) {
      if (now - (heartbeats.get(ws) ?? now) > heartbeatMs * 2) {
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
        continue;
      }
      try {
        ws.ping();
      } catch {
        /* noop */
      }
    }
  }, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  return {
    wss,
    broadcast(payload) {
      const message = JSON.stringify(payload);
      for (const client of clients) {
        if (client.readyState === client.OPEN) client.send(message);
      }
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) {
        try {
          client.close();
        } catch {
          /* noop */
        }
      }
      wss.close();
    },
  };
}