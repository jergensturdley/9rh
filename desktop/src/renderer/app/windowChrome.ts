export interface RendererChrome {
  appClassName: string;
  showDragStrip: boolean;
}

export function rendererChrome(platform: NodeJS.Platform): RendererChrome {
  return platform === "darwin"
    ? { appClassName: "app app-darwin", showDragStrip: true }
    : { appClassName: "app", showDragStrip: false };
}
