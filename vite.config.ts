import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

import { parseCharacterManifest } from "./src/pet-manifest";

const HOME_MANIFEST_PATH = "home/home-manifest.json";
const HOME_IMAGE_PATH = "home/home.png";

function isWithinRoot(root: string, target: string): boolean {
  const relativeTarget = relative(root, target);
  return (
    relativeTarget === "" ||
    (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget))
  );
}

/**
 * Production emits only the manifest-declared runtime frames and the promoted
 * Home pair. Development continues to expose public/ normally.
 */
function frozenProductionAssetsPlugin(): Plugin {
  return {
    name: "linedog-frozen-production-assets",
    apply: "build",
    generateBundle() {
      const characterRoot = resolve(process.cwd(), "public", "character");
      let manifest;
      try {
        manifest = parseCharacterManifest(
          JSON.parse(readFileSync(resolve(characterRoot, "manifest.json"), "utf8")),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown parser failure";
        throw new Error(
          `Committed FROZEN character manifest is invalid for production assets: ${detail}`,
        );
      }
      const runtimePaths = new Set<string>([
        "manifest.json",
        HOME_MANIFEST_PATH,
        HOME_IMAGE_PATH,
        ...Object.values(manifest.animations).flatMap((animation) =>
          animation.frames.map((frame) => frame.logicalAssetKey),
        ),
      ]);
      for (const relativePath of runtimePaths) {
        const sourcePath = resolve(characterRoot, relativePath);
        if (!isWithinRoot(characterRoot, sourcePath) || !statSync(sourcePath).isFile()) {
          throw new Error("FROZEN production asset path is invalid.");
        }
        this.emitFile({
          type: "asset",
          fileName: `character/${relativePath}`,
          source: readFileSync(sourcePath),
        });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  // Do not copy every public artifact into production. Serve keeps the
  // project public directory available for local development.
  publicDir: command === "build" ? false : "public",
  clearScreen: false,
  plugins: command === "build" ? [frozenProductionAssetsPlugin()] : [],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
