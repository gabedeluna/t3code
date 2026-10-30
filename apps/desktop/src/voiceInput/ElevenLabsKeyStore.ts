import type { DesktopVoiceInputStatus } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const KeyDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedKey: Schema.String,
});
const KeyDocumentJson = fromLenientJson(KeyDocument);
const decodeKeyDocumentJson = Schema.decodeEffect(KeyDocumentJson);
const encodeKeyDocumentJson = Schema.encodeEffect(KeyDocumentJson);

const ElevenLabsKeyStoreOperation = Schema.Literals([
  "check-encryption",
  "read",
  "decode",
  "decrypt",
  "encrypt",
  "write",
  "remove",
]);

export class ElevenLabsKeyStoreError extends Schema.TaggedError<ElevenLabsKeyStoreError>()(
  "ElevenLabsKeyStoreError",
  {
    operation: ElevenLabsKeyStoreOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The ElevenLabs key store failed during ${this.operation} at ${this.path}.`;
  }
}

/** The ElevenLabs API key, encrypted with the OS keychain. Only the main process reads it. */
export class ElevenLabsKeyStore extends Context.Service<
  ElevenLabsKeyStore,
  {
    /** A key that cannot be read counts as not configured, so Settings can replace it. */
    readonly status: Effect.Effect<DesktopVoiceInputStatus>;
    readonly get: Effect.Effect<Option.Option<string>, ElevenLabsKeyStoreError>;
    /** An empty key removes the stored one. False when the keychain cannot protect a key. */
    readonly set: (apiKey: string) => Effect.Effect<boolean, ElevenLabsKeyStoreError>;
  }
>()("@t3tools/desktop/voiceInput/ElevenLabsKeyStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const keyPath = path.join(environment.stateDir, "elevenlabs-key.json");
  // Every dictation needs the key, so it is decrypted once; set() keeps the cache current.
  const cachedKey = yield* Ref.make(Option.none<Option.Option<string>>());

  const failure =
    (operation: typeof ElevenLabsKeyStoreOperation.Type) =>
    (cause: unknown): ElevenLabsKeyStoreError =>
      new ElevenLabsKeyStoreError({ operation, path: keyPath, cause });

  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(failure("check-encryption")),
  );

  const readKey = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(keyPath).pipe(
      Effect.asSome,
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(failure("read")(error)),
      ),
    );
    if (Option.isNone(raw) || !(yield* encryptionAvailable)) return Option.none<string>();
    const document = yield* decodeKeyDocumentJson(raw.value).pipe(
      Effect.mapError(failure("decode")),
    );
    const encrypted = yield* Effect.fromResult(Base64.decode(document.encryptedKey)).pipe(
      Effect.mapError(failure("decode")),
    );
    return Option.some(
      yield* safeStorage.decryptString(encrypted).pipe(Effect.mapError(failure("decrypt"))),
    );
  });

  const get = Effect.gen(function* () {
    const cached = yield* Ref.get(cachedKey);
    if (Option.isSome(cached)) return cached.value;
    const key = yield* readKey;
    yield* Ref.set(cachedKey, Option.some(key));
    return key;
  }).pipe(Effect.withSpan("desktop.voiceInput.keyStore.get"));

  const writeKey = Effect.fn("desktop.voiceInput.keyStore.writeKey")(function* (apiKey: string) {
    const encrypted = yield* safeStorage
      .encryptString(apiKey)
      .pipe(Effect.mapError(failure("encrypt")));
    const encoded = yield* encodeKeyDocumentJson({
      version: 1,
      encryptedKey: Base64.encode(encrypted),
    }).pipe(Effect.mapError(failure("write")));
    const tempPath = `${keyPath}.tmp`;
    yield* fileSystem
      .makeDirectory(path.dirname(keyPath), { recursive: true })
      .pipe(Effect.mapError(failure("write")));
    yield* fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.flatMap(() => fileSystem.rename(tempPath, keyPath)),
      Effect.mapError(failure("write")),
      Effect.ensuring(Effect.ignore(fileSystem.remove(tempPath, { force: true }))),
    );
  });

  return ElevenLabsKeyStore.of({
    status: Effect.gen(function* () {
      const available = yield* encryptionAvailable;
      const key = yield* get;
      return { apiKeyConfigured: Option.isSome(key), encryptionAvailable: available };
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read the stored ElevenLabs key.", { error }).pipe(
          Effect.as({
            apiKeyConfigured: false,
            encryptionAvailable: error.operation !== "check-encryption",
          }),
        ),
      ),
      Effect.withSpan("desktop.voiceInput.keyStore.status"),
    ),
    get,
    set: Effect.fn("desktop.voiceInput.keyStore.set")(function* (apiKey) {
      const trimmed = apiKey.trim();
      if (trimmed === "") {
        yield* fileSystem.remove(keyPath, { force: true }).pipe(Effect.mapError(failure("remove")));
        yield* Ref.set(cachedKey, Option.some(Option.none()));
        return true;
      }
      if (!(yield* encryptionAvailable)) return false;
      yield* writeKey(trimmed);
      yield* Ref.set(cachedKey, Option.some(Option.some(trimmed)));
      return true;
    }),
  });
});

export const layer = Layer.effect(ElevenLabsKeyStore, make);
