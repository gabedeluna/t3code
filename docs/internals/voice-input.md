# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. iOS transcribes on the device. The desktop app sends audio to ElevenLabs
Scribe from its main process, which holds the user's API key in the OS keychain,
so the key never reaches the renderer or any environment. The web app and
environment-backed transcription are not implemented.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

The [desktop transcriber](../../apps/web/src/voiceInput/desktopVoiceTranscriber.ts)
is the exception: the main process cannot cancel its request across IPC, and
nothing else shares that request, so an abort settles at once and the late result
is dropped. Waiting would only keep the next dictation blocked behind a request
whose answer is already unwanted.

On desktop the editor stays editable while dictation runs. When the controller
drops a transcript because the same draft was typed in meanwhile, the
[composer session](../../apps/web/src/voiceInput/composerVoiceSession.ts) places it
at the current cursor instead; only a transcript for a draft the composer has left
is offered for copying.
