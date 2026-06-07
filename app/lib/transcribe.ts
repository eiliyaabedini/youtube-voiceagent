// WebRTC client for an OpenAI Realtime *transcription* session (gpt-realtime-whisper).
//
// Used by the Avatar tab: instead of recording a clip and batch-transcribing it, we
// stream the mic to a live transcription session so the transcript is ready the instant
// the user stops talking. The browser never sees the real OpenAI key — we POST it to
// /api/transcribe-session for a short-lived ephemeral secret, then open WebRTC directly.
//
// gpt-realtime-whisper has turn detection OFF, so each push-to-talk utterance is bounded
// manually: startUtterance() clears the input buffer, endUtterance() commits it and
// resolves with the final transcript.

export type TranscribeStatus = "idle" | "connecting" | "ready";

export interface TranscribeOptions {
  apiKey: string;
  onStatus?: (status: TranscribeStatus) => void;
  // Incremental transcript text while the user is speaking (for live display).
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
}

export interface TranscribeController {
  // Begin a push-to-talk utterance: discard buffered audio so we transcribe only from here.
  startUtterance: () => void;
  // End the utterance: commit the buffered audio, resolve with the final transcript.
  endUtterance: () => Promise<string>;
  stop: () => void;
}

// Thrown when the session route rejects the key, so the caller can reopen Settings.
export class TranscribeAuthError extends Error {}

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const UTTERANCE_TIMEOUT_MS = 15_000;

export async function connectTranscribe(opts: TranscribeOptions): Promise<TranscribeController> {
  const { apiKey, onStatus, onPartial, onError } = opts;

  onStatus?.("connecting");

  // 1. Mint an ephemeral transcription token from our server.
  const tokenRes = await fetch("/api/transcribe-session", {
    method: "POST",
    headers: { "x-openai-key": apiKey },
  });
  if (tokenRes.status === 401) {
    throw new TranscribeAuthError("Missing or invalid OpenAI API key.");
  }
  if (!tokenRes.ok) {
    throw new Error("Failed to start transcription session.");
  }
  const { value: ephemeralKey } = await tokenRes.json();

  // 2. Peer connection. Transcription is input-only — we send the mic, expect no audio back.
  const pc = new RTCPeerConnection();

  // 3. Capture the mic and send it up.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));

  // 4. Data channel carries the transcription event stream + our clear/commit commands.
  const dc = pc.createDataChannel("oai-events");

  let partial = "";
  let pendingResolve: ((text: string) => void) | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (text: string) => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve?.(text);
  };

  dc.onmessage = (e) => {
    let msg: any;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case "conversation.item.input_audio_transcription.delta": {
        if (typeof msg.delta === "string") {
          partial += msg.delta;
          onPartial?.(partial);
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = (typeof msg.transcript === "string" ? msg.transcript : partial).trim();
        onPartial?.(text);
        settle(text);
        break;
      }
      case "conversation.item.input_audio_transcription.failed": {
        onError?.(msg.error?.message || "Transcription failed.");
        settle(partial.trim());
        break;
      }
      case "error": {
        // A commit on an empty/too-short buffer surfaces here — settle so we don't hang.
        if (pendingResolve) settle(partial.trim());
        else onError?.(msg.error?.message || "Transcription session error.");
        break;
      }
    }
  };

  dc.onopen = () => onStatus?.("ready");

  // 5. SDP handshake. The ephemeral secret pins the transcription session (model + audio
  //    format), so no model query param is needed on the calls endpoint.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch(REALTIME_CALLS_URL, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      "Content-Type": "application/sdp",
    },
  });
  if (!sdpRes.ok) {
    pc.close();
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("Transcription WebRTC handshake failed.");
  }
  const answerSdp = await sdpRes.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  const startUtterance = () => {
    partial = "";
    onPartial?.("");
    try { dc.send(JSON.stringify({ type: "input_audio_buffer.clear" })); } catch {}
  };

  const endUtterance = (): Promise<string> =>
    new Promise<string>((resolve) => {
      // If a prior utterance is somehow still pending, settle it empty first.
      if (pendingResolve) settle("");
      pendingResolve = resolve;
      pendingTimer = setTimeout(() => settle(partial.trim()), UTTERANCE_TIMEOUT_MS);
      try {
        dc.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {
        settle(partial.trim());
      }
    });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    pendingResolve = null;
    try { dc.close(); } catch {}
    pc.getSenders().forEach((s) => s.track?.stop());
    stream.getTracks().forEach((t) => t.stop());
    try { pc.close(); } catch {}
    onStatus?.("idle");
  };

  return { startUtterance, endUtterance, stop };
}
