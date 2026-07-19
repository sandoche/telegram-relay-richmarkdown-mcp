export default function Home() {
  return (
    <main style={{ maxWidth: 760, margin: "64px auto", padding: "0 24px", lineHeight: 1.55 }}>
      <h1>Telegram Rich Markdown MCP</h1>
      <p>The server is running. Its MCP endpoint is protected by a secret capability URL.</p>
      <p>
        It exposes one write tool that posts Telegram Rich Markdown to one destination configured
        through environment variables.
      </p>
    </main>
  );
}
