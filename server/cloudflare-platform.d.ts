interface FixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

declare var FixedLengthStream: {
  new (expectedLength: number): FixedLengthStream;
};
