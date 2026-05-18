import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { join } from "path";
const SNAPSHOT_DIR = "./snapshots";
async function ensureDir(dir) {
    try {
        await mkdir(dir, { recursive: true });
    }
    catch { }
}
export async function captureSnapshot(agentState) {
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot = { id, timestamp: Date.now(), state: agentState };
    try {
        await ensureDir(SNAPSHOT_DIR);
        await writeFile(join(SNAPSHOT_DIR, `${id}.json`), JSON.stringify(snapshot), "utf-8");
        return id;
    }
    catch (err) {
        console.warn("[snapshotManager] captureSnapshot failed:", err);
        return id;
    }
}
export async function restoreSnapshot(snapshotId) {
    try {
        const raw = await readFile(join(SNAPSHOT_DIR, `${snapshotId}.json`), "utf-8");
        const snapshot = JSON.parse(raw);
        return snapshot.state;
    }
    catch (err) {
        console.warn("[snapshotManager] restoreSnapshot failed:", err);
        return null;
    }
}
export async function listSnapshots() {
    try {
        await ensureDir(SNAPSHOT_DIR);
        const files = await readdir(SNAPSHOT_DIR);
        const snaps = [];
        for (const file of files) {
            if (!file.endsWith(".json"))
                continue;
            try {
                const raw = await readFile(join(SNAPSHOT_DIR, file), "utf-8");
                snaps.push(JSON.parse(raw));
            }
            catch { }
        }
        return snaps.sort((a, b) => b.timestamp - a.timestamp);
    }
    catch (err) {
        console.warn("[snapshotManager] listSnapshots failed:", err);
        return [];
    }
}
//# sourceMappingURL=snapshotManager.js.map