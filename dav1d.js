// Must be in sync with emcc settings!
const TOTAL_MEMORY = 64 * 1024 * 1024; // TODO(Kagami): Find optimal amount
const TOTAL_STACK = 5626096; // TODO(Kagami): Find why bigger than 5MB
const PAGE_SIZE = 64 * 1024;
const TABLE_SIZE = 271; // NOTE(Kagami): Depends on the number of
                        // function pointers in target library, seems
                        // like no way to know in general case

function getRuntime() {
  let dynamicTop = TOTAL_STACK;
  const table = new WebAssembly.Table({
    initial: TABLE_SIZE,
    maximum: TABLE_SIZE,
    element: "anyfunc",
  });
  const memory = new WebAssembly.Memory({
    initial: TOTAL_MEMORY / PAGE_SIZE,
    maximum: TOTAL_MEMORY / PAGE_SIZE,
  });
  const HEAPU8 = new Uint8Array(memory.buffer);
  return {
    table: table,
    memory: memory,
    sbrk: (increment) => {
      const oldDynamicTop = dynamicTop;
      dynamicTop += increment;
      return oldDynamicTop;
    },
    emscripten_memcpy_big: (dest, src, num) => {
      HEAPU8.set(HEAPU8.subarray(src, src+num), dest);
    },
    // Empty stubs for dav1d.
    pthread_cond_wait: (cond, mutex) => 0,
    pthread_cond_signal: (cond) => 0,
    pthread_cond_destroy: (cond) => 0,
    pthread_cond_init: (cond, attr) => 0,
    pthread_cond_broadcast: (cond) => 0,
    pthread_join: (thread, res) => 0,
    pthread_create: (thread, attr, func, arg) => 0,
    // Emscripten debug.
    // abort: () => {},
    // __lock: () => {},
    // __unlock: () => {},
    // djs_log: (msg) => console.log(msg),
  };
}

function fetchAndInstantiate(data, url, imports) {
  if (data) return WebAssembly.instantiate(data, imports);
  const req = fetch(url, {credentials: "same-origin"});
  if (WebAssembly.instantiateStreaming) {
    return WebAssembly.instantiateStreaming(req, imports);
  } else {
    return req
      .then(res => res.arrayBuffer())
      .then(data => WebAssembly.instantiate(data, imports));
  }
}

export function create(opts = {}) {
  if (!opts.wasmURL && !opts.wasmData) {
    return Promise.reject(new Error("Either wasmURL or wasmData shall be provided"));
  }
  const runtime = getRuntime();
  const imports = {env: runtime};
  return fetchAndInstantiate(opts.wasmData, opts.wasmURL, imports).then(wasm => {
    const d = new Dav1d({wasm, runtime});
    d._init();
    return d;
  });
}

const DJS_FORMAT_YUV = 0;
const DJS_FORMAT_BMP = 1;

class Dav1d {
  /* Private methods, shall not be used */

  constructor({wasm, runtime}) {
    this.FFI = wasm.instance.exports;
    this.buffer = runtime.memory.buffer;
    this.HEAPU8 = new Uint8Array(this.buffer);
    this.ref = null;
    this.lastFrameRef = null;
  }
  _init() {
    this.ref = this.FFI.djs_init();
    if (!this.ref) throw new Error("error in djs_init");
  }
  _decodeFrame(obu, format, unsafe) {
    if (!ArrayBuffer.isView(obu)) {
      obu = new Uint8Array(obu);
    }
    const obuRef = this.FFI.djs_alloc_obu(obu.byteLength);
    if (!obuRef) throw new Error("error in djs_alloc_obu");
    this.HEAPU8.set(obu, obuRef);
    const frameRef = this.FFI.djs_decode_obu(this.ref, obuRef, obu.byteLength, format);
    if (!frameRef) throw new Error("error in djs_decode");
    const frameInfo = new Uint32Array(this.buffer, frameRef, 4);
    const width = frameInfo[0];
    const height = frameInfo[1];
    const size = frameInfo[2];
    const dataRef = frameInfo[3];
    const srcData = new Uint8Array(this.buffer, dataRef, size);
    if (unsafe) {
      this.lastFrameRef = frameRef;
      return srcData;
    }
    const data = new Uint8Array(size);
    data.set(srcData);
    this.FFI.djs_free_frame(frameRef);
    return {width, height, data};
  }

  /* Public API methods */

  /**
   * Frame decoding, copy of frame data is returned.
   */
  decodeFrameAsYUV(obu) {
    return this._decodeFrame(obu, DJS_FORMAT_YUV, false);
  }
  decodeFrameAsBMP(obu) {
    return this._decodeFrame(obu, DJS_FORMAT_BMP, false);
  }

  /**
   * Unsafe decoding with minimal overhead, pointer to WebAssembly
   * memory is returned. User can't call any dav1d.js methods while
   * keeping reference to it and shall call `unsafeCleanup` when
   * finished using the data.
   */
  unsafeDecodeFrameAsYUV(obu) {
    return this._decodeFrame(obu, DJS_FORMAT_YUV, true);
  }
  unsafeDecodeFrameAsBMP(obu) {
    return this._decodeFrame(obu, DJS_FORMAT_BMP, true);
  }
  unsafeCleanup() {
    if (this.lastFrameRef) {
      this.FFI.djs_free_frame(this.lastFrameRef);
      this.lastFrameRef = null;
    }
  }
}

export default {create};
