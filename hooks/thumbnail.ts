/**
 * Shrinks a pasted PNG for the conversation browser's thumbnails (decided
 * 2026-10-24: 250 px wide). The panel draws images only inside a mod's SVG,
 * whose source holds 131 072 characters, so a full screenshot does not fit;
 * a 250 px copy does (about 32 000 characters, measured on this project's
 * screenshots). Pure JavaScript (fast-png, bundled in ./vendor), since a mod
 * has no canvas.
 */
import { convertIndexedToRgb, decode, encode, type DecodedPng } from './vendor/fast-png.js'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(128).fill(-1)
for (let index = 0; index < ALPHABET.length; index += 1) LOOKUP[ALPHABET.charCodeAt(index)] = index

/** Standard base64 to bytes; characters outside the alphabet (whitespace, padding) are skipped. */
export function bytesOfBase64(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let length = 0
  let buffer = 0
  let bits = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const value = code < 128 ? LOOKUP[code]! : -1
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[length] = (buffer >> bits) & 255
      length += 1
    }
  }
  return out.subarray(0, length)
}

/** Bytes to standard, padded base64. */
export function base64OfBytes(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!
    const b = bytes[index + 1] ?? 0
    const c = bytes[index + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += ALPHABET[(triple >> 18) & 63]! + ALPHABET[(triple >> 12) & 63]!
    out += index + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63]! : '='
    out += index + 2 < bytes.length ? ALPHABET[triple & 63]! : '='
  }
  return out
}

/** Any decoded PNG (palette, grey, grey + alpha, RGB, RGBA; 8 or 16 bits) as 8-bit RGBA. */
function rgbaOf(png: DecodedPng): Uint8Array {
  const pixels = png.width * png.height
  let source: ArrayLike<number> = png.data
  let channels = png.channels
  let shift = png.depth === 16 ? 8 : 0
  if (png.palette) {
    source = convertIndexedToRgb(png)
    channels = Math.round(source.length / pixels)
    shift = 0
  }
  const out = new Uint8Array(pixels * 4)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = pixel * channels
    const value = (offset: number) => (source[at + offset] ?? 0) >> shift
    const o = pixel * 4
    if (channels >= 3) {
      out[o] = value(0)
      out[o + 1] = value(1)
      out[o + 2] = value(2)
      out[o + 3] = channels === 4 ? value(3) : 255
    } else {
      const grey = value(0)
      out[o] = grey
      out[o + 1] = grey
      out[o + 2] = grey
      out[o + 3] = channels === 2 ? value(1) : 255
    }
  }
  return out
}

/** Box-filter downscale of RGBA pixels: each target pixel averages the source pixels it covers. */
function shrinkRgba(data: Uint8Array, width: number, height: number, toWidth: number, toHeight: number): Uint8Array {
  const out = new Uint8Array(toWidth * toHeight * 4)
  for (let y = 0; y < toHeight; y += 1) {
    const y0 = Math.floor((y * height) / toHeight)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / toHeight))
    for (let x = 0; x < toWidth; x += 1) {
      const x0 = Math.floor((x * width) / toWidth)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / toWidth))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * width + sx) * 4
          r += data[at]!
          g += data[at + 1]!
          b += data[at + 2]!
          a += data[at + 3]!
          count += 1
        }
      }
      const o = (y * toWidth + x) * 4
      out[o] = Math.round(r / count)
      out[o + 1] = Math.round(g / count)
      out[o + 2] = Math.round(b / count)
      out[o + 3] = Math.round(a / count)
    }
  }
  return out
}

/**
 * The PNG (base64) scaled down to `toWidth` pixels at its own proportions,
 * as a new PNG (base64), with its size; null when it is no PNG fast-png reads.
 * An image no wider than `toWidth` is returned unscaled (re-encoded).
 */
export function shrinkPng(base64: string, toWidth: number): { data: string; width: number; height: number } | null {
  let png: DecodedPng
  try {
    png = decode(bytesOfBase64(base64))
  } catch {
    return null
  }
  if (!(png.width > 0 && png.height > 0)) return null
  const width = Math.min(toWidth, png.width)
  const height = Math.max(1, Math.round((png.height * width) / png.width))
  const rgba = rgbaOf(png)
  const small = width === png.width ? rgba : shrinkRgba(rgba, png.width, png.height, width, height)
  return { data: base64OfBytes(encode(opaqueAsRgb(small, width, height))), width, height }
}

/**
 * RGBA pixels as the PNG to write: without the alpha channel when every
 * pixel is opaque (a screenshot), a quarter fewer bytes for the SVG source.
 */
function opaqueAsRgb(rgba: Uint8Array, width: number, height: number) {
  for (let at = 3; at < rgba.length; at += 4) {
    if (rgba[at] !== 255) return { width, height, data: rgba, depth: 8 as const, channels: 4 }
  }
  const rgb = new Uint8Array(width * height * 3)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgb[pixel * 3] = rgba[pixel * 4]!
    rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1]!
    rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2]!
  }
  return { width, height, data: rgb, depth: 8 as const, channels: 3 }
}
