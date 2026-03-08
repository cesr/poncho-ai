export interface BrowserFrame {
  data: string;
  width: number;
  height: number;
  timestamp: number;
}

export interface BrowserStatus {
  active: boolean;
  url?: string;
  interactionAllowed: boolean;
}

export interface ViewportOptions {
  width?: number;
  height?: number;
}

export interface ScreencastOptions {
  format?: "jpeg" | "png";
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

export interface MouseInputEvent {
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "left" | "right" | "middle" | "none";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}

export interface KeyboardInputEvent {
  type: "keyDown" | "keyUp" | "char";
  key: string;
  code?: string;
  text?: string;
  keyCode?: number;
}

export interface ScrollInputEvent {
  deltaX: number;
  deltaY: number;
  x?: number;
  y?: number;
}

export interface BrowserStoragePersistence {
  save(json: string): Promise<void>;
  load(): Promise<string | undefined>;
}

export interface BrowserConfig {
  viewport?: ViewportOptions;
  quality?: number;
  everyNthFrame?: number;
  profileDir?: string;
  sessionName?: string;
  executablePath?: string;
  headless?: boolean;
  storagePersistence?: BrowserStoragePersistence;
}
