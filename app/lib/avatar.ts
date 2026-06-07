// Client controller for a HeyGen LiveAvatar "mouthpiece" session (Avatar tab).
//
// Mirrors app/lib/realtime.ts: the browser never sees the user's real HeyGen key — we
// POST it to our /api/avatar-session route, which returns a short-lived session token.
// We hand that token to the @heygen/liveavatar-web-sdk, which drives the live session
// (start + LiveKit) client-side. The avatar runs in LITE mode as a pure output device:
// voiceChat is disabled (no mic capture / no avatar LLM), and we make it speak by
// streaming OpenAI TTS PCM into repeatAudio(). The thinking + tool-calling happens in
// /api/avatar-agent, exactly like the chained pipeline.

export type AvatarStatus = "idle" | "connecting" | "live" | "speaking";

export interface AvatarOptions {
  heygenKey: string;
  videoEl: HTMLVideoElement;
  onStatus?: (status: AvatarStatus) => void;
  onError?: (message: string) => void;
  // Fired when the session ends on its own (e.g. the ~1-min sandbox cap or a
  // server-initiated disconnect) so the caller can drop its controller ref and let
  // the user go live again.
  onClosed?: () => void;
}

export interface AvatarController {
  speak: (pcmBase64: string) => void;
  stop: () => void;
}

// Thrown when the session route rejects the key, so the caller can reopen Settings.
export class AvatarAuthError extends Error {}

// keep-alive cadence: every ~2.5 min against the 5-min inactivity timeout.
const KEEPALIVE_MS = 150_000;
// If the stream never becomes ready after start(), bail rather than show a blank video.
const STREAM_READY_TIMEOUT_MS = 20_000;

export async function connectAvatar(opts: AvatarOptions): Promise<AvatarController> {
  const { heygenKey, videoEl, onStatus, onError, onClosed } = opts;

  onStatus?.("connecting");

  // 1. Mint a session token from our server using the user's saved HeyGen key.
  const tokenRes = await fetch("/api/avatar-session", {
    method: "POST",
    headers: { "x-heygen-key": heygenKey },
  });
  if (tokenRes.status === 401) {
    throw new AvatarAuthError("Missing or invalid HeyGen API key.");
  }
  if (!tokenRes.ok) {
    throw new Error("Failed to start avatar session.");
  }
  const { session_token } = await tokenRes.json();

  // 2. Load the browser SDK lazily (keeps LiveKit/`window` out of SSR + the initial bundle).
  const { LiveAvatarSession, SessionEvent, AgentEventsEnum } = await import(
    "@heygen/liveavatar-web-sdk"
  );

  // voiceChat:false → the avatar never captures the mic or runs its own LLM; it only
  // speaks the audio we push via repeatAudio().
  const session = new LiveAvatarSession(session_token, { voiceChat: false });

  let stopped = false;
  let streamReady = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let keepAliveId: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    if (keepAliveId) { clearInterval(keepAliveId); keepAliveId = null; }
    try { session.stop(); } catch {}
    try { videoEl.srcObject = null; } catch {}
  };

  // Session ended by us (CLIENT_INITIATED) vs. by the server / cap. Only the latter
  // should notify the caller to reset.
  const handleClosed = (message?: string) => {
    if (stopped) return;
    stopped = true;
    cleanup();
    if (message) onError?.(message);
    onStatus?.("idle");
    onClosed?.();
  };

  // 3. Wire events before starting so we don't miss SESSION_STREAM_READY.
  session.on(SessionEvent.SESSION_STREAM_READY, () => {
    if (stopped) return;
    streamReady = true;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    session.attach(videoEl);
    onStatus?.("live");
  });
  // Drive the speaking indicator from the avatar's own speech events.
  session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
    if (!stopped) onStatus?.("speaking");
  });
  session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
    if (!stopped) onStatus?.("live");
  });
  session.on(AgentEventsEnum.SESSION_STOPPED, () => {
    handleClosed("The avatar session ended. Tap to go live again.");
  });
  session.on(SessionEvent.SESSION_DISCONNECTED, (reason: unknown) => {
    // A client-initiated disconnect is our own stop() — ignore it (stopped is already true).
    if (reason === "CLIENT_INITIATED") return;
    handleClosed("The avatar session disconnected. Tap to go live again.");
  });

  // 4. Start the live session (SDK calls /v1/sessions/start + joins LiveKit internally).
  try {
    await session.start();
  } catch (err) {
    cleanup();
    throw err instanceof Error ? err : new Error("Failed to start avatar session.");
  }

  // Watchdog: if the stream never signals ready, tear down instead of a blank video.
  // (Guard against SESSION_STREAM_READY having already fired during start().)
  if (!streamReady && !stopped) {
    readyTimer = setTimeout(() => {
      if (streamReady || stopped) return;
      handleClosed("The avatar stream didn't start. Tap to try again.");
    }, STREAM_READY_TIMEOUT_MS);
  }

  keepAliveId = setInterval(() => {
    session.keepAlive().catch(() => {});
  }, KEEPALIVE_MS);

  const speak = (pcmBase64: string) => {
    if (stopped || !pcmBase64) return;
    try {
      // LITE mode: repeatAudio() streams our PCM to the avatar. (repeat(text) throws in LITE.)
      session.repeatAudio(pcmBase64);
    } catch (err) {
      console.error("Avatar repeatAudio failed:", err);
      onError?.("The avatar couldn't play that reply.");
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cleanup();
    onStatus?.("idle");
  };

  return { speak, stop };
}
