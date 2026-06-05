// Raw-WebRTC client for the OpenAI Realtime API (gpt-realtime-2 speech-to-speech).
//
// The browser never sees the user's real OpenAI key: we POST it to our own
// /api/realtime-session route, which returns a short-lived ephemeral token. We then
// open a WebRTC peer connection, stream the mic up, play the model's audio back, and
// run tool calls (addTask/completeTask/deleteTask) against the live React todo state.

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  // Epoch ms when the item was added — lets the agent resolve "the last/latest item".
  createdAt: number;
}

export type RealtimeStatus = "idle" | "connecting" | "live" | "speaking";

export interface RealtimeOptions {
  apiKey: string;
  audioEl: HTMLAudioElement;
  getTodos: () => Todo[];
  setTodos: (todos: Todo[]) => void;
  onStatus?: (status: RealtimeStatus) => void;
  onTranscript?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onError?: (message: string) => void;
}

export interface RealtimeController {
  stop: () => void;
}

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// Thrown when the session route rejects the key, so the caller can reopen Settings.
export class RealtimeAuthError extends Error {}

const newId = () => Math.random().toString(36).substring(2, 9);

// Serialize the list for the model: ids (so it can act), text, status, and added
// time. Ordered oldest→newest so "the last item" is the final entry.
export function summarizeTodos(todos: Todo[]): string {
  if (todos.length === 0) return "The todo list is empty.";
  return JSON.stringify(
    todos.map((t) => ({
      id: t.id,
      text: t.text,
      completed: t.completed,
      addedAt: new Date(t.createdAt).toISOString(),
    }))
  );
}

// Apply a tool call to the current list and return a human-readable result string
// (mirrors the server-side logic in app/api/voice-agent/route.ts).
function executeTool(
  name: string,
  args: any,
  getTodos: () => Todo[],
  setTodos: (todos: Todo[]) => void
): string {
  const todos = getTodos();

  if (name === "listTasks") {
    return summarizeTodos(todos);
  }

  if (name === "addTask") {
    const next = [...todos, { id: newId(), text: args.text, completed: false, createdAt: Date.now() }];
    setTodos(next);
    return `Successfully added: "${args.text}"`;
  }

  if (name === "completeTask") {
    if (!todos.some((t) => t.id === args.id)) return `Task ID ${args.id} not found`;
    setTodos(todos.map((t) => (t.id === args.id ? { ...t, completed: true } : t)));
    return `Completed task ID ${args.id}`;
  }

  if (name === "updateTask") {
    if (!todos.some((t) => t.id === args.id)) return `Task ID ${args.id} not found`;
    setTodos(todos.map((t) => (t.id === args.id ? { ...t, text: args.text } : t)));
    return `Updated task ID ${args.id} to "${args.text}"`;
  }

  if (name === "deleteTask") {
    const next = todos.filter((t) => t.id !== args.id);
    if (next.length === todos.length) return `Task ID ${args.id} not found`;
    setTodos(next);
    return `Deleted task ID ${args.id}`;
  }

  return `Unknown tool: ${name}`;
}

export async function connectRealtime(opts: RealtimeOptions): Promise<RealtimeController> {
  const { apiKey, audioEl, getTodos, setTodos, onStatus, onTranscript, onAssistantText, onError } = opts;

  onStatus?.("connecting");

  // 1. Mint an ephemeral token from our server using the user's saved key.
  const tokenRes = await fetch("/api/realtime-session", {
    method: "POST",
    headers: { "x-openai-key": apiKey },
  });
  if (tokenRes.status === 401) {
    throw new RealtimeAuthError("Missing or invalid OpenAI API key.");
  }
  if (!tokenRes.ok) {
    throw new Error("Failed to start realtime session.");
  }
  const { value: ephemeralKey, model } = await tokenRes.json();

  // 2. Peer connection + remote audio playback.
  const pc = new RTCPeerConnection();
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
  };

  // 3. Capture the mic and send it up.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));

  // 4. Data channel carries the JSON event stream (tool calls, transcripts, etc).
  const dc = pc.createDataChannel("oai-events");

  // Send one function_call_output per call, then ask the model to respond out loud.
  const sendToolResult = (callId: string, output: string) => {
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      })
    );
    dc.send(JSON.stringify({ type: "response.create" }));
  };

  dc.onmessage = (e) => {
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "response.function_call_arguments.done": {
        let args: any = {};
        try {
          args = JSON.parse(msg.arguments || "{}");
        } catch {
          args = {};
        }
        const result = executeTool(msg.name, args, getTodos, setTodos);
        sendToolResult(msg.call_id, result);
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (msg.transcript) onTranscript?.(msg.transcript);
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        if (msg.transcript) onAssistantText?.(msg.transcript);
        break;
      }
      case "output_audio_buffer.started": {
        onStatus?.("speaking");
        break;
      }
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": {
        onStatus?.("live");
        break;
      }
      case "error": {
        onError?.(msg.error?.message || "Realtime session error.");
        break;
      }
    }
  };

  dc.onopen = () => onStatus?.("live");

  // 5. SDP handshake. The session already carries the model, but we pass it in the
  //    query string per the GA WebRTC flow. No `OpenAI-Beta` header (GA removed it).
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch(`${REALTIME_CALLS_URL}?model=${encodeURIComponent(model)}`, {
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
    throw new Error("Realtime WebRTC handshake failed.");
  }
  const answerSdp = await sdpRes.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      dc.close();
    } catch {}
    pc.getSenders().forEach((s) => s.track?.stop());
    stream.getTracks().forEach((t) => t.stop());
    try {
      pc.close();
    } catch {}
    audioEl.srcObject = null;
    onStatus?.("idle");
  };

  return { stop };
}
