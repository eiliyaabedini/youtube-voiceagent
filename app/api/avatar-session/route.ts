import { NextRequest, NextResponse } from "next/server";

// Mints a short-lived HeyGen LiveAvatar session token for the Avatar tab. Mirrors
// app/api/realtime-session/route.ts: the user's real HeyGen X-API-KEY arrives in the
// `x-heygen-key` header, is used server-side to create a LITE session, and only the
// resulting `session_token` is returned to the browser — the real key never leaves
// the server. The browser SDK (@heygen/liveavatar-web-sdk) consumes that token and
// drives the live session (start + LiveKit) client-side.

const LIVEAVATAR_TOKEN_URL = "https://api.liveavatar.com/v1/sessions/token";

// Free sandbox avatar (~1-min sessions, no credits). Swap to a production avatar_id
// from your HeyGen account for full-length sessions.
const AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";

export async function POST(req: NextRequest) {
  try {
    const heygenKey = req.headers.get("x-heygen-key");
    if (!heygenKey) {
      return NextResponse.json(
        { error: "Missing HeyGen API key. Add your key in Settings to use the avatar agent." },
        { status: 401 }
      );
    }

    const res = await fetch(LIVEAVATAR_TOKEN_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": heygenKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "LITE",
        avatar_id: AVATAR_ID,
        is_sandbox: true,
      }),
    });

    // Surface auth failures as 401 so the client can reopen Settings.
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { error: "Invalid HeyGen API key." },
        { status: 401 }
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[LiveAvatar] token mint failed:", res.status, detail);
      return NextResponse.json(
        { error: "Failed to start avatar session." },
        { status: 500 }
      );
    }

    const json = await res.json();
    const sessionToken = json?.data?.session_token;
    if (!sessionToken) {
      console.error("[LiveAvatar] unexpected token response shape:", json);
      return NextResponse.json(
        { error: "Failed to start avatar session." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      session_token: sessionToken,
      avatar_id: AVATAR_ID,
    });
  } catch (error: any) {
    console.error("Error in avatar-session api:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
