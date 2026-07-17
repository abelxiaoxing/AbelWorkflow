import type { Viewport } from "./page-api.js";

export interface ServeOptions {
  port?: number;
  host?: string;
  headless?: boolean;
  cdpPort?: number;
}

export type ViewportSize = Viewport;

export interface GetPageRequest {
  name: string;
  /** Optional viewport size for new pages */
  viewport?: ViewportSize;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
  mode: "standalone" | "extension";
  extensionConnected?: boolean;
}
