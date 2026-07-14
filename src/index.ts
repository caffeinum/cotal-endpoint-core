/**
 * @cotal-ai/endpoint-core — the channel-agnostic core for a cotal mesh ↔ chat-channel bridge. A new
 * channel (Telegram, Slack, Discord, SMS…) is just a {@link Transport} + {@link Formatter} impl; this
 * package owns the routing, sticky targets, command layer, mesh helpers, config/state skeleton, and the
 * bridge orchestration. Only @cotal-ai/core.
 */
export * from "./transport.js";
export * from "./files.js";
export * from "./transcribe.js";
export * from "./router.js";
export * from "./commands.js";
export * from "./mesh.js";
export * from "./config.js";
export * from "./bridge.js";
