import type { LogicalHitBox, RuntimeFrame } from "./pet-manifest";
import { projectFrameHitBox } from "./pet-visual-geometry";

// Read-only alpha bounds measured from the original manifest PNGs. Images,
// anchors and click hitboxes are not modified. Coordinates below are 160px.
const FRAME_BOUNDS: Readonly<Record<string, { box: LogicalHitBox; anchor: { x: number; y: number } }>> = {
  "idle/frame_01.png": {
    "box": {
      "x": 25.0,
      "y": 22.5,
      "width": 110.3125,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "idle/frame_02.png": {
    "box": {
      "x": 23.4375,
      "y": 20.3125,
      "width": 113.125,
      "height": 120.0
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "idle/frame_03.png": {
    "box": {
      "x": 25.0,
      "y": 21.5625,
      "width": 110.3125,
      "height": 118.75
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "idle/frame_04.png": {
    "box": {
      "x": 24.6875,
      "y": 21.25,
      "width": 110.625,
      "height": 119.0625
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "blink/frame_01.png": {
    "box": {
      "x": 25.0,
      "y": 22.5,
      "width": 110.3125,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "blink/frame_02.png": {
    "box": {
      "x": 25.0,
      "y": 22.5,
      "width": 110.3125,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "blink/frame_03.png": {
    "box": {
      "x": 25.0,
      "y": 22.5,
      "width": 110.3125,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "walk/frame_01.png": {
    "box": {
      "x": 21.25,
      "y": 24.375,
      "width": 117.8125,
      "height": 115.9375
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "walk/frame_02.png": {
    "box": {
      "x": 22.5,
      "y": 26.875,
      "width": 115.0,
      "height": 113.4375
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "walk/frame_03.png": {
    "box": {
      "x": 23.4375,
      "y": 25.625,
      "width": 113.125,
      "height": 114.6875
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "walk/frame_04.png": {
    "box": {
      "x": 19.375,
      "y": 22.5,
      "width": 120.9375,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "walk/frame_05.png": {
    "box": {
      "x": 22.5,
      "y": 26.25,
      "width": 115.0,
      "height": 114.0625
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "walk/frame_06.png": {
    "box": {
      "x": 23.75,
      "y": 22.8125,
      "width": 112.8125,
      "height": 117.5
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "happy/frame_01.png": {
    "box": {
      "x": 25.625,
      "y": 21.875,
      "width": 109.375,
      "height": 118.4375
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "happy/frame_02.png": {
    "box": {
      "x": 25.3125,
      "y": 44.0625,
      "width": 109.375,
      "height": 96.25
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "happy/frame_03.png": {
    "box": {
      "x": 26.25,
      "y": 15.0,
      "width": 107.8125,
      "height": 110.9375
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "happy/frame_04.png": {
    "box": {
      "x": 25.0,
      "y": 36.875,
      "width": 110.625,
      "height": 103.4375
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "happy/frame_05.png": {
    "box": {
      "x": 25.9375,
      "y": 25.625,
      "width": 108.125,
      "height": 114.6875
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "happy/frame_06.png": {
    "box": {
      "x": 26.25,
      "y": 15.0,
      "width": 107.8125,
      "height": 110.9375
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "happy/frame_07.png": {
    "box": {
      "x": 26.25,
      "y": 15.0,
      "width": 107.8125,
      "height": 110.9375
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "look_mouse/frame_01.png": {
    "box": {
      "x": 25.0,
      "y": 22.5,
      "width": 110.3125,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "look_mouse/frame_02.png": {
    "box": {
      "x": 25.0,
      "y": 22.5,
      "width": 110.3125,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "look_mouse/frame_03.png": {
    "box": {
      "x": 25.625,
      "y": 20.3125,
      "width": 108.75,
      "height": 120.0
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "drag/frame_01.png": {
    "box": {
      "x": 30.0,
      "y": 15.0,
      "width": 99.6875,
      "height": 110.9375
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "drag/frame_02.png": {
    "box": {
      "x": 31.25,
      "y": 15.0,
      "width": 97.5,
      "height": 112.5
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "fall/frame_01.png": {
    "box": {
      "x": 32.8125,
      "y": 19.0625,
      "width": 94.6875,
      "height": 106.25
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "fall/frame_02.png": {
    "box": {
      "x": 33.125,
      "y": 23.4375,
      "width": 93.75,
      "height": 105.625
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "land/frame_01.png": {
    "box": {
      "x": 21.5625,
      "y": 41.25,
      "width": 117.1875,
      "height": 99.0625
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "land/frame_02.png": {
    "box": {
      "x": 23.75,
      "y": 27.1875,
      "width": 112.8125,
      "height": 113.125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "land/frame_03.png": {
    "box": {
      "x": 25.0,
      "y": 22.5,
      "width": 110.3125,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "turn/frame_01.png": {
    "box": {
      "x": 18.125,
      "y": 20.3125,
      "width": 124.0625,
      "height": 120.0
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "turn/frame_02.png": {
    "box": {
      "x": 25.625,
      "y": 20.3125,
      "width": 108.75,
      "height": 120.0
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "turn/frame_03.png": {
    "box": {
      "x": 25.0,
      "y": 22.5,
      "width": 110.3125,
      "height": 117.8125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "turn/frame_04.png": {
    "box": {
      "x": 25.625,
      "y": 20.3125,
      "width": 108.75,
      "height": 120.0
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "turn/frame_05.png": {
    "box": {
      "x": 17.8125,
      "y": 20.3125,
      "width": 124.0625,
      "height": 120.0
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "jump_air/frame_01.png": {
    "box": {
      "x": 38.75,
      "y": 57.5,
      "width": 106.25,
      "height": 85.0
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "jump_air/frame_02.png": {
    "box": {
      "x": 38.75,
      "y": 30.0,
      "width": 106.25,
      "height": 84.0625
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "jump_air/frame_03.png": {
    "box": {
      "x": 34.375,
      "y": 23.125,
      "width": 106.25,
      "height": 72.5
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "jump_air/frame_04.png": {
    "box": {
      "x": 18.75,
      "y": 48.125,
      "width": 106.25,
      "height": 85.0
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "home_land/frame_01.png": {
    "box": {
      "x": 28.4375,
      "y": 49.375,
      "width": 103.125,
      "height": 90.625
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "home_land/frame_02.png": {
    "box": {
      "x": 28.4375,
      "y": 78.4375,
      "width": 103.125,
      "height": 61.5625
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "home_land/frame_03.png": {
    "box": {
      "x": 28.4375,
      "y": 49.6875,
      "width": 103.125,
      "height": 90.3125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "home_land/frame_04.png": {
    "box": {
      "x": 34.6875,
      "y": 46.25,
      "width": 90.625,
      "height": 93.75
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "home_idle/frame_01.png": {
    "box": {
      "x": 36.875,
      "y": 46.25,
      "width": 86.5625,
      "height": 93.75
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "home_idle/frame_02.png": {
    "box": {
      "x": 33.125,
      "y": 49.6875,
      "width": 93.75,
      "height": 90.3125
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "home_idle/frame_03.png": {
    "box": {
      "x": 33.125,
      "y": 57.8125,
      "width": 93.75,
      "height": 82.1875
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "home_idle/frame_04.png": {
    "box": {
      "x": 33.125,
      "y": 75.9375,
      "width": 93.75,
      "height": 64.0625
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "sleep/frame_01.png": {
    "box": {
      "x": 23.75,
      "y": 63.75,
      "width": 112.5,
      "height": 76.25
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "sleep/frame_02.png": {
    "box": {
      "x": 23.75,
      "y": 63.125,
      "width": 112.5,
      "height": 76.875
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "sleep/frame_03.png": {
    "box": {
      "x": 23.75,
      "y": 61.25,
      "width": 112.5,
      "height": 78.75
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  },
  "sleep/frame_04.png": {
    "box": {
      "x": 23.75,
      "y": 62.5,
      "width": 112.5,
      "height": 77.5
    },
    "anchor": {
      "x": 256,
      "y": 448
    }
  }
};

/** Stable envelope of a whole source animation, so the caption does not jitter. */
export function characterAnimationBounds(frame: RuntimeFrame, facing: "Left" | "Right"): LogicalHitBox | null {
  const prefix = frame.logicalAssetKey.split("/")[0] + "/";
  const boxes = Object.entries(FRAME_BOUNDS).filter(([key]) => key.startsWith(prefix)).map(([key, value]) =>
    projectFrameHitBox({ ...frame, logicalAssetKey: key, visualAnchor: value.anchor }, value.box, facing));
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(box => box.x));
  const y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}
