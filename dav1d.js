// Must be in sync with emcc settings!

const TOTAL_MEMORY = 64 * 1024 * 1024; // TODO(Kagami): Find optimal amount
const DYNAMICTOP_PTR = 385392;
const DYNAMIC_BASE = 5628304;
// const TOTAL_STACK = 5242880; // TODO(Kagami): Find why bigger than 5MB
const PAGE_SIZE = 64 * 1024;
const TABLE_SIZE = 414; // NOTE(Kagami, ledyba-z): Depends on the number of
                        // function pointers in target library, seems
                        // like no way to know in general case

function abort(what) {
  throw "abort(" + what + "). Build with -s ASSERTIONS=1 for more info.";
}

var wasmModule;

function getRuntime() {
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
  const HEAPU32 = new Uint32Array(memory.buffer);
  HEAPU32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE;

  return {
    table: table,
    memory: memory,
    __table_base: 0,
    __memory_base: 1024,
    DYNAMICTOP_PTR: DYNAMICTOP_PTR,
    _emscripten_memcpy_big: (dest, src, num) => {
      HEAPU8.set(HEAPU8.subarray(src, src+num), dest);
    },
    _emscripten_resize_heap: (requestedSize) => {
      abort('OOM');
    },
    _emscripten_get_heap_size: () => {
      return memory.buffer.byteLength;
    },
    // Empty stubs for dav1d.
    _pthread_cond_wait: (cond, mutex) => 0,
    _pthread_cond_signal: (cond) => 0,
    _pthread_cond_destroy: (cond) => 0,
    _pthread_cond_destroy: (cond) => 0,
    _pthread_cond_init: (cond, attr) => 0,
    _pthread_cond_broadcast: (cond) => 0,
    _pthread_join: (thread, res) => 0,
    _pthread_create: (thread, attr, func, arg) => 0,
    _pthread_attr_init: (attr) => 0,
    _pthread_attr_destroy: (attr) => 0,
    _pthread_attr_setstacksize: (attr, stacksize) => 0,
    _abort: abort,
    abort: abort,
    ___setErrNo: (value) => {
      HEAPU32[wasmModule["___errno_location"]() >> 2] = value
    },
    ___syscall6: () => { abort('syscall6'); },
    ___syscall140: () => { abort('syscall140'); },
    ___syscall146: () => { abort('syscall146'); },
    abortOnCannotGrowMemory: (requestedSize) => { abort('OOM'); },
    
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
  const imports = {
    env: runtime,
  };
  return fetchAndInstantiate(opts.wasmData, opts.wasmURL, imports).then(wasm => {
    wasmModule = wasm.exports;
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
    this.ref = 0;
    this.lastFrameRef = 0;
  }
  _init() {
    this.ref = this.FFI._djs_init();
    if (!this.ref) throw new Error("error in djs_init");
  }
  _decodeFrame(obu, format, unsafe) {
    if (!ArrayBuffer.isView(obu)) {
      obu = new Uint8Array(obu);
    }
    const obuRef = this.FFI._djs_alloc_obu(obu.byteLength);
    if (!obuRef) throw new Error("error in djs_alloc_obu");
    this.HEAPU8.set(obu, obuRef);
    const frameRef = this.FFI._djs_decode_obu(this.ref, obuRef, obu.byteLength, format);
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
    this.FFI._djs_free_frame(frameRef);
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
      this.FFI._djs_free_frame(this.lastFrameRef);
      this.lastFrameRef = 0;
    }
  }
}

export default {create};
