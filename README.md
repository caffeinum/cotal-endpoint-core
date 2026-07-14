# @cotal-ai/endpoint-core

Channel-agnostic core for bridging the [cotal](https://cotal.ai) mesh to a chat channel
(Telegram, Slack, Discord, SMS, …). It owns everything that is the *same* for every channel —
message routing, sticky per-chat targets, the slash-command layer, mesh helpers, config/state,
and the self-healing bridge orchestration — behind two small seams (`Transport` + `Formatter`).
A concrete channel is just an implementation of those seams; core never imports a channel SDK.

Depends **only** on `@cotal-ai/core`.

## What it does

A running bridge is two self-healing legs between the mesh and one channel:

- **mesh → channel** — a live DM / channel post on the mesh is chunked, formatted, and sent to
  every allowlisted chat; the sent message id is mapped back to its sender for reply-threading.
- **channel → mesh** — each inbound message is classified (allow / learn / ignore), voice is
  transcribed, then either a `/command` runs or the message is routed to the mesh (unicast DM,
  multicast to a channel, `@all` broadcast, or `?role` anycast).

Routing is pure and unit-tested. Inbound precedence:

1. **reply-threading** — replying to a bot message DMs the agent that sent it.
2. **leading sigil** (each latches the chat's sticky target):
   - `@name msg` — DM that agent
   - `@all msg` — broadcast to every present peer
   - `#channel msg` — broadcast to that channel
   - `?role msg` — anycast to one agent of that role
3. **sticky target** — the chat's last destination, persisted so a restart remembers it.
4. **default** — a fresh chat with no sticky yet falls back to `@all`, so a first message is
   never dropped.

The command layer (`/who`, `/help`, `/to`, `/dm`, `/here`, …) is channel-native — the bridge
registers it as the channel's slash-command menu. Chat access is gated by an allowlist: strangers
are not auto-trusted onto your mesh (first-sender learning is opt-in and only while the list is empty).

## The Transport seam

A new channel implements two interfaces (full docs in `src/transport.ts`):

```ts
interface Transport {
  readonly formatter: Formatter;   // renders agent markdown into this channel's rich format
  readonly maxLen: number;         // hard per-message length; the bridge chunks to this

  init(): Promise<{ label: string }>;                    // credential smoke + first-run setup
  send(chatId, text, opts?): Promise<{ messageId }>;     // throws SendError on failure
  setReaction?(chatId, messageId, reaction?): Promise<void>;
  setCommands?(cmds, scope?): Promise<void>;             // register the slash-command menu
  setTyping?(chatId): Promise<void>;

  // Own the inbound loop (long-poll / websocket / webhook). Drive onInbound once per normalized
  // message; resolve when `signal` aborts. A throwing onInbound is logged and skipped, never wedging.
  run(onInbound: (inbound: Inbound) => Promise<void>, signal: AbortSignal): Promise<void>;
}

interface Formatter {
  // Render one already-chunked piece into RenderedMessage { text, mode? }. PURE, no I/O.
  render(chunk: string, label: string | undefined): RenderedMessage;
}
```

`SendError(message, permanent, formatRejected?)` classifies failures so the bridge's ack/nak logic
stays channel-agnostic: `permanent` → ack-and-drop, `formatRejected` → retry the same message as
plain text, anything else → transient → nak for JetStream redelivery. Voice is normalized to an
`AudioRef` thunk; the actual download stays in the transport, and core orchestrates transcription
through an injectable `Transcriber`.

## Adding a channel (Slack / Discord / SMS)

A channel package sits as a sibling of the existing Telegram endpoint and depends on
`@cotal-ai/endpoint-core`:

1. Implement `Transport` + `Formatter` against the channel's SDK — normalize its native updates
   into `Inbound`, render markdown into its rich format, and drive its inbound loop in `run`.
2. Extend `EndpointConfig` with any channel-specific fields (token, API keys) and reuse core's
   state helpers.
3. Call `runBridge(cfg, transport, deps?)` — core does the routing, sticky targets, command menu,
   allowlist, reply-threading, chunking, and mesh wiring. Your package never re-implements any of it.

Because everything above the seam is written against the interfaces, the generic test suite runs
entirely against a fake transport (`test/fakes.ts`) — a new channel is correct iff that suite still
passes against your implementation.

## Install & test

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # tsx --test test/*.test.ts
```

Runs on Node ≥ 22. TypeScript is executed directly via `tsx` — no build step.

## License

MIT © 2026 caffeinum. See [LICENSE](./LICENSE).
