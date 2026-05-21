export function healthCheck(_req, res) {
  res.json({
    status: "ok",
    message : "BBB Playwright Worker is running",
    timestamp: new Date().toISOString()
  });
}
