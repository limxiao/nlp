// Native byte codecs in the selected workerd runtime. TS 5.9 predates these declarations.
interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
  toHex(): string
}
interface Uint8ArrayConstructor {
  fromHex(value: string): Uint8Array<ArrayBuffer>
}
