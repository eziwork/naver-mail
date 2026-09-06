import { createServer, type Socket } from "node:net";
import { chmod, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SocketServerTransport } from "./socket-transport.js";
import { createNaverMailRuntime, createNaverMailServer } from "./server.js";
import { LIMITS, PLUGIN_VERSION } from "./constants.js";

const directory = process.env.NAVER_MAIL_RUNTIME_DIR;
const endpoint = process.env.NAVER_MAIL_PIPE;
if (!directory || !endpoint) throw new Error("Start the worker through the native bridge.");
const secret = (await readFile(join(directory, "ipc-secret"), "utf8")).trim();
if (!/^[a-f0-9]{64}$/u.test(secret)) throw new Error("Invalid IPC secret.");
const runtime = createNaverMailRuntime();
const sockets = new Set<Socket>();
let lastActivity = Date.now();
let shuttingDown = false;
const idleMs = process.env.NAVER_MAIL_TEST_ROOT ? Number(process.env.NAVER_MAIL_TEST_IDLE_MS ?? LIMITS.workerIdleMs) : LIMITS.workerIdleMs;

const listener = createServer((socket) => {
  sockets.add(socket);
  socket.on("error", () => socket.destroy());
  socket.once("close", () => sockets.delete(socket));
  void authenticate(socket).then(async () => {
    if (shuttingDown || socket.destroyed) return socket.destroy();
    const transport = new SocketServerTransport(socket, () => { lastActivity = Date.now(); });
    const bundle = createNaverMailServer(runtime);
    socket.once("close", () => { void bundle.close().catch(() => undefined); });
    transport.onerror = () => socket.destroy();
    await bundle.server.connect(transport);
  }).catch(() => socket.destroy());
});

listener.once("error", () => process.exit(1));
listener.listen(endpoint, () => {
  if (process.platform !== "win32") void chmod(endpoint, 0o600);
  void writeFile(join(directory, "worker.json"), JSON.stringify({pid: process.pid, version: PLUGIN_VERSION}), {mode: 0o600});
});
const timer = setInterval(() => {
  if (runtime.pending || runtime.setup.isActive || runtime.sendPlans.activeCount) { lastActivity = Date.now(); return; }
  if (Date.now() - lastActivity >= idleMs) void shutdown();
}, Math.min(1_000, Math.max(50, idleMs / 4)));

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  await runtime.shutdown();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (process.platform !== "win32") await unlink(endpoint!).catch(() => undefined);
  await unlink(join(directory!, "worker.json")).catch(() => undefined);
}
function proof(message: string): string { return createHmac("sha256", secret).update(message).digest("hex"); }
async function authenticate(socket: Socket): Promise<void> {
  const hello = await readLine(socket);
  if (hello.version !== PLUGIN_VERSION || typeof hello.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(hello.nonce)) throw new Error("Invalid IPC hello.");
  const nonce = randomBytes(32).toString("hex");
  socket.write(`${JSON.stringify({nonce, proof: proof(`server:${hello.nonce}:${nonce}:${PLUGIN_VERSION}`)})}\n`);
  const answer = await readLine(socket);
  const expected = proof(`client:${hello.nonce}:${nonce}:${PLUGIN_VERSION}`);
  if (typeof answer.proof !== "string" || answer.proof.length !== expected.length || !timingSafeEqual(Buffer.from(answer.proof), Buffer.from(expected))) throw new Error("IPC authentication failed.");
  socket.write('{"ready":true}\n');
}
function readLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => done(new Error("IPC authentication timeout.")), 3_000);
    const done = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timeout); socket.pause();
      socket.off("data", data); socket.off("close", closed); socket.off("error", failed);
      if (error) reject(error); else resolve(value!);
    };
    const failed = (error: Error) => done(error);
    const closed = () => done(new Error("IPC closed."));
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) return done(new Error("IPC hello too large."));
      const newline = buffer.indexOf(10); if (newline < 0) return;
      const rest = buffer.subarray(newline + 1); if (rest.length) socket.unshift(rest);
      try { done(undefined, JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>); }
      catch { done(new Error("Invalid IPC JSON.")); }
    };
    socket.on("data", data); socket.once("close", closed); socket.once("error", failed); socket.resume();
  });
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
