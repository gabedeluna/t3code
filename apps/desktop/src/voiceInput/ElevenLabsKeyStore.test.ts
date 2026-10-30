import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElevenLabsKeyStore from "./ElevenLabsKeyStore.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function layerSafeStorage(available: boolean) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      return decoded.startsWith("encrypted:")
        ? Effect.succeed(decoded.slice("encrypted:".length))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageDecryptError({
              cause: new Error("not encrypted by this keychain"),
            }),
          );
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layerFor(baseDir: string, encryptionAvailable: boolean) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "win32",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  return ElevenLabsKeyStore.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerEnvironment, layerSafeStorage(encryptionAvailable), NodeServices.layer),
    ),
  );
}

/** Each call builds a fresh store over the same directory, as a relaunch would. */
const inStore =
  (baseDir: string, encryptionAvailable = true) =>
  <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | ElevenLabsKeyStore.ElevenLabsKeyStore
      | DesktopEnvironment.DesktopEnvironment
      | FileSystem.FileSystem
      | Path.Path
    >,
  ) =>
    effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));

const withBaseDir = <A, E>(run: (baseDir: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* run(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-desktop-elevenlabs-key-test-" }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const keyFileContents = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem
    .readFileString(path.join(environment.stateDir, "elevenlabs-key.json"))
    .pipe(Effect.option);
});

describe("ElevenLabsKeyStore", () => {
  it.effect("stores the key encrypted and reads it back after a relaunch", () =>
    withBaseDir((baseDir) =>
      Effect.gen(function* () {
        const stored = yield* inStore(baseDir)(
          Effect.gen(function* () {
            const store = yield* ElevenLabsKeyStore.ElevenLabsKeyStore;
            assert.isTrue(yield* store.set("  sk_live_123  "));
            return yield* keyFileContents;
          }),
        );
        assert.isTrue(Option.isSome(stored));
        assert.notInclude(
          Option.getOrElse(stored, () => ""),
          "sk_live_123",
        );

        const relaunched = yield* inStore(baseDir)(
          Effect.gen(function* () {
            const store = yield* ElevenLabsKeyStore.ElevenLabsKeyStore;
            return { key: yield* store.get, status: yield* store.status };
          }),
        );
        assert.deepStrictEqual(relaunched.key, Option.some("sk_live_123"));
        assert.deepStrictEqual(relaunched.status, {
          apiKeyConfigured: true,
          encryptionAvailable: true,
        });
      }),
    ),
  );

  it.effect("an empty key removes the stored one", () =>
    withBaseDir((baseDir) =>
      inStore(baseDir)(
        Effect.gen(function* () {
          const store = yield* ElevenLabsKeyStore.ElevenLabsKeyStore;
          yield* store.set("sk_live_123");
          assert.isTrue(yield* store.set(""));
          assert.deepStrictEqual(yield* store.get, Option.none());
          assert.deepStrictEqual(yield* keyFileContents, Option.none());
        }),
      ),
    ),
  );

  it.effect("stores nothing when the keychain cannot protect the key", () =>
    withBaseDir((baseDir) =>
      inStore(
        baseDir,
        false,
      )(
        Effect.gen(function* () {
          const store = yield* ElevenLabsKeyStore.ElevenLabsKeyStore;
          assert.isFalse(yield* store.set("sk_live_123"));
          assert.deepStrictEqual(yield* keyFileContents, Option.none());
          assert.deepStrictEqual(yield* store.status, {
            apiKeyConfigured: false,
            encryptionAvailable: false,
          });
        }),
      ),
    ),
  );

  it.effect("reports a key it cannot decrypt as not configured, so Settings can replace it", () =>
    withBaseDir((baseDir) =>
      inStore(baseDir)(
        Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(environment.stateDir, "elevenlabs-key.json"),
            JSON.stringify({ version: 1, encryptedKey: btoa("from another machine") }),
          );
          const store = yield* ElevenLabsKeyStore.ElevenLabsKeyStore;
          assert.deepStrictEqual(yield* store.status, {
            apiKeyConfigured: false,
            encryptionAvailable: true,
          });
          assert.isTrue(yield* store.set("sk_live_456"));
          assert.deepStrictEqual(yield* store.get, Option.some("sk_live_456"));
        }),
      ),
    ),
  );
});
