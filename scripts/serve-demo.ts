import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL("../demo-dist/", import.meta.url);
const config = JSON.parse(
  await readFile(new URL("vercel.json", root), "utf8"),
) as {
  headers: { headers: { key: string; value: string }[] }[];
};
const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  const path = new URL(request.url ?? "/", "http://127.0.0.1:4173").pathname;
  const file =
    path === "/" || path === "/index.html"
      ? "index.html"
      : path === "/demo.js"
        ? "demo.js"
        : null;
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(file, root));
    for (const group of config.headers)
      for (const header of group.headers)
        response.setHeader(header.key, header.value);
    response.setHeader(
      "Content-Type",
      file.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "text/javascript; charset=utf-8",
    );
    response.writeHead(200).end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(503).end("Build the browser demo first.");
  }
});
server.listen(4173, "127.0.0.1", () => {
  process.stdout.write("Scripted browser demo at http://127.0.0.1:4173\n");
});
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
