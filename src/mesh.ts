/**
 * The cotal mesh leg: build the endpoint as a distinct named peer and resolve names → live ids. All
 * @cotal-ai/core, channel-agnostic — shared by every channel endpoint.
 *
 * A distinct peer wins because cotal allows ONE active durable consumer per identity. The endpoint is
 * its OWN identity, so it binds its OWN durable DM consumer (consume:true) and receives DMs in real time
 * through ep.on("message") with zero contention — no cursor file, no polling.
 *
 * Open mesh (no creds): pin card.id to a persisted UUID so an agent's reply redelivers to the SAME
 * durable consumer after a bridge restart. Authed mesh (creds): omit id — the endpoint adopts the
 * creds' identity as its card.id.
 */
import { CotalEndpoint } from "@cotal-ai/core";
import type { EndpointConfig } from "./config.js";
import { peerId } from "./config.js";

export function buildEndpoint(cfg: EndpointConfig): CotalEndpoint {
  const openMesh = !cfg.creds;
  return new CotalEndpoint({
    space: cfg.space,
    servers: cfg.server,
    creds: cfg.creds,
    card: openMesh
      ? { name: cfg.name, kind: "endpoint", id: peerId(cfg) }
      : { name: cfg.name, kind: "endpoint" },
    // Subscribe to the default channel so that when a plain inbound message multicasts to #<channel>,
    // the agents' replies on that channel are actually RECEIVED here (via ep.on("message", …,
    // {kind:"channel"})) and forwarded to the chat — otherwise the broadcast leg is one-way.
    channels: [cfg.channel],
    registerPresence: true, // roster-visible so agents can resolve + DM the bridge
    consume: true, // bind our OWN durable DM consumer — real-time receive
    watchPresence: true, // maintain the roster for name → id resolution on the inbound leg
  });
}

/** Resolve an agent name to a present (non-offline) peer id, case-insensitively. */
export function resolveTargetId(ep: CotalEndpoint, name: string): { id: string; name: string } | undefined {
  const me = ep.card.id;
  const hit = ep
    .getRoster()
    .filter((p) => p.card.name.toLowerCase() === name.toLowerCase() && p.card.id !== me)
    .find((p) => p.status !== "offline");
  return hit ? { id: hit.card.id, name: hit.card.name } : undefined;
}

/** Present peer names (excluding ourselves) — for the "no peer" error hint. */
export function rosterNames(ep: CotalEndpoint): string[] {
  const me = ep.card.id;
  return ep
    .getRoster()
    .filter((p) => p.card.id !== me && p.status !== "offline")
    .map((p) => p.card.name);
}

/** Present peers (excluding ourselves) as name+status — for the /who command. */
export function presentRoster(ep: CotalEndpoint): { name: string; status: string }[] {
  const me = ep.card.id;
  return ep
    .getRoster()
    .filter((p) => p.card.id !== me && p.status !== "offline")
    .map((p) => ({ name: p.card.name, status: p.status }));
}

/**
 * The `@all` fan-out set: every PRESENT, NON-endpoint peer except ourselves. Endpoints (other bridges /
 * dashboards) are excluded so `@all` targets working AGENTS, not observers — and a bare endpoint has no
 * guaranteed everyone-CHANNEL every agent is subscribed to, so unicasting to each present agent is the
 * mechanism that actually reaches all of them (the count = `.length`).
 */
export function broadcastPeers(ep: CotalEndpoint): { id: string; name: string }[] {
  const me = ep.card.id;
  return ep
    .getRoster()
    .filter((p) => p.card.id !== me && p.status !== "offline" && p.card.kind !== "endpoint")
    .map((p) => ({ id: p.card.id, name: p.card.name }));
}

/** Whether any present (non-offline) peer advertises `role` (case-insensitive) — so anycast can fail
 *  loud to the chat instead of silently publishing to a queue-group nobody serves. */
export function rolePresent(ep: CotalEndpoint, role: string): boolean {
  const me = ep.card.id;
  return ep
    .getRoster()
    .some((p) => p.card.id !== me && p.status !== "offline" && p.card.role?.toLowerCase() === role.toLowerCase());
}
