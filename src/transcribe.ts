/**
 * The voice → text transcription seam. Channel-agnostic: the bridge orchestrates transcription of an
 * inbound {@link Inbound.audio} through this interface, while the concrete transcriber (Groq Whisper,
 * etc.) lives in the channel package. A fake returns a canned string so the whole voice → route chain
 * is unit-testable with no network and no API key.
 */
export interface Transcriber {
  /** Transcribe `audio` (raw bytes; `filename` gives the container hint, e.g. "voice.ogg").
   *  Returns the plain transcript text. Throws on a real API/network error (the caller surfaces it). */
  transcribe(audio: Uint8Array, filename: string): Promise<string>;
}
