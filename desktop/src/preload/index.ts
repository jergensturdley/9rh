import { contextBridge } from "electron";

// Scaffold stub: the typed bridge over shared/ipc.ts lands in a later step.
contextBridge.exposeInMainWorld("ninerh", {});
