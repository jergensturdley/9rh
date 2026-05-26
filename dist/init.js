import { createConnection } from "net";
import { execFile, execFileSync, spawn } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";
import { closeSync, existsSync, openSync, readFileSync } from "fs";
import os from "os";
import chalk from "chalk";
const execFileAsync = promisify(execFile);
const NINE_ROUTER_PORT = 20128;
const NINE_ROUTER_NATIVE = `http://127.0.0.1:${NINE_ROUTER_PORT}`;
const NINE_ROUTER_OPENAI = `${NINE_ROUTER_NATIVE}/v1`;
const CLI_TOKEN_SALT = "9r-cli-auth";
async function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function readFirstApiKey() {
    try {
        const dbPath = `${os.homedir()}/.9router/db/data.sqlite`;
        if (!existsSync(dbPath))
            return null;
        const key = execFileSync("sqlite3", [dbPath, "SELECT key FROM apiKeys LIMIT 1"], { encoding: "utf8", timeout: 5000 }).trim();
        return key || null;
    }
    catch {
        return null;
    }
}
export { readFirstApiKey };
function machineIdHash() {
    try {
        const idFile = `${os.homedir()}/.9router/machine-id`;
        if (existsSync(idFile)) {
            return readFileSync(idFile, "utf8").trim();
        }
        let id;
        if (process.platform === "darwin") {
            const raw = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000 });
            id = raw.split("IOPlatformUUID")[1]?.split("\n")[0]?.replace(/=|\s+|"/g, "").toLowerCase() ?? "";
        }
        else if (process.platform === "linux") {
            const raw = execFileSync("sh", ["-c", "( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null || hostname ) | head -n 1 || :"], { encoding: "utf8", timeout: 5000 });
            id = raw.replace(/\r+|\n+|\s+/g, "").toLowerCase();
        }
        else if (process.platform === "win32") {
            const raw = execFileSync("REG", ["QUERY", "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", timeout: 5000 });
            id = raw.split("REG_SZ")[1]?.replace(/\r+|\n+|\s+/g, "").toLowerCase() ?? "";
        }
        else {
            id = "";
        }
        if (!id)
            return "";
        return createHash("sha256").update(id).digest("hex");
    }
    catch {
        return "";
    }
}
export function getCliToken() {
    const mid = machineIdHash();
    if (mid === "" || !mid)
        return "";
    let secret = "";
    try {
        const secretFile = `${os.homedir()}/.9router/auth/cli-secret`;
        if (existsSync(secretFile)) {
            secret = readFileSync(secretFile, "utf8").trim();
        }
    }
    catch { }
    return createHash("sha256").update(mid + CLI_TOKEN_SALT + secret).digest("hex").substring(0, 16);
}
async function isPortOpen(port) {
    return new Promise((resolve) => {
        const sock = createConnection(port, "127.0.0.1");
        const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 3000);
        sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
        sock.on("error", () => { clearTimeout(timer); sock.destroy(); resolve(false); });
    });
}
function nativeBase(openAIURL) {
    return openAIURL.replace(/\/v1\/?$/, "");
}
async function healthCheck(openAIURL, apiKey) {
    try {
        const res = await fetch(`${nativeBase(openAIURL)}/api/health`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(3000),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
function processErrorMessage(err) {
    const e = err;
    return [e.stderr, e.stdout, e.message].filter(Boolean).join("\n").trim() || String(err);
}
function tailFile(path, maxChars = 2000) {
    try {
        const raw = readFileSync(path, "utf8");
        return raw.length > maxChars ? raw.slice(-maxChars) : raw;
    }
    catch {
        return "";
    }
}
async function installAndStart() {
    const isInstalled = existsSync("/usr/local/bin/9router") ||
        existsSync("/usr/bin/9router") ||
        (await execFileAsync("which", ["9router"]).then(() => true).catch(() => false));
    let startCommand = "9router";
    let startArgs = ["--tray", "--no-browser", "--skip-update"];
    if (!isInstalled) {
        process.stderr.write(chalk.yellow("  Installing 9router globally...\n"));
        try {
            await execFileAsync("npm", ["install", "-g", "9router"], { timeout: 60_000 });
        }
        catch (err) {
            const npmError = processErrorMessage(err).split("\n").slice(0, 4).join("\n");
            process.stderr.write(chalk.yellow(`  npm install failed — trying npx...\n${npmError ? `  ${npmError}\n` : ""}`));
            try {
                await execFileAsync("npx", ["-y", "9router", "--version"], { timeout: 30_000 });
                startCommand = "npx";
                startArgs = ["-y", "9router", "--tray", "--no-browser", "--skip-update"];
            }
            catch (npxErr) {
                return { success: false, error: `Neither npm install -g nor npx could install 9router. npx error: ${processErrorMessage(npxErr)}` };
            }
        }
    }
    if (await isPortOpen(NINE_ROUTER_PORT)) {
        return { success: true };
    }
    process.stderr.write(chalk.blue("  Starting 9router daemon...\n"));
    const logPath = `/tmp/9rh-9router-${Date.now()}.log`;
    const logFd = openSync(logPath, "a");
    const daemon = spawn(startCommand, startArgs, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    let spawnError = "";
    daemon.on("error", (err) => { spawnError = err.message; });
    daemon.unref();
    for (let i = 0; i < 45; i++) {
        await delay(1000);
        if (await isPortOpen(NINE_ROUTER_PORT)) {
            await delay(1500);
            return { success: true };
        }
    }
    const logTail = tailFile(logPath).trim();
    const details = [
        spawnError ? `spawn error: ${spawnError}` : "",
        logTail ? `startup log (${logPath}):\n${logTail}` : `startup log: ${logPath}`,
    ].filter(Boolean).join("\n");
    return { success: false, error: `9router started but did not become reachable within 45s. ${details}` };
}
export async function ensureRouter(routerUrl, apiKey) {
    const inputUrl = routerUrl ?? NINE_ROUTER_OPENAI;
    const baseURL = inputUrl.replace("localhost", "127.0.0.1");
    const defaultKey = "9router";
    const storedKey = readFirstApiKey();
    if (storedKey && await healthCheck(baseURL, storedKey)) {
        return { baseURL, apiKey: storedKey, wasStarted: false };
    }
    if (apiKey && apiKey !== defaultKey && await healthCheck(baseURL, apiKey)) {
        return { baseURL, apiKey, wasStarted: false };
    }
    if (await healthCheck(baseURL, defaultKey)) {
        return { baseURL, apiKey: storedKey ?? defaultKey, wasStarted: false };
    }
    process.stderr.write(chalk.blue("\n  9router not running — setting up automatically\n\n"));
    const install = await installAndStart();
    if (!install.success) {
        return {
            baseURL,
            apiKey: storedKey ?? apiKey ?? defaultKey,
            wasStarted: false,
            error: install.error ?? "Failed to install/start 9router",
        };
    }
    const finalKey = storedKey ?? apiKey ?? defaultKey;
    if (!await healthCheck(baseURL, finalKey)) {
        return {
            baseURL,
            apiKey: finalKey,
            wasStarted: false,
            error: "9router started but health check failed. Please verify 9router is running and configured.",
        };
    }
    return { baseURL, apiKey: finalKey, wasStarted: true };
}
//# sourceMappingURL=init.js.map