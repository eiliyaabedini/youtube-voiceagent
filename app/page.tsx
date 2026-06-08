"use client";

import { useState, useRef, useEffect } from "react";
import { Mic, Square, Trash2, CheckCircle2, Circle, Loader2, Sparkles, Volume2, Settings, Key, X, Eye, EyeOff, ExternalLink, Radio, Video, Power, BookOpen } from "lucide-react";
import { connectRealtime, RealtimeAuthError, type Todo, type RealtimeController, type RealtimeStatus } from "./lib/realtime";
import { connectAvatar, AvatarAuthError, type AvatarController, type AvatarStatus } from "./lib/avatar";
import { connectTranscribe, TranscribeAuthError, type TranscribeController } from "./lib/transcribe";

const API_KEY_STORAGE = "openai_api_key";
const HEYGEN_KEY_STORAGE = "heygen_api_key";

type Mode = "chained" | "realtime" | "avatar";

export default function Home() {
  const [todos, setTodos] = useState<Todo[]>([
    { id: "1", text: "Welcome to Voice Todo!", completed: false, createdAt: 1 },
    { id: "2", text: "Try saying: 'Add buy some coffee'", completed: false, createdAt: 2 }
  ]);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [assistantText, setAssistantText] = useState("Hello! I am your voice-activated todo agent. Tap the microphone and say something like 'Add review documents' or 'Complete task 1' to manage your list.");
  const [manualInput, setManualInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [heygenKey, setHeygenKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [heygenKeyInput, setHeygenKeyInput] = useState("");
  const [showHeygenKey, setShowHeygenKey] = useState(false);
  const [mode, setMode] = useState<Mode>("chained");
  const [rtStatus, setRtStatus] = useState<RealtimeStatus>("idle");
  const [avStatus, setAvStatus] = useState<AvatarStatus>("idle");
  const [avListening, setAvListening] = useState(false);
  const [txReady, setTxReady] = useState(false);
  const [kbTitle, setKbTitle] = useState("");
  const [kbText, setKbText] = useState("");
  const [kbSources, setKbSources] = useState<{ sourceId: string; title: string; chunks: number }[]>([]);
  const [kbBusy, setKbBusy] = useState(false);
  const [kbMsg, setKbMsg] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const rtControllerRef = useRef<RealtimeController | null>(null);
  const avControllerRef = useRef<AvatarController | null>(null);
  const txControllerRef = useRef<TranscribeController | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const avatarVideoRef = useRef<HTMLVideoElement | null>(null);
  // Keep a ref in sync with todos so the long-lived realtime data-channel handler
  // always reads the current list instead of a stale closure snapshot.
  const todosRef = useRef<Todo[]>(todos);
  useEffect(() => { todosRef.current = todos; }, [todos]);

  // Load the user's saved keys on first load; prompt for the OpenAI key if it's missing
  // (it's required by every mode; the HeyGen key is only needed for the Avatar tab).
  useEffect(() => {
    const stored = localStorage.getItem(API_KEY_STORAGE);
    if (stored) {
      setApiKey(stored);
    } else {
      setShowSettings(true);
    }
    const storedHeygen = localStorage.getItem(HEYGEN_KEY_STORAGE);
    if (storedHeygen) setHeygenKey(storedHeygen);
  }, []);

  const openSettings = () => {
    setKeyInput(apiKey);
    setHeygenKeyInput(heygenKey);
    setShowKey(false);
    setShowHeygenKey(false);
    setShowSettings(true);
  };

  const saveKeys = () => {
    const trimmed = keyInput.trim();
    const trimmedHeygen = heygenKeyInput.trim();
    if (!trimmed && !trimmedHeygen) return;
    if (trimmed) {
      localStorage.setItem(API_KEY_STORAGE, trimmed);
      setApiKey(trimmed);
    }
    if (trimmedHeygen) {
      localStorage.setItem(HEYGEN_KEY_STORAGE, trimmedHeygen);
      setHeygenKey(trimmedHeygen);
    }
    setShowSettings(false);
    setAssistantText("Great, your keys are set! Pick a mode and tell me what to add to your list.");
  };

  const clearKey = () => {
    localStorage.removeItem(API_KEY_STORAGE);
    setApiKey("");
    setKeyInput("");
  };

  const clearHeygenKey = () => {
    localStorage.removeItem(HEYGEN_KEY_STORAGE);
    setHeygenKey("");
    setHeygenKeyInput("");
  };

  const startRecording = async () => {
    if (!apiKey) {
      setAssistantText("Please add your OpenAI API key in Settings before recording.");
      openSettings();
      return;
    }
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

  const stopRealtime = () => {
    rtControllerRef.current?.stop();
    rtControllerRef.current = null;
    setRtStatus("idle");
  };

  const stopAvatar = () => {
    avControllerRef.current?.stop();
    avControllerRef.current = null;
    txControllerRef.current?.stop();
    txControllerRef.current = null;
    setAvStatus("idle");
    setAvListening(false);
    setTxReady(false);
  };

  // Tear down any live session on unmount.
  useEffect(() => () => { stopRealtime(); stopAvatar(); }, []);

  // Lazily open the realtime session on the first mic tap; tap again to disconnect.
  const toggleRealtime = async () => {
    if (rtControllerRef.current) {
      stopRealtime();
      return;
    }
    if (!apiKey) {
      setAssistantText("Please add your OpenAI API key in Settings before recording.");
      openSettings();
      return;
    }
    // Don't let two mic captures coexist.
    stopRecording();
    const audioEl = remoteAudioRef.current;
    if (!audioEl) return;
    try {
      setRtStatus("connecting");
      const controller = await connectRealtime({
        apiKey,
        audioEl,
        getTodos: () => todosRef.current,
        setTodos,
        onStatus: setRtStatus,
        onTranscript: setTranscript,
        onAssistantText: setAssistantText,
        onError: (m) => setAssistantText(m),
      });
      rtControllerRef.current = controller;
    } catch (err) {
      stopRealtime();
      if (err instanceof RealtimeAuthError) {
        setAssistantText("Your OpenAI API key is missing or invalid. Please update it in Settings.");
        openSettings();
      } else {
        console.error("Realtime error:", err);
        setAssistantText("Sorry, I couldn't start the realtime session.");
      }
    }
  };

  // Lazily open the avatar session on the first "go live" tap; tap again to disconnect.
  // The session persists across commands; the push-to-talk mic drives each request.
  // Connect the avatar (video) + transcription (mic) sessions. Once live, the same big
  // control becomes a push-to-talk mic; the separate "End session" button tears it down.
  const startAvatarSession = async () => {
    if (!apiKey || !heygenKey) {
      setAssistantText(
        !apiKey
          ? "Please add your OpenAI API key in Settings before using the avatar."
          : "Please add your HeyGen API key in Settings before using the avatar."
      );
      openSettings();
      return;
    }
    // Don't let two mic captures coexist.
    stopRecording();
    const videoEl = avatarVideoRef.current;
    if (!videoEl) return;
    try {
      setAvStatus("connecting");
      // 1. HeyGen avatar (video out).
      const controller = await connectAvatar({
        heygenKey,
        videoEl,
        onStatus: setAvStatus,
        onError: (m) => setAssistantText(m),
        // Session ended on its own (e.g. sandbox cap) — tear down both and let a tap reconnect.
        onClosed: () => { stopAvatar(); },
      });
      avControllerRef.current = controller;
      // 2. gpt-realtime-whisper transcription (mic in). Push-to-talk is gated on txReady.
      const transcriber = await connectTranscribe({
        apiKey,
        onStatus: (s) => setTxReady(s === "ready"),
        onPartial: (t) => setTranscript(t),
        onError: (m) => setAssistantText(m),
      });
      txControllerRef.current = transcriber;
    } catch (err) {
      stopAvatar();
      if (err instanceof AvatarAuthError) {
        setAssistantText("Your HeyGen API key is missing or invalid. Please update it in Settings.");
        openSettings();
      } else if (err instanceof TranscribeAuthError) {
        setAssistantText("Your OpenAI API key is missing or invalid. Please update it in Settings.");
        openSettings();
      } else {
        console.error("Avatar error:", err);
        setAssistantText("Sorry, I couldn't start the avatar session.");
      }
    }
  };

  // One control drives the whole avatar flow: go live → tap to speak → tap to send.
  // (Disabled in between states, so this only fires when an action is valid.)
  const handleAvatarTap = () => {
    if (!avControllerRef.current) { startAvatarSession(); return; }
    if (avListening) { endAvatarUtterance(); return; }
    startAvatarUtterance();
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    // Tear down every capture/session before switching (all stops are idempotent).
    stopRecording();
    stopRealtime();
    stopAvatar();
    setMode(next);
  };

  const sendVoiceRequest = async (audioBlob: Blob) => {
    setIsProcessing(true);
    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "audio.webm");
      formData.append("todos", JSON.stringify(todos));

      const res = await fetch("/api/voice-agent", {
        method: "POST",
        headers: { "x-openai-key": apiKey },
        body: formData,
      });
      if (res.status === 401) {
        setAssistantText("Your OpenAI API key is missing or invalid. Please update it in Settings.");
        openSettings();
        return;
      }
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

  // Avatar push-to-talk. The mic is owned by the live gpt-realtime-whisper session, so a
  // tap clears the buffer to start, and the next tap commits + resolves the transcript.
  const startAvatarUtterance = () => {
    if (!txControllerRef.current || isProcessing) return;
    setTranscript("");
    txControllerRef.current.startUtterance();
    setAvListening(true);
  };

  const endAvatarUtterance = async () => {
    const tx = txControllerRef.current;
    if (!tx) return;
    setAvListening(false);
    setIsProcessing(true);
    try {
      const transcript = (await tx.endUtterance()).trim();
      if (!transcript) {
        setAssistantText("I didn't catch that — tap and try again.");
        return;
      }
      setTranscript(transcript);
      await sendAvatarText(transcript);
    } catch (err) {
      console.error("Avatar utterance error:", err);
      setAssistantText("Sorry, I had an error with that command.");
    } finally {
      setIsProcessing(false);
    }
  };

  // Send the finished transcript to the avatar brain (tool-calls + PCM TTS); the reply
  // audio is spoken by the live avatar via repeatAudio() instead of an <audio> element.
  const sendAvatarText = async (transcript: string) => {
    const res = await fetch("/api/avatar-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-openai-key": apiKey },
      body: JSON.stringify({ transcript, todos }),
    });
    if (res.status === 401) {
      setAssistantText("Your OpenAI API key is missing or invalid. Please update it in Settings.");
      openSettings();
      return;
    }
    if (!res.ok) throw new Error("avatar-agent failed");

    const data = await res.json();
    if (data.assistantText) setAssistantText(data.assistantText);
    if (data.todos) setTodos(data.todos);
    // If the avatar session dropped meanwhile, the list/text still update; audio is skipped.
    if (data.audioBase64 && avControllerRef.current) {
      avControllerRef.current.speak(data.audioBase64);
    }
  };

  const addManualTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    setTodos([...todos, { id: Math.random().toString(36).substring(2, 9), text: manualInput.trim(), completed: false, createdAt: Date.now() }]);
    setManualInput("");
  };

  const toggleTask = (id: string) => {
    setTodos(todos.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  };

  const deleteTask = (id: string) => {
    setTodos(todos.filter(t => t.id !== id));
  };

  // Knowledge base: load the indexed sources, and add new knowledge (chunked + embedded
  // server-side into Chroma Cloud). All three agents can then answer from it via RAG.
  const loadKnowledge = async () => {
    try {
      const res = await fetch("/api/knowledge");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.sources)) setKbSources(data.sources);
    } catch {
      /* Chroma not configured yet — leave the list empty. */
    }
  };

  useEffect(() => { loadKnowledge(); }, []);

  const addKnowledge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kbText.trim()) return;
    if (!apiKey) {
      setKbMsg("Add your OpenAI API key in Settings first.");
      openSettings();
      return;
    }
    setKbBusy(true);
    setKbMsg("");
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-openai-key": apiKey },
        body: JSON.stringify({ title: kbTitle.trim(), text: kbText.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKbMsg(data.error || "Failed to add knowledge.");
      } else {
        setKbMsg(`Added "${data.title}" (${data.chunks} chunk${data.chunks === 1 ? "" : "s"}).`);
        setKbTitle("");
        setKbText("");
        loadKnowledge();
      }
    } catch (err: any) {
      setKbMsg(err.message || "Failed to add knowledge.");
    } finally {
      setKbBusy(false);
    }
  };

  const rtConnecting = rtStatus === "connecting";
  const rtActive = rtStatus === "live" || rtStatus === "speaking";
  const avConnecting = avStatus === "connecting";
  const avLive = avStatus === "live" || avStatus === "speaking";
  const avIdle = avStatus === "idle";
  const avSpeaking = avStatus === "speaking";
  // The single avatar control is actionable as a push-to-talk mic only when the session
  // is live, the mic is ready, and nothing is in flight.
  const avTalkReady = avLive && txReady && !isProcessing && !avSpeaking;

  return (
    <>
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center p-4 sm:p-8">
      <audio ref={remoteAudioRef} autoPlay className="hidden" />
      <div className="w-full max-w-4xl flex flex-col gap-6">
        <header className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-indigo-500 animate-pulse" />
            <h1 className="text-xl sm:text-2xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              VoiceTodo Agent
            </h1>
          </div>
          <button
            type="button"
            onClick={openSettings}
            className="relative flex items-center gap-1.5 text-xs bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 px-3 py-1.5 rounded-full transition"
          >
            <Settings className="h-3.5 w-3.5" />
            <span>Settings</span>
            <span className={`h-2 w-2 rounded-full ${apiKey ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`} />
          </button>
        </header>

        {/* Voice Control Panel */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1 bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col items-center justify-between gap-6 min-h-[300px]">
            <div className="flex flex-col gap-3 w-full">
              <h2 className="text-lg font-semibold text-slate-200">Voice Control</h2>
              {/* Mode switch: existing chained pipeline vs. gpt-realtime-2 live session */}
              <div className="flex bg-slate-950 border border-slate-800 rounded-full p-1 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => switchMode("chained")}
                  className={`flex-1 min-w-0 truncate text-center px-2 py-1.5 rounded-full transition ${
                    mode === "chained" ? "bg-slate-800 text-slate-100" : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  Chained
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("realtime")}
                  className={`flex-1 min-w-0 truncate text-center px-2 py-1.5 rounded-full transition ${
                    mode === "realtime" ? "bg-indigo-600 text-white" : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  Realtime
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("avatar")}
                  className={`flex-1 min-w-0 truncate text-center px-2 py-1.5 rounded-full transition ${
                    mode === "avatar" ? "bg-cyan-600 text-white" : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  Avatar
                </button>
              </div>
            </div>
            <div className="flex flex-col items-center gap-4">
              {mode === "chained" ? (
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
              ) : mode === "realtime" ? (
                <button
                  type="button"
                  onClick={toggleRealtime}
                  disabled={rtConnecting}
                  className={`h-24 w-24 rounded-full flex items-center justify-center border-4 transition-all duration-300 shadow-lg ${
                    rtConnecting
                      ? "bg-slate-800 border-slate-700 cursor-not-allowed"
                      : rtActive
                      ? "bg-red-500 border-red-400 hover:bg-red-600 animate-pulse scale-105 shadow-red-900/40"
                      : "bg-indigo-600 border-indigo-500 hover:bg-indigo-700 shadow-indigo-900/20"
                  }`}
                >
                  {rtConnecting ? (
                    <Loader2 className="h-10 w-10 text-slate-400 animate-spin" />
                  ) : rtActive ? (
                    <Square className="h-10 w-10 text-white fill-white" />
                  ) : (
                    <Radio className="h-10 w-10 text-white" />
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleAvatarTap}
                  disabled={!(avIdle || avTalkReady || avListening)}
                  className={`h-24 w-24 rounded-full flex items-center justify-center border-4 transition-all duration-300 shadow-lg ${
                    avListening
                      ? "bg-red-500 border-red-400 hover:bg-red-600 animate-pulse scale-105 shadow-red-900/40"
                      : avTalkReady
                      ? "bg-emerald-600 border-emerald-500 hover:bg-emerald-700 shadow-emerald-900/20"
                      : avIdle
                      ? "bg-cyan-600 border-cyan-500 hover:bg-cyan-700 shadow-cyan-900/20"
                      : "bg-slate-800 border-slate-700 cursor-not-allowed"
                  }`}
                >
                  {avConnecting || isProcessing ? (
                    <Loader2 className="h-10 w-10 text-slate-400 animate-spin" />
                  ) : avSpeaking ? (
                    <Volume2 className="h-10 w-10 text-cyan-300 animate-pulse" />
                  ) : avListening ? (
                    <Square className="h-10 w-10 text-white fill-white" />
                  ) : avIdle ? (
                    <Video className="h-10 w-10 text-white" />
                  ) : (
                    <Mic className="h-10 w-10 text-white" />
                  )}
                </button>
              )}
              <div className="text-center">
                {mode === "chained" ? (
                  <>
                    <p className={`text-sm font-medium ${isRecording ? "text-red-400 font-semibold" : "text-slate-400"}`}>
                      {isRecording ? "Recording Audio..." : isProcessing ? "Processing State..." : "Ready to Talk"}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">Tap button to toggle</p>
                  </>
                ) : mode === "realtime" ? (
                  <>
                    <p className={`text-sm font-medium ${rtActive ? "text-indigo-400 font-semibold" : "text-slate-400"}`}>
                      {rtConnecting ? "Connecting..." : rtActive ? "Live — just talk" : "Tap to go live"}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">{rtActive ? "Tap to end session" : "Realtime speech-to-speech"}</p>
                  </>
                ) : (
                  <>
                    <p className={`text-sm font-medium ${avListening ? "text-red-400 font-semibold" : avTalkReady ? "text-emerald-400 font-semibold" : "text-slate-400"}`}>
                      {avIdle
                        ? "Tap to go live"
                        : avConnecting
                        ? "Connecting…"
                        : !txReady
                        ? "Preparing mic…"
                        : avSpeaking
                        ? "Avatar speaking…"
                        : isProcessing
                        ? "Thinking…"
                        : avListening
                        ? "Listening… tap to send"
                        : "Tap to speak"}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {avIdle
                        ? "HeyGen avatar · realtime STT"
                        : avListening
                        ? "Tap when you're done"
                        : avTalkReady
                        ? "Tap, speak, tap to send"
                        : " "}
                    </p>
                  </>
                )}
              </div>

              {/* End the live session — clearly secondary to the talk button above. */}
              {mode === "avatar" && !avIdle && (
                <button
                  type="button"
                  onClick={stopAvatar}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-400 border border-slate-800 hover:border-red-900/60 rounded-full px-3 py-1.5 transition"
                >
                  <Power className="h-3.5 w-3.5" />
                  <span>End session</span>
                </button>
              )}
            </div>

            {isAudioPlaying && (
              <div className="flex items-center gap-2 bg-indigo-950/40 border border-indigo-900/50 px-4 py-2 rounded-xl w-full justify-center text-xs text-indigo-400">
                <Volume2 className="h-4 w-4 animate-bounce" />
                <span>Assistant is speaking...</span>
              </div>
            )}

            {mode === "realtime" && rtActive && (
              <div className="flex items-center gap-2 bg-indigo-950/40 border border-indigo-900/50 px-4 py-2 rounded-xl w-full justify-center text-xs text-indigo-400">
                {rtStatus === "speaking" ? (
                  <>
                    <Volume2 className="h-4 w-4 animate-bounce" />
                    <span>Assistant is speaking...</span>
                  </>
                ) : (
                  <>
                    <Radio className="h-4 w-4 animate-pulse" />
                    <span>Listening — speak anytime</span>
                  </>
                )}
              </div>
            )}

            {mode === "avatar" && avStatus === "speaking" && (
              <div className="flex items-center gap-2 bg-cyan-950/40 border border-cyan-900/50 px-4 py-2 rounded-xl w-full justify-center text-xs text-cyan-400">
                <Volume2 className="h-4 w-4 animate-bounce" />
                <span>Avatar is speaking...</span>
              </div>
            )}
          </div>
          <div className="md:col-span-2 flex flex-col gap-6">
            {mode === "avatar" && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-2">
                <video
                  ref={avatarVideoRef}
                  autoPlay
                  playsInline
                  className="w-full aspect-video rounded-xl bg-slate-950 object-cover"
                />
              </div>
            )}
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

        {/* Knowledge Base — RAG source documents (Chroma Cloud) */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-emerald-400" />
              Knowledge Base
            </h2>
            <span className="text-xs bg-slate-800 text-slate-400 px-2.5 py-1 rounded-full font-medium">
              {kbSources.length} source{kbSources.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-xs text-slate-500 -mt-2">
            Add knowledge here, then ask any agent a question — it answers from these docs via RAG.
          </p>

          <form onSubmit={addKnowledge} className="flex flex-col gap-2">
            <input
              type="text"
              value={kbTitle}
              onChange={(e) => setKbTitle(e.target.value)}
              placeholder="Title (optional)"
              className="bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-xl px-4 py-2.5 text-sm outline-none transition"
            />
            <textarea
              value={kbText}
              onChange={(e) => setKbText(e.target.value)}
              placeholder="Paste knowledge text the agents should be able to answer from..."
              rows={4}
              className="bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-xl px-4 py-2.5 text-sm outline-none transition resize-y"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-500">{kbMsg}</span>
              <button
                type="submit"
                disabled={kbBusy || !kbText.trim()}
                className="bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold rounded-xl px-5 py-2.5 transition shrink-0 flex items-center gap-2"
              >
                {kbBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookOpen className="h-4 w-4" />}
                {kbBusy ? "Indexing..." : "Add Knowledge"}
              </button>
            </div>
          </form>

          <div className="flex flex-col gap-2 mt-1">
            {kbSources.length === 0 ? (
              <p className="text-slate-500 text-sm text-center py-4">No knowledge yet. Add a document above.</p>
            ) : (
              kbSources.map((s) => (
                <div
                  key={s.sourceId}
                  className="flex items-center justify-between p-3 rounded-xl border bg-slate-950 border-slate-800/80 text-slate-200"
                >
                  <span className="text-sm truncate mr-4">{s.title}</span>
                  <span className="text-[10px] uppercase font-mono bg-slate-900 px-2 py-0.5 rounded text-slate-500 shrink-0">
                    {s.chunks} chunk{s.chunks === 1 ? "" : "s"}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </main>

    {showSettings && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 flex flex-col gap-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="bg-indigo-950/60 border border-indigo-800/50 p-2 rounded-lg text-indigo-400">
                <Key className="h-4 w-4" />
              </div>
              <h2 className="text-lg font-semibold text-slate-100">API Keys</h2>
            </div>
            {apiKey && (
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="text-slate-500 hover:text-slate-300 transition"
                aria-label="Close settings"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>

          <p className="text-sm text-slate-400 leading-relaxed">
            This app uses your own keys. They are stored only in this browser and sent directly with each request — never saved on the server. The OpenAI key powers all three modes; the HeyGen key is only needed for the Avatar tab.
          </p>

          {/* OpenAI key — required by every mode */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">OpenAI Secret Key</label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveKeys(); }}
                placeholder="sk-..."
                autoFocus
                className="w-full bg-slate-950 border border-slate-800 focus:border-indigo-500 rounded-xl pl-4 pr-10 py-2.5 text-sm outline-none transition font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
                aria-label={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex items-center justify-between">
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition w-fit"
              >
                Get an API key <ExternalLink className="h-3 w-3" />
              </a>
              {apiKey && (
                <button
                  type="button"
                  onClick={clearKey}
                  className="text-xs text-slate-500 hover:text-red-400 transition"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* HeyGen key — only needed for the Avatar tab */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">HeyGen Secret Key</label>
            <div className="relative">
              <input
                type={showHeygenKey ? "text" : "password"}
                value={heygenKeyInput}
                onChange={(e) => setHeygenKeyInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveKeys(); }}
                placeholder="HeyGen API key"
                className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl pl-4 pr-10 py-2.5 text-sm outline-none transition font-mono"
              />
              <button
                type="button"
                onClick={() => setShowHeygenKey(!showHeygenKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
                aria-label={showHeygenKey ? "Hide key" : "Show key"}
              >
                {showHeygenKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex items-center justify-between">
              <a
                href="https://app.liveavatar.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition w-fit"
              >
                Get a HeyGen key <ExternalLink className="h-3 w-3" />
              </a>
              {heygenKey && (
                <button
                  type="button"
                  onClick={clearHeygenKey}
                  className="text-xs text-slate-500 hover:text-red-400 transition"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={saveKeys}
              disabled={!keyInput.trim() && !heygenKeyInput.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold rounded-xl px-5 py-2.5 transition"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}