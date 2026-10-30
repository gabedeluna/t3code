import { VOICE_INPUT_STREAM_SAMPLE_RATE } from "@t3tools/contracts";

import pcmCaptureWorkletUrl from "./pcmCaptureWorklet.ts?worker&url";

export interface PcmCapture {
  /** Delivers the audio still buffered, then releases the microphone. */
  stop(): Promise<void>;
  /** Releases the microphone and drops anything buffered. */
  close(): void;
}

export type OpenPcmCapture = (handlers: {
  readonly onChunk: (pcm: Int16Array) => void;
  /** The microphone went away on its own. */
  readonly onEnded: () => void;
}) => Promise<PcmCapture>;

/**
 * The microphone as mono 16-bit PCM at the realtime rate. The audio context resamples, and
 * the worklet keeps the conversion off the main thread.
 */
export const openPcmCapture: OpenPcmCapture = async ({ onChunk, onEnded }) => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext({ sampleRate: VOICE_INPUT_STREAM_SAMPLE_RATE });
  let closed = false;
  let flushed: (() => void) | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    flushed?.();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };
  try {
    await context.audioWorklet.addModule(pcmCaptureWorkletUrl);
    await context.resume();
  } catch (error) {
    close();
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "t3-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  });
  node.port.onmessage = (event: MessageEvent<Int16Array | null>) => {
    if (event.data === null) flushed?.();
    else if (!closed) onChunk(event.data);
  };
  source.connect(node);
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      if (!closed) onEnded();
    });
  }
  return {
    stop: async () => {
      if (closed) return;
      await new Promise<void>((resolve) => {
        flushed = resolve;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePorts take no target origin.
        node.port.postMessage("flush");
      });
      close();
    },
    close,
  };
};
