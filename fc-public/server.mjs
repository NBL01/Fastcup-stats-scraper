import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = process.env.PORT || 5173;
const OUT_DIR = process.env.OUT_DIR || "out";
const REPORT_PATH = process.env.REPORT_PATH || path.join("public", "report.html");
const ROOT = process.cwd();
const PROFILE_FILE = path.join(OUT_DIR, "profile.json");

let state = {
  status: "idle",
  phase: "idle",
  found: 0,
  total: 0,
  done: 0,
  message: "",
  profile: "",
};

const readBody = async (req) => {
  let data = "";
  for await (const chunk of req) data += chunk;
  try {
    return JSON.parse(data || "{}");
  } catch {
    return {};
  }
};

const sendJson = (res, code, payload) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

const sendFile = async (res, filePath, contentType) => {
  try {
    const full = path.join(ROOT, filePath);
    const data = await fs.readFile(full);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
};

const normalizeInput = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) {
    return `https://cs2.fastcup.net/id${trimmed}/matches`;
  }
  if (trimmed.includes("fastcup.net")) return trimmed;
  return "";
};

const loadProfile = async () => {
  try {
    const raw = await fs.readFile(PROFILE_FILE, "utf8");
    const data = JSON.parse(raw);
    return data?.profile || "";
  } catch {
    return "";
  }
};

const saveProfile = async (profile) => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(PROFILE_FILE, JSON.stringify({ profile }, null, 2));
};

const runCommand = (cmd, args, env, onLine) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let lastLine = "";
    child.stdout.on("data", (buf) => {
      const text = buf.toString();
      text.split(/\r?\n/).forEach((line) => {
        if (line.trim()) {
          lastLine = line.trim();
          onLine?.(line);
        }
      });
    });
    child.stderr.on("data", (buf) => {
      const text = buf.toString();
      text.split(/\r?\n/).forEach((line) => {
        if (line.trim()) {
          lastLine = line.trim();
          onLine?.(line);
        }
      });
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else {
        const message = lastLine
          ? `${cmd} exited with ${code}: ${lastLine}`
          : `${cmd} exited with ${code}`;
        reject(new Error(message));
      }
    });
  });

const runPipeline = async ({ url, full, workers }) => {
  state = { status: "running", phase: "scrape", found: 0, total: 0, done: 0, message: "" };

  if (full) {
    await fs.rm(OUT_DIR, { recursive: true, force: true });
  }
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await saveProfile(url);

  await runCommand(
    "node",
    ["scrape.mjs", url, OUT_DIR, "graphql", "9999"],
    {
      SKIP_EXISTING: full ? "0" : "1",
      INCREMENTAL: full ? "0" : "1",
      SCRAPE_WORKERS: workers ? String(workers) : undefined,
    },
    (line) => {
      if (line.startsWith("PROGRESS")) {
        const parts = Object.fromEntries(
          line
            .replace("PROGRESS", "")
            .trim()
            .split(/\s+/)
            .map((item) => item.split("="))
        );
        if (parts.found) state.found = Number(parts.found) || state.found;
        if (parts.total) state.total = Number(parts.total) || state.total;
        if (parts.current) state.done = Number(parts.current) || state.done;
        if (parts.existing) state.existing = Number(parts.existing) || 0;
      }
    }
  );

  state.phase = "maps";
  await runCommand("node", ["maps.mjs", OUT_DIR], {}, () => null);

  state.phase = "report";
  await runCommand("node", ["report.mjs", OUT_DIR, "", REPORT_PATH], {}, () => null);

  state.status = "done";
  state.phase = "done";
};

const server = http.createServer(async (req, res) => {
  const { url, method } = req;
  const pathname = url.split("?")[0];
  if (pathname === "/") {
    return sendFile(res, "public/index.html", "text/html; charset=utf-8");
  }
  if (pathname === "/report.html") {
    try {
      await fs.access(path.join(ROOT, REPORT_PATH));
      return sendFile(res, REPORT_PATH, "text/html; charset=utf-8");
    } catch {
      try {
        await fs.access(path.join(ROOT, "report.html"));
        return sendFile(res, "report.html", "text/html; charset=utf-8");
      } catch {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(
          "<!doctype html><title>No report</title><body style='background:#0b0e14;color:#eef1f7;font-family:system-ui;padding:24px'>No report yet. Click Start to generate.</body>"
        );
      }
    }
  }
  if (url === "/api/status") {
    if (!state.profile) state.profile = await loadProfile();
    return sendJson(res, 200, state);
  }
  if (url === "/api/start" && method === "POST") {
    const body = await readBody(req);
    const target = normalizeInput(body?.input);
    if (!target) return sendJson(res, 400, { error: "Invalid profile URL or ID." });
    if (state.status === "running") return sendJson(res, 409, { error: "Already running." });
    state.profile = target;
    runPipeline({ url: target, full: true, workers: body?.workers }).catch((err) => {
      state.status = "error";
      state.phase = "idle";
      state.message = err.message;
    });
    return sendJson(res, 200, { ok: true });
  }
  if (url === "/api/refresh" && method === "POST") {
    const body = await readBody(req);
    const target = normalizeInput(body?.input);
    if (!target) return sendJson(res, 400, { error: "Invalid profile URL or ID." });
    if (state.status === "running") return sendJson(res, 409, { error: "Already running." });
    const lastProfile = await loadProfile();
    if (lastProfile && lastProfile !== target) {
      return sendJson(res, 409, { error: "Profile changed. Use Reset." });
    }
    state.profile = target;
    runPipeline({ url: target, full: false, workers: body?.workers }).catch((err) => {
      state.status = "error";
      state.phase = "idle";
      state.message = err.message;
    });
    return sendJson(res, 200, { ok: true });
  }
  if (url === "/api/reset" && method === "POST") {
    const body = await readBody(req);
    const target = normalizeInput(body?.input);
    if (!target) return sendJson(res, 400, { error: "Invalid profile URL or ID." });
    if (state.status === "running") return sendJson(res, 409, { error: "Already running." });
    state.profile = target;
    runPipeline({ url: target, full: true, workers: body?.workers }).catch((err) => {
      state.status = "error";
      state.phase = "idle";
      state.message = err.message;
    });
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  process.stdout.write(`UI running at http://localhost:${PORT}\n`);
});
