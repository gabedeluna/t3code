// Runs on the audio thread, where these globals exist but the DOM types do not declare them.
declare const AudioWorkletProcessor: {
  prototype: { readonly port: MessagePort };
  new (): { readonly port: MessagePort };
};
declare function registerProcessor(name: string, processor: unknown): void;

// 100 ms at the 16 kHz the context runs at: short enough for live words, long enough to batch.
const CHUNK_SAMPLES = 1_600;

/** Converts the microphone to 16-bit PCM chunks. A "flush" message sends what is left, then null. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Int16Array(CHUNK_SAMPLES);
  private filled = 0;

  constructor() {
    super();
    this.port.onmessage = () => {
      this.flush();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePorts take no target origin.
      this.port.postMessage(null);
    };
  }

  process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      const clamped = Math.max(-1, Math.min(1, sample));
      this.buffer[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.filled += 1;
      if (this.filled === CHUNK_SAMPLES) this.flush();
    }
    return true;
  }

  private flush(): void {
    if (this.filled === 0) return;
    const chunk = this.buffer.slice(0, this.filled);
    this.filled = 0;
    this.port.postMessage(chunk, [chunk.buffer]);
  }
}

registerProcessor("t3-pcm-capture", PcmCaptureProcessor);
