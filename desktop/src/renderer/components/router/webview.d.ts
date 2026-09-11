/**
 * Electron's <webview> tag for TSX. React 19 has no global JSX namespace, so
 * the intrinsic element is added through the "react" module augmentation.
 * Only the attributes the DashboardView uses are declared.
 */

import type { CSSProperties, Ref } from "react";

/** The subset of Electron's WebviewTag the console calls. */
export interface WebviewElement extends HTMLElement {
  src: string;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
}

export interface WebviewAttributes {
  src?: string;
  partition?: string;
  allowpopups?: string;
  style?: CSSProperties;
  className?: string;
  ref?: Ref<WebviewElement>;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewAttributes;
    }
  }
}
