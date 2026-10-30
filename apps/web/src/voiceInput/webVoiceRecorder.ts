import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

// Opus in WebM is what Chromium records natively, and ElevenLabs takes it as is.
const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
const RECORDING_URI_PREFIX = "t3-voice-recording:";

export interface CapturedRecording {
  readonly blob: Blob;
  readonly mimeType: string;
}

export interface MicrophoneRecorder extends VoiceRecorder {
  open(): Promise<void>;
  close(): void;
  readRecording(uri: string): CapturedRecording | null;
  deleteRecording(uri: string): void;
}

/**
 * Microphone capture for the shared voice controller. The microphone is open only between
 * `open` and `close`, and each recording stays in memory under an opaque URI until the
 * controller deletes it.
 */
export class WebVoiceRecorder implements MicrophoneRecorder {
  private readonly onStatus: (status: VoiceRecorderStatus) => void;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stopping: Promise<void> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private currentUri: string | null = null;
  private nextRecordingId = 0;
  private readonly recordings = new Map<string, CapturedRecording>();

  /** `onStatus` reports a recording that ended by itself: the time limit or a lost microphone. */
  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  get uri(): string | null {
    return this.currentUri;
  }

  async open(): Promise<void> {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener(
        "ended",
        () => {
          if (this.stream !== stream || !this.recorder) return;
          this.onStatus({
            isFinished: false,
            hasError: true,
            error: "The microphone disconnected.",
            url: null,
          });
        },
        { once: true },
      );
    }
  }

  close(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  async prepareToRecordAsync(): Promise<void> {
    if (!this.stream) throw new Error("The microphone is not open.");
    const mimeType = PREFERRED_MIME_TYPES.find((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    );
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    recorder.addEventListener("error", () => {
      this.onStatus({ isFinished: false, hasError: true, error: "Recording failed.", url: null });
    });
    this.chunks = [];
    this.currentUri = null;
    this.recorder = recorder;
  }

  record(options: { readonly forDuration: number }): void {
    if (!this.recorder) throw new Error("The recorder is not prepared.");
    this.recorder.start();
    this.limitTimer = setTimeout(() => {
      this.limitTimer = null;
      void this.stop().then(() =>
        this.onStatus({ isFinished: true, hasError: false, error: null, url: this.currentUri }),
      );
    }, options.forDuration * 1_000);
  }

  stop(): Promise<void> {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.stopping) return this.stopping;
    const recorder = this.recorder;
    if (!recorder) return Promise.resolve();
    if (recorder.state === "inactive") {
      this.recorder = null;
      return Promise.resolve();
    }
    this.stopping = new Promise<void>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          const mimeType = recorder.mimeType || "audio/webm";
          this.nextRecordingId += 1;
          const uri = `${RECORDING_URI_PREFIX}${this.nextRecordingId}`;
          this.recordings.set(uri, { blob: new Blob(this.chunks, { type: mimeType }), mimeType });
          this.chunks = [];
          this.currentUri = uri;
          this.recorder = null;
          this.stopping = null;
          resolve();
        },
        { once: true },
      );
      recorder.stop();
    });
    return this.stopping;
  }

  readRecording(uri: string): CapturedRecording | null {
    return this.recordings.get(uri) ?? null;
  }

  deleteRecording(uri: string): void {
    this.recordings.delete(uri);
    if (this.currentUri === uri) this.currentUri = null;
  }
}
