import packageJson from "../package.json";
import tauriConfig from "../src-tauri/tauri.conf.json";
import { describe, expect, it } from "vitest";

describe("LineDog scaffold", () => {
  it("keeps the frozen application identity", () => {
    expect(packageJson.name).toBe("linedog");
    expect(packageJson.version).toBe("0.3.0");
    expect(packageJson.config.appInternalName).toBe("LineDog");
    expect(packageJson.config.appDisplayName).toBe("线条小狗");
    expect(tauriConfig.productName).toBe("线条小狗");
    expect(tauriConfig.identifier).toBe("com.personalstudio.linedog");
    expect(tauriConfig.version).toBe("0.3.0");
  });
});
