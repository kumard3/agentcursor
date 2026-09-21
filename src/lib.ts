export { AgentCursor } from "./sdk/agent-cursor";
export type { ConnectOptions } from "./sdk/agent-cursor";
export type { LaunchOptions } from "./sdk/launch";
export { Desktop } from "./sdk/desktop";
export type { DesktopOptions, DesktopQuery } from "./sdk/desktop";
export { DesktopService } from "./desktop/service";
export type { DesktopServiceOptions } from "./desktop/service";
export { CursorOverlay } from "./desktop/overlay";
export type { OverlayOptions } from "./desktop/overlay";
export { expect } from "./sdk/expect";
export type { Expectation } from "./sdk/expect";
export { Locator } from "./sdk/locator";
export type { ByOptions, ByRoleOptions, LocatorContext } from "./sdk/locator";
export { ActionService } from "./action/service";
export { Persona, createPersona } from "./persona";
export type { PersonaTraits, PersonaInfo, PersonaOptions } from "./persona";
export { buildTypingSchedule, flattenSchedule, scheduleToKeystrokes } from "./persona/typing";
export {
  generateMove,
  offCenterPoint,
  sampleDwellMs,
  samplePressMs,
  sampleKeyDelayMs,
  createRng,
} from "./path-engine";
export { ExtensionTransport } from "./server/transport";
export { ExtensionDriver } from "./drivers/extension-driver";
export { OsCursorDriver } from "./drivers/os-cursor-driver";
export type { BrowserDriver } from "./drivers/driver";
export type {
  Point,
  Rect,
  PageSnapshot,
  PageElement,
  CursorSample,
  DeliveryMode,
  MouseButton,
  LocatorSpec,
  LocatorStep,
  LocatorMatch,
  KeyOp,
} from "./protocol";
