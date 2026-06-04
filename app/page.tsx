"use client";

import { useState, useRef } from "react";
import { Mic, Square, Trash2, CheckCircle2, Circle, Loader2, Sparkles, Volume2 } from "lucide-react";

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

export default function Home() {
  const [todos, setTodos] = useState<Todo[]>([
    { id: "1", text: "Welcome to Voice Todo!", completed: false },
    { id: "2", text: "Try saying: 'Add buy some coffee'", completed: false }
  ]);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [assistantText, setAssistantText] = useState("Hello! I am your voice-activated todo agent. Tap the microphone and say something like 'Add review documents' or 'Complete task 1' to manage your list.");
  const [manualInput, setManualInput] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        await sendVoiceRequest(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Microphone permission denied or unsupported.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
      setIsRecording(false);
    }
  };

  const sendVoiceRequest = async (audioBlob: Blob) => {
    setIsProcessing(true);
    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "audio.webm");
      formData.append("todos", JSON.stringify(todos));

      const res = await fetch("/api/voice-agent", { method: "POST", body: formData });
      if (!res.ok) throw new Error("API failed to process audio");

      const data = await res.json();
      if (data.transcript) setTranscript(data.transcript);
      if (data.assistantText) setAssistantText(data.assistantText);
      if (data.todos) setTodos(data.todos);

      if (data.audioBase64) {
        const audio = new Audio("data:audio/mp3;base64," + data.audioBase64);
        audio.onplay = () => setIsAudioPlaying(true);
        audio.onended = () => setIsAudioPlaying(false);
        audio.onerror = () => setIsAudioPlaying(false);
        await audio.play();
      }
    } catch (err) {
      console.error("API error:", err);
      setAssistantText("Sorry, I had an error processing that voice instruction.");
    } finally {
      setIsProcessing(false);
    }
  };

  const addManualTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    setTodos([...todos, { id: Math.random().toString(36).substring(2, 9), text: manualInput.trim(), completed: false }]);
    setManualInput("");
  };

  const toggleTask = (id: string) => {
    setTodos(todos.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  };

  const deleteTask = (id: string) => {
    setTodos(todos.filter(t => t.id !== id));
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center p-4 sm:p-8">
      <div className="w-full max-w-4xl flex flex-col gap-6">
        <header className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-indigo-500 animate-pulse" />
            <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              VoiceTodo Agent
            </h1>
          </div>
          <span className="text-xs bg-slate-900 border border-slate-800 text-slate-400 px-3 py-1 rounded-full">Next.js App</span>
        </header>

        {/* Voice Control Panel */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1 bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col items-center justify-between gap-6 min-h-[300px]">
            <h2 className="text-lg font-semibold text-slate-200 self-start">Voice Control</h2>
            <div className="flex flex-col items-center gap-4">
              <button
                type="button"
                onClick={isRecording ? stopRecording : startRecording}
                disabled={isProcessing}
                className={`h-24 w-24 rounded-full flex items-center justify-center border-4 transition-all duration-300 shadow-lg ${
                  isRecording
                    ? "bg-red-500 border-red-400 hover:bg-red-600 animate-pulse scale-105 shadow-red-900/40"
                    : isProcessing
                    ? "bg-slate-800 border-slate-700 cursor-not-allowed"
                    : "bg-emerald-600 border-emerald-500 hover:bg-emerald-700 shadow-emerald-900/20"
                }`}
              >
                {isProcessing ? (
                  <Loader2 className="h-10 w-10 text-slate-400 animate-spin" />
                ) : isRecording ? (
                  <Square className="h-10 w-10 text-white fill-white" />
                ) : (
                  <Mic className="h-10 w-10 text-white" />
                )}
              </button>
              <div className="text-center">
                <p className={`text-sm font-medium ${isRecording ? "text-red-400 font-semibold" : "text-slate-400"}`}>
                  {isRecording ? "Recording Audio..." : isProcessing ? "Processing State..." : "Ready to Talk"}
                </p>
                <p className="text-xs text-slate-500 mt-1">Tap button to toggle</p>
              </div>
            </div>

            {isAudioPlaying && (
              <div className="flex items-center gap-2 bg-indigo-950/40 border border-indigo-900/50 px-4 py-2 rounded-xl w-full justify-center text-xs text-indigo-400">
                <Volume2 className="h-4 w-4 animate-bounce" />
                <span>Assistant is speaking...</span>
              </div>
            )}
          </div>
          <div className="md:col-span-2 flex flex-col gap-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-3 flex-1">
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Recognized Speech</h3>
              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 min-h-[60px] flex items-center">
                {transcript ? (
                  <p className="text-slate-200 text-sm italic">\"{transcript}\"</p>
                ) : (
                  <p className="text-slate-600 text-xs italic">User speech transcript will appear here...</p>
                )}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-3 flex-1">
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Agent Response</h3>
              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 min-h-[90px] flex items-start gap-3">
                <div className="bg-indigo-950/60 border border-indigo-800/50 p-2 rounded-lg text-indigo-400 shrink-0">
                  <Sparkles className="h-4 w-4" />
                </div>
                <p className="text-slate-300 text-sm leading-relaxed">{assistantText}</p>
              </div>
            </div>
          </div>
        </section>

        {/* Todo List Display */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-200">Todo List State</h2>
            <span className="text-xs bg-slate-800 text-slate-400 px-2.5 py-1 rounded-full font-medium">
              {todos.filter(t => !t.completed).length} remaining
            </span>
          </div>

          {/* Manual input form */}
          <form onSubmit={addManualTask} className="flex gap-2">
            <input
              type="text"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              placeholder="Type a task manually..."
              className="flex-1 bg-slate-950 border border-slate-800 focus:border-indigo-500 rounded-xl px-4 py-2.5 text-sm outline-none transition"
            />
            <button
              type="submit"
              className="bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-sm font-semibold rounded-xl px-5 transition shrink-0"
            >
              Add Task
            </button>
          </form>

          {/* List display */}
          <div className="flex flex-col gap-2 mt-2">
            {todos.length === 0 ? (
              <p className="text-slate-500 text-sm text-center py-6">Your todo list is empty. Add a task!</p>
            ) : (
              todos.map((todo) => (
                <div
                  key={todo.id}
                  className={`flex items-center justify-between p-4 rounded-xl border transition ${
                    todo.completed
                      ? "bg-slate-950/40 border-slate-900 text-slate-500"
                      : "bg-slate-950 border-slate-800/80 hover:border-slate-700 text-slate-200"
                  }`}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0 mr-4">
                    <button
                      type="button"
                      onClick={() => toggleTask(todo.id)}
                      className="text-slate-500 hover:text-indigo-400 transition shrink-0"
                    >
                      {todo.completed ? (
                        <CheckCircle2 className="h-5 w-5 text-indigo-500" />
                      ) : (
                        <Circle className="h-5 w-5" />
                      )}
                    </button>
                    <span className={`text-sm truncate ${todo.completed ? "line-through text-slate-600" : ""}`}>
                      {todo.text}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase font-mono bg-slate-900 px-2 py-0.5 rounded text-slate-500">ID: {todo.id}</span>
                    <button
                      type="button"
                      onClick={() => deleteTask(todo.id)}
                      className="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-900 transition shrink-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}