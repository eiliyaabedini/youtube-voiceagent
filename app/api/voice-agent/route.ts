import { NextRequest, NextResponse } from "next/server";
import { OpenAI } from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
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
        content: "You are a helpful voice assistant managing a simple todo list. Rely on tool calls to alter the state. Keep conversational responses concise, suitable for TTS."
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

        if (name === "addTask") {
          const newTodo = { id: Math.random().toString(36).substring(2, 9), text: args.text, completed: false };
          currentTodos.push(newTodo);
          result = `Successfully added: "${args.text}"`;
        } else if (name === "completeTask") {
          const todo = currentTodos.find((t: any) => t.id === args.id);
          if (todo) { todo.completed = true; result = `Completed task ID ${args.id}`; }
          else { result = `Task ID ${args.id} not found`; }
        } else if (name === "deleteTask") {
          const len = currentTodos.length;
          currentTodos = currentTodos.filter((t: any) => t.id !== args.id);
          result = currentTodos.length < len ? `Deleted task ID ${args.id}` : `Task ID ${args.id} not found`;
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