// The part of fast-png 8.0.0's API the mod uses (fast-png.js next to this
// file). Narrowed from its own lib/index.d.ts and lib/types.d.ts.

export type PngData = Uint8Array | Uint8ClampedArray | Uint16Array

export interface DecodedPng {
  width: number
  height: number
  data: PngData
  depth: 1 | 2 | 4 | 8 | 16
  channels: number
  palette?: number[][]
  transparency?: Uint16Array
}

export declare function decode(data: ArrayBufferLike | ArrayBufferView): DecodedPng
export declare function encode(png: { width: number; height: number; data: PngData; depth?: 8 | 16; channels?: number }): Uint8Array
/** Indexed (palette) data as RGB or RGBA bytes. */
export declare function convertIndexedToRgb(png: DecodedPng): Uint8Array
