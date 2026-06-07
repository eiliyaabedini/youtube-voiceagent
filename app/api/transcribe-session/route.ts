import { NextRequest, NextResponse } from "next/server";
import { OpenAI } from "openai";

// Mints a short-lived ephemeral client secret for an OpenAI Realtime *transcription*
// session (gpt-realtime-whisper), used by the Avatar tab's push-to-talk. Mirrors
// app/api/realtime-session/route.ts — the real OpenAI key stays server-side; only the
// ephemeral secret reaches the browser, which then opens the WebRTC mic stream and
// receives live transcripts (see app/lib/transcribe.ts).
const TRANSCRIBE_MODEL = "gpt-realtime-whisper";

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-openai-key");
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OpenAI API key. Add your key in Settings to use the avatar agent." },
        { status: 401 }
      );
    }

    const openai = new OpenAI({ apiKey });

    const secret = await openai.realtime.clientSecrets.create({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: TRANSCRIBE_MODEL,
              language: "en",
              // latency/accuracy knob for gpt-realtime-whisper: minimal | low | medium | high | xhigh
              delay: "low",
            },
            // gpt-realtime-whisper requires turn detection off; we commit each utterance
            // manually from the client (push-to-talk).
            turn_detection: null,
          },
        },
      },
    });

    return NextResponse.json({ value: secret.value, expires_at: secret.expires_at });
  } catch (error: any) {
    console.error("Error in transcribe-session api:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
