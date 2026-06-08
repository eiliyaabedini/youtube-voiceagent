import { NextRequest, NextResponse } from "next/server";
import { OpenAI } from "openai";
import { searchKnowledge } from "@/app/lib/chroma";

const KB_NAMESPACE = "default";

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

    const formData = await req.formData();
    const audioFile = formData.get("file") as File;
    const todosJson = formData.get("todos") as string;

    if (!audioFile) {
      return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
    }

    let currentTodos = [];
    if (todosJson) {
      try {
        currentTodos = JSON.parse(todosJson);
      } catch (e) {
        currentTodos = [];
      }
    }

    // 1. Transcription using gpt-4o-mini-transcribe-2025-12-15
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "gpt-4o-mini-transcribe-2025-12-15",
    });

    const transcribedText = transcription.text;

    // 2. Chat completion with gpt-5.4-mini-2026-03-17 for tool calling
    let messages: any[] = [
      {
        role: "system",
        content: "You are a helpful voice assistant. You manage a simple todo list AND answer questions from a knowledge base. Use tool calls to read (listTasks) and change the list (addTask, completeTask, updateTask, deleteTask) — never claim to have done so without a tool call. When the user asks a question that is not about the todo list, call searchKnowledge to retrieve relevant information and answer based ONLY on what it returns; if it returns nothing relevant, say you don't have that information. When the user refers to a task by wording or position (e.g. 'the last one', 'the latest item', 'the coffee task'), match it against the current list and act using that task's exact id. Each task has a createdAt timestamp; the most recently added task has the largest createdAt. Keep conversational responses concise, suitable for TTS."
      },
      {
        role: "user",
        content: `Current List State: ${JSON.stringify(currentTodos)}. User instruction: ${transcribedText}`
      }
    ];

    const tools: any[] = [
      {
        type: "function",
        function: {
          name: "listTasks",
          description: "Read the current todo list (id, text, completed status, createdAt for every task). Call this to answer questions about the list or to resolve a task referred to by name or position before acting on it.",
          parameters: { type: "object", properties: {}, required: [] }
        }
      },
      {
        type: "function",
        function: {
          name: "addTask",
          description: "Add a new todo item to the list",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "The content of the todo item" }
            },
            required: ["text"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "completeTask",
          description: "Mark a todo item as completed",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "The unique ID of the todo item" }
            },
            required: ["id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "updateTask",
          description: "Change the text/wording of an existing todo item",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "The unique ID of the todo item" },
              text: { type: "string", description: "The new content for the todo item" }
            },
            required: ["id", "text"]
          }
        }
      }
    ];

    // Add deleteTask tool to array
    tools.push({
      type: "function",
      function: {
        name: "deleteTask",
        description: "Remove a todo item from the list",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "The unique ID of the todo item" }
          },
          required: ["id"]
        }
      }
    });

    // Knowledge-base retrieval (RAG over Chroma Cloud).
    tools.push({
      type: "function",
      function: {
        name: "searchKnowledge",
        description: "Search the knowledge base to answer the user's question. Use this for any informational question that isn't about managing the todo list. Returns relevant passages; answer only from them.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query — usually the user's question" }
          },
          required: ["query"]
        }
      }
    });

    let response = await openai.chat.completions.create({
      model: "gpt-5.4-mini-2026-03-17",
      messages,
      tools,
      tool_choice: "auto"
    });

    let assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    if (assistantMessage.tool_calls) {
      for (const toolCall of assistantMessage.tool_calls) {
        const { name, arguments: argsString } = (toolCall as any).function;
        const args = JSON.parse(argsString || "{}");
        let result = "";

        if (name === "listTasks") {
          result = currentTodos.length
            ? JSON.stringify(currentTodos.map((t: { id: string; text: string; completed: boolean; createdAt?: number }) => ({
                id: t.id,
                text: t.text,
                completed: t.completed,
                addedAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
              })))
            : "The todo list is empty.";
        } else if (name === "addTask") {
          const newTodo = { id: Math.random().toString(36).substring(2, 9), text: args.text, completed: false, createdAt: Date.now() };
          currentTodos.push(newTodo);
          result = `Successfully added: "${args.text}"`;
        } else if (name === "completeTask") {
          const todo = currentTodos.find((t: any) => t.id === args.id);
          if (todo) { todo.completed = true; result = `Completed task ID ${args.id}`; }
          else { result = `Task ID ${args.id} not found`; }
        } else if (name === "updateTask") {
          const todo = currentTodos.find((t: { id: string; text: string }) => t.id === args.id);
          if (todo) { todo.text = args.text; result = `Updated task ID ${args.id} to "${args.text}"`; }
          else { result = `Task ID ${args.id} not found`; }
        } else if (name === "deleteTask") {
          const len = currentTodos.length;
          currentTodos = currentTodos.filter((t: any) => t.id !== args.id);
          result = currentTodos.length < len ? `Deleted task ID ${args.id}` : `Task ID ${args.id} not found`;
        } else if (name === "searchKnowledge") {
          try {
            const hits = await searchKnowledge(KB_NAMESPACE, openai, args.query || "");
            result = hits.length
              ? JSON.stringify(hits.map((h) => ({ title: h.title, text: h.text })))
              : "No relevant information found in the knowledge base.";
          } catch (e: any) {
            result = `Knowledge base unavailable: ${e.message}`;
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result
        });
      }

      // Get final conversational text
      const secondResponse = await openai.chat.completions.create({
        model: "gpt-5.4-mini-2026-03-17",
        messages
      });
      assistantMessage = secondResponse.choices[0].message;
    }

    const textResponse = assistantMessage.content || "I have updated your todo list.";

    // 3. OpenAI Text-to-Speech API (using gpt-4o-mini-tts-2025-12-15)
    let audioBase64 = "";
    try {
      const mp3 = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts-2025-12-15",
        voice: "ash",
        input: textResponse,
      });
      const audioBuffer = Buffer.from(await mp3.arrayBuffer());
      audioBase64 = audioBuffer.toString("base64");
    } catch (ttsErr: any) {
      console.error("[OpenAI TTS Error] Speech generation failed:", ttsErr);
    }

    return NextResponse.json({
      transcript: transcribedText,
      todos: currentTodos,
      assistantText: textResponse,
      audioBase64: audioBase64
    });
  } catch (error: any) {
    console.error("Error in voice-agent api:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}