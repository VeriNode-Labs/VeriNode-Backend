const http = require("http");
const setupGracefulShutdown = require("./shutdown");
const server = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("done");
  }, 1000);
});
setupGracefulShutdown(server, {
  drainTimeout: 3000,
  persistTimeout: 2000,
  forceTimeout: 6000,
  onPersist: async () => {}
});
server.listen(0, () => {
  const port = server.address().port;
  http.get("http://localhost:" + port, (res) => {
    res.on("data", () => {});
    res.on("end", () => process.exit(0));
  });
  setTimeout(() => process.emit("SIGTERM"), 200);
});
