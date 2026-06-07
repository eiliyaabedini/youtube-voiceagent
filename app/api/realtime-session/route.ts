import { NextRequest, NextResponse } from "next/server";
import { OpenAI } from "openai";

// Instructions mirror the chained pipeline's system prompt (see voice-agent/route.ts),
// adapted for a live speech-to-speech session.
const REALTIME_INSTRUCTIONS = [
  "You are a helpful voice assistant managing a simple todo list.",
  "Rely on the provided tools (listTasks, addTask, completeTask, updateTask, deleteTask) to read and change the list — never claim to have read or changed it without calling a tool.",
  "Whenever the user asks what is on the list, or refers to a task by its wording or position (e.g. 'the last one', 'the latest item', 'the coffee task'), first call listTasks to get the current items, then act using the matching task's exact id.",
  "Each task has an 'addedAt' timestamp; the most recently added task is the one with the latest addedAt (the last entry returned by listTasks).",
  "Use completeTask to mark done, updateTask to change a task's wording, and deleteTask to remove one — all by id.",
  "Keep spoken replies short, natural, and conversational — one or two sentences.",
].join(" ");

// Same three tools as the chained route, but in the flat RealtimeFunctionTool shape
// ({ type, name, description, parameters }) rather than nested under `function`.
const REALTIME_TOOLS = [
  {
    type: "function" as const,
    name: "listTasks",
    description:
      "Read the current todo list. Returns every task with its id, text, completed status, and addedAt timestamp (oldest first, so the last entry is the most recently added). Call this before completing, updating, or deleting a task referred to by name or position.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "addTask",
    description: "Add a new todo item to the list",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The content of the todo item" },
      },
      required: ["text"],
    },
  },
  {
    type: "function" as const,
    name: "completeTask",
    description: "Mark a todo item as completed",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The unique ID of the todo item" },
      },
      required: ["id"],
    },
  },
  {
    type: "function" as const,
    name: "updateTask",
    description: "Change the text/wording of an existing todo item",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The unique ID of the todo item" },
        text: { type: "string", description: "The new content for the todo item" },
      },
      required: ["id", "text"],
    },
  },
  {
    type: "function" as const,
    name: "deleteTask",
    description: "Remove a todo item from the list",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The unique ID of the todo item" },
      },
      required: ["id"],
    },
  },
];

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-openai-key");
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OpenAI API key. Add your key in Settings to use the voice agent." },
        { status: 401 }
      );
    }

    const openai = new OpenAI({ apiKey });

    // Mint a short-lived ephemeral client secret. Only this token is sent to the
    // browser; the user's real key never leaves the server.
    const secret = await openai.realtime.clientSecrets.create({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        audio: { output: { voice: "ash" } },
        instructions: REALTIME_INSTRUCTIONS,
        tools: REALTIME_TOOLS,
        reasoning: { effort: "low" },
      },
    });

    return NextResponse.json({
      value: secret.value,
      expires_at: secret.expires_at,
      model: "gpt-realtime-2",
    });
  } catch (error: any) {
    console.error("Error in realtime-session api:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
