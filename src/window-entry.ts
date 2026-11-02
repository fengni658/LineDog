import { getCurrentWindow } from "@tauri-apps/api/window";

export interface WindowBootstrapLoaders {
  main(): Promise<unknown>;
  home(): Promise<unknown>;
  chat?(): Promise<unknown>;
}

export interface WindowLabelPort {
  getWindowLabel(): Promise<string>;
}

export async function routeWindowLabel(
  label: string,
  loaders: WindowBootstrapLoaders,
): Promise<void> {
  if (label === "chat" && loaders.chat) { await loaders.chat(); return; }
  if (label === "main") {
    await loaders.main();
    return;
  }

  if (label === "home") {
    await loaders.home();
    return;
  }

  throw new Error(`LineDog unsupported window label: ${label}`);
}

export async function startWindowEntry(
  port: WindowLabelPort = {
    getWindowLabel: async () => getCurrentWindow().label,
  },
): Promise<void> {
  await routeWindowLabel(await port.getWindowLabel(), {
    main: () => import("./main"),
    home: () => import("./home-bootstrap"),
    chat: () => import("./chat"),
  });
}

if (typeof window !== "undefined") {
  void startWindowEntry().catch((error: unknown) => {
    console.error("LineDog window bootstrap failed closed.", error);
  });
}
