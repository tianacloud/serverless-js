import { protocolError } from "./errors.js";
import {
  decodeRequestMetadata,
  decodeResponseMetadata,
  encodeRequestMetadata,
  encodeResponseMetadata,
  FETCH_FRAME_PREFIX_BYTES,
  FETCH_MAX_METADATA_BYTES,
  FETCH_MAX_REQUEST_BODY_BYTES,
  FETCH_MAX_RESPONSE_BODY_BYTES,
  FETCH_REQUEST_MAGIC,
  FETCH_RESPONSE_MAGIC,
  type FetchMethod,
  type FetchRequestMetadata,
  type FetchResponseMetadata,
} from "./protocol.js";

export interface DecodedRequestFrame {
  readonly metadata: FetchRequestMetadata;
  readonly body: Uint8Array;
}

export interface DecodedResponseFrame {
  readonly metadata: FetchResponseMetadata;
  readonly body: Uint8Array;
}

export interface ExpectedResponse {
  readonly requestId?: string;
  readonly method?: FetchMethod;
}

const emptyBytes = new Uint8Array(0);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function frameHead(magic: string, metadata: Uint8Array): Uint8Array {
  if (metadata.byteLength > FETCH_MAX_METADATA_BYTES) {
    throw protocolError("Fetch metadata exceeds the v1 limit");
  }
  const prefix = new Uint8Array(FETCH_FRAME_PREFIX_BYTES);
  for (let index = 0; index < 4; index += 1) {
    prefix[index] = magic.charCodeAt(index);
  }
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  view.setUint16(4, 0, false);
  view.setUint32(6, metadata.byteLength, false);
  return concat([prefix, metadata]);
}

function parsePrefix(prefix: Uint8Array, expectedMagic: string): number {
  if (prefix.byteLength !== FETCH_FRAME_PREFIX_BYTES) {
    throw protocolError("Fetch frame prefix is truncated");
  }
  for (let index = 0; index < 4; index += 1) {
    if (prefix[index] !== expectedMagic.charCodeAt(index)) {
      throw protocolError("Fetch frame magic is invalid");
    }
  }
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  if (view.getUint16(4, false) !== 0) {
    throw protocolError("Fetch frame flags are invalid");
  }
  const metadataLength = view.getUint32(6, false);
  if (metadataLength > FETCH_MAX_METADATA_BYTES) {
    throw protocolError("Fetch metadata exceeds the v1 limit");
  }
  return metadataLength;
}

function validateCompleteBody(
  body: Uint8Array,
  declaredLength: number | null,
  maximum: number,
): void {
  if (declaredLength === null) {
    if (body.byteLength > maximum) {
      throw protocolError("Fetch body exceeds the v1 limit");
    }
    return;
  }
  if (body.byteLength < declaredLength) {
    throw protocolError("Fetch body is shorter than body_length");
  }
  if (body.byteLength > declaredLength) {
    throw protocolError("Fetch body has trailing bytes");
  }
}

function splitFrame(
  frame: Uint8Array,
  magic: string,
): { readonly metadata: Uint8Array; readonly body: Uint8Array } {
  if (frame.byteLength < FETCH_FRAME_PREFIX_BYTES) {
    throw protocolError("Fetch frame prefix is truncated");
  }
  const prefix = frame.subarray(0, FETCH_FRAME_PREFIX_BYTES);
  const metadataLength = parsePrefix(prefix, magic);
  const metadataEnd = FETCH_FRAME_PREFIX_BYTES + metadataLength;
  if (frame.byteLength < metadataEnd) {
    throw protocolError("Fetch metadata is truncated");
  }
  return {
    metadata: frame.subarray(FETCH_FRAME_PREFIX_BYTES, metadataEnd),
    body: frame.subarray(metadataEnd),
  };
}

export function encodeRequestFrameBytes(
  metadata: FetchRequestMetadata,
  body: Uint8Array = emptyBytes,
): Uint8Array {
  validateCompleteBody(body, metadata.body_length, FETCH_MAX_REQUEST_BODY_BYTES);
  return concat([frameHead(FETCH_REQUEST_MAGIC, encodeRequestMetadata(metadata)), body]);
}

export function decodeRequestFrameBytes(frame: Uint8Array): DecodedRequestFrame {
  const split = splitFrame(frame, FETCH_REQUEST_MAGIC);
  const metadata = decodeRequestMetadata(split.metadata);
  validateCompleteBody(
    split.body,
    metadata.body_length,
    FETCH_MAX_REQUEST_BODY_BYTES,
  );
  return { metadata, body: split.body.slice() };
}

export function encodeResponseFrameBytes(
  metadata: FetchResponseMetadata,
  body: Uint8Array = emptyBytes,
): Uint8Array {
  validateCompleteBody(body, metadata.body_length, FETCH_MAX_RESPONSE_BODY_BYTES);
  return concat([
    frameHead(FETCH_RESPONSE_MAGIC, encodeResponseMetadata(metadata)),
    body,
  ]);
}

function validateExpectedResponse(
  metadata: FetchResponseMetadata,
  expected: ExpectedResponse,
): void {
  if (
    expected.requestId !== undefined &&
    metadata.request_id !== expected.requestId
  ) {
    throw protocolError("Fetch response request_id does not match the request");
  }
  if (expected.method === "HEAD" && metadata.body_length !== 0) {
    throw protocolError("HEAD Fetch response requires body_length 0");
  }
}

export function decodeResponseFrameBytes(
  frame: Uint8Array,
  expected: ExpectedResponse = {},
): DecodedResponseFrame {
  const split = splitFrame(frame, FETCH_RESPONSE_MAGIC);
  const metadata = decodeResponseMetadata(split.metadata);
  validateExpectedResponse(metadata, expected);
  validateCompleteBody(
    split.body,
    metadata.body_length,
    FETCH_MAX_RESPONSE_BODY_BYTES,
  );
  return { metadata, body: split.body.slice() };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export function createRequestFrameStream(
  metadata: FetchRequestMetadata,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const head = frameHead(FETCH_REQUEST_MAGIC, encodeRequestMetadata(metadata));
  const reader = body?.getReader() ?? null;
  let read = 0;
  let terminal = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const cleanup = (): void => {
    signal.removeEventListener("abort", onAbort);
  };
  const fail = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    error: unknown,
  ): void => {
    if (terminal) {
      return;
    }
    terminal = true;
    cleanup();
    void reader?.cancel(error).catch(() => undefined);
    controller.error(error);
  };
  const onAbort = (): void => {
    if (controllerRef !== undefined) {
      fail(controllerRef, abortReason(signal));
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) {
        fail(controller, abortReason(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      controller.enqueue(head);
      if (reader === null) {
        if (metadata.body_length !== null && metadata.body_length !== 0) {
          fail(controller, protocolError("Fetch body is shorter than body_length"));
          return;
        }
        terminal = true;
        cleanup();
        controller.close();
      }
    },
    async pull(controller) {
      if (terminal || reader === null) {
        return;
      }
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        fail(controller, error);
        return;
      }
      if (terminal) {
        return;
      }
      if (result.done) {
        if (metadata.body_length !== null && read !== metadata.body_length) {
          fail(controller, protocolError("Fetch body is shorter than body_length"));
          return;
        }
        terminal = true;
        cleanup();
        controller.close();
        return;
      }
      const chunk = result.value;
      if (chunk.byteLength === 0) {
        return;
      }
      const nextRead = read + chunk.byteLength;
      const maximum = metadata.body_length ?? FETCH_MAX_REQUEST_BODY_BYTES;
      if (nextRead > maximum) {
        const message = metadata.body_length === null
          ? "Fetch body exceeds the v1 limit"
          : "Fetch body has trailing bytes";
        fail(controller, protocolError(message));
        return;
      }
      read = nextRead;
      controller.enqueue(chunk);
    },
    async cancel(reason) {
      if (terminal) {
        return;
      }
      terminal = true;
      cleanup();
      await reader?.cancel(reason).catch(() => undefined);
    },
  });
}

class StreamByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #pending = emptyBytes;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async readExact(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await this.readChunk();
      if (chunk === null) {
        throw protocolError("Fetch frame is truncated");
      }
      const take = Math.min(chunk.byteLength, length - offset);
      result.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take < chunk.byteLength) {
        this.#pending = new Uint8Array(chunk.subarray(take));
      }
    }
    return result;
  }

  async readChunk(): Promise<Uint8Array | null> {
    if (this.#pending.byteLength !== 0) {
      const pending = this.#pending;
      this.#pending = emptyBytes;
      return pending;
    }
    for (;;) {
      const result = await this.#reader.read();
      if (result.done) {
        return null;
      }
      if (result.value.byteLength !== 0) {
        return result.value;
      }
    }
  }

  async cancel(reason: unknown): Promise<void> {
    await this.#reader.cancel(reason).catch(() => undefined);
  }
}

async function ensureNoBody(reader: StreamByteReader): Promise<void> {
  const chunk = await reader.readChunk();
  if (chunk !== null) {
    const error = protocolError("Fetch response has forbidden body bytes");
    await reader.cancel(error);
    throw error;
  }
}

function createResponseBodyStream(
  reader: StreamByteReader,
  bodyLength: number | null,
): ReadableStream<Uint8Array> {
  let read = 0;
  let terminal = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (terminal) {
        return;
      }
      let chunk: Uint8Array | null;
      try {
        chunk = await reader.readChunk();
      } catch (error) {
        if (terminal) {
          return;
        }
        terminal = true;
        controller.error(error);
        return;
      }
      if (terminal) {
        return;
      }
      if (chunk === null) {
        if (bodyLength !== null && read !== bodyLength) {
          terminal = true;
          controller.error(protocolError("Fetch body is shorter than body_length"));
          return;
        }
        terminal = true;
        controller.close();
        return;
      }
      const nextRead = read + chunk.byteLength;
      const maximum = bodyLength ?? FETCH_MAX_RESPONSE_BODY_BYTES;
      if (nextRead > maximum) {
        const error = protocolError(
          bodyLength === null
            ? "Fetch body exceeds the v1 limit"
            : "Fetch body has trailing bytes",
        );
        terminal = true;
        await reader.cancel(error);
        controller.error(error);
        return;
      }
      read = nextRead;
      controller.enqueue(chunk);
    },
    async cancel(reason) {
      if (terminal) {
        return;
      }
      terminal = true;
      await reader.cancel(reason);
    },
  });
}

export interface DecodedResponseStream {
  readonly metadata: FetchResponseMetadata;
  readonly body: ReadableStream<Uint8Array> | null;
}

export async function decodeResponseStream(
  stream: ReadableStream<Uint8Array>,
  expected: ExpectedResponse,
): Promise<DecodedResponseStream> {
  const reader = new StreamByteReader(stream);
  try {
    const prefix = await reader.readExact(FETCH_FRAME_PREFIX_BYTES);
    const metadataLength = parsePrefix(prefix, FETCH_RESPONSE_MAGIC);
    const metadataBytes = await reader.readExact(metadataLength);
    const metadata = decodeResponseMetadata(metadataBytes);
    validateExpectedResponse(metadata, expected);
    const bodyless =
      expected.method === "HEAD" ||
      metadata.status === 204 ||
      metadata.status === 205 ||
      metadata.status === 304;
    if (bodyless) {
      await ensureNoBody(reader);
      return { metadata, body: null };
    }
    return {
      metadata,
      body: createResponseBodyStream(reader, metadata.body_length),
    };
  } catch (error) {
    await reader.cancel(error);
    throw error;
  }
}
