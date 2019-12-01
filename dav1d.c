#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <dav1d/dav1d.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#include <time.h>
#include <stdio.h>
#include <assert.h>
#define EMSCRIPTEN_KEEPALIVE
#endif

#ifdef DJS_VALGRIND
void dav1d_set_cpu_flags_mask(const unsigned mask);
#endif

typedef struct {
  Dav1dContext *ctx; // Private field
} djs;

typedef enum {
  DJS_FORMAT_YUV = 0, // 4:2:0 8-bit YCbCr
  DJS_FORMAT_BMP,     // RGB24 with BMP header
} djs_format;

typedef struct {
  uint32_t width;
  uint32_t height;
  uint32_t size;
  uint8_t *data;
} djs_frame;

/** Initialize dav1d.js and return context in case of success. */
EMSCRIPTEN_KEEPALIVE
djs *djs_init(void) {
  djs *d = malloc(sizeof(djs));
  if (!d)
    return NULL;
  Dav1dSettings s;
  dav1d_default_settings(&s);
#ifdef DJS_VALGRIND
  dav1d_set_cpu_flags_mask(0);
#endif
  if (dav1d_open(&d->ctx, &s) < 0) {
    free(d);
    return NULL;
  }
  return d;
}

/** Destroy dav1d.js context and free resources. */
EMSCRIPTEN_KEEPALIVE
void djs_free(djs *d) {
  dav1d_close(&d->ctx);
  free(d);
}

// Just copy planes.
// FIXME(Kagami): Odd dimensions.
// TODO(Kagami): We may return references to picture planes instead, to
// avoid extra allocations. This would require slightly different API in
// JS wrapper.
static int create_yuv(const Dav1dPicture *pic, djs_frame *frame) {
  int w = pic->p.w;
  int h = pic->p.h;
  int y_size = w * h;
  int u_size = ((w + 1) / 2) * ((h + 1) / 2);
  frame->size = y_size + u_size * 2;
  frame->data = (uint8_t*)malloc(frame->size);
  if (!frame->data)
    return -1;

  // Copy Y plane.
  uint8_t *src_y = pic->data[0];
  uint8_t *dst_y = frame->data;
  for (int j = 0; j < h; j++) {
    memcpy(dst_y, src_y, w);
    src_y += pic->stride[0];
    dst_y += w;
  }

  // Copy U/V planes.
  int c_w = w >> 1;
  int c_h = h >> 1;
  uint8_t *src_u = pic->data[1];
  uint8_t *src_v = pic->data[2];
  uint8_t *dst_u = frame->data + y_size;
  uint8_t *dst_v = dst_u + u_size;
  for (int j = 0; j < c_h; j++) {
    memcpy(dst_u, src_u, c_w);
    memcpy(dst_v, src_v, c_w);
    src_u += pic->stride[1];
    src_v += pic->stride[1];
    dst_u += c_w;
    dst_v += c_w;
  }

  return 0;
}

static inline int clamp(int v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

// Fill BMP data from 4:2:0 frame.
// Based on yuv-canvas (Copyright 2014-2019 by Brion Vibber brion@pobox.com MIT license).
// FIXME(Kagami): Odd dimensions.
static void fill_bmp_data_from_420(const Dav1dPicture *pic, uint8_t *output, int outStride) {
  int width = pic->p.w;
  int height = pic->p.h;
  uint8_t *bytesY = pic->data[0];
  uint8_t *bytesCb = pic->data[1];
  uint8_t *bytesCr = pic->data[2];
  int strideY = pic->stride[0];
  int strideCb = pic->stride[1];
  int strideCr = pic->stride[1];
  int ydec = 0;

  for (int y = 0; y < height; y += 2) {
    int outPtr0 = y * outStride;
    int outPtr1 = outPtr0 + outStride;

    int Y0Ptr = y * strideY;
    int Y1Ptr = Y0Ptr + strideY;
    int CbPtr = ydec * strideCb;
    int CrPtr = ydec * strideCr;
    for (int x = 0; x < width; x += 2) {
      int colorCb = bytesCb[CbPtr++];
      int colorCr = bytesCr[CrPtr++];

      int multCrR   = (409 * colorCr) - 57088;
      int multCbCrG = (100 * colorCb) + (208 * colorCr) - 34816;
      int multCbB   = (516 * colorCb) - 70912;

      int multY = 298 * bytesY[Y0Ptr++];
      output[outPtr0    ] = clamp((multY + multCbB) >> 8);
      output[outPtr0 + 1] = clamp((multY - multCbCrG) >> 8);
      output[outPtr0 + 2] = clamp((multY + multCrR) >> 8);
      outPtr0 += 3;

      multY = 298 * bytesY[Y0Ptr++];
      output[outPtr0    ] = clamp((multY + multCbB) >> 8);
      output[outPtr0 + 1] = clamp((multY - multCbCrG) >> 8);
      output[outPtr0 + 2] = clamp((multY + multCrR) >> 8);
      outPtr0 += 3;

      multY = 298 * bytesY[Y1Ptr++];
      output[outPtr1    ] = clamp((multY + multCbB) >> 8);
      output[outPtr1 + 1] = clamp((multY - multCbCrG) >> 8);
      output[outPtr1 + 2] = clamp((multY + multCrR) >> 8);
      outPtr1 += 3;

      multY = 298 * bytesY[Y1Ptr++];
      output[outPtr1    ] = clamp((multY + multCbB) >> 8);
      output[outPtr1 + 1] = clamp((multY - multCbCrG) >> 8);
      output[outPtr1 + 2] = clamp((multY + multCrR) >> 8);
      outPtr1 += 3;
    }
    ydec++;
  }
}

#define SET_U16(v) { *((uint16_t*)dst) = v; dst += 2; }
#define SET_U32(v) { *((uint32_t*)dst) = v; dst += 4; }

// Create BMP, useful to avoid extra allocations. Used by avif.js.
static int create_bmp(const Dav1dPicture *pic, djs_frame *frame) {
  int w = pic->p.w;
  int h = pic->p.h;
  int header_size = 54;                         // 14 + 40 bytes
  int stride = ((24 * w + 31) / 32) * 4;        // row length incl. padding
  int pixel_array_size = stride * h;            // total bitmap size
  frame->size = header_size + pixel_array_size; // header size is known + bitmap
  frame->data = (uint8_t*)malloc(frame->size);
  if (!frame->data)
    return -1;

  uint8_t *dst = frame->data;

  // BMP header.
  SET_U16(0x4d42);           // BM
  SET_U32(frame->size);      // total length
  SET_U16(0);                // unused
  SET_U16(0);                // unused
  SET_U32(header_size);      // offset to pixels

  // DIB header.
  SET_U32(40);               // DIB header size
  SET_U32(w);                // width
  SET_U32(-h >> 0);          // negative = top-to-bottom
  SET_U16(1);                // 1 plane
  SET_U16(24);               // 24-bit (RGB)
  SET_U32(0);                // no compression (BI_RGB)
  SET_U32(pixel_array_size); // bitmap size incl. padding (stride x height)
  SET_U32(2835);             // pixels/meter h (~72 DPI x 39.3701 inch/m)
  SET_U32(2835);             // pixels/meter v
  SET_U32(0);                // unused
  SET_U32(0);                // unused

  // Bitmap data.
  fill_bmp_data_from_420(pic, dst, stride);

  return 0;
}

/** Reserve memory for OBU data to copy into on JS side. */
EMSCRIPTEN_KEEPALIVE
void *djs_alloc_obu(uint32_t obu_len) {
  return malloc(obu_len);
}

static void free_callback(const uint8_t *buf, void *cookie) {
  free((void*)buf);
}

/**
 * Decode single AV1 frame and return uncompressed data or null in case
 * of error. Consumes obu input that should be allocated with
 * `djs_alloc_obu` beforehand.
 */
EMSCRIPTEN_KEEPALIVE
djs_frame *djs_decode_obu(djs *d, uint8_t *obu, uint32_t obu_len, djs_format fmt) {
  Dav1dData data = { 0 };
  Dav1dPicture pic = { 0 };
  dav1d_data_wrap(&data, obu, obu_len, free_callback, NULL/*cookie*/);
  if (dav1d_send_data(d->ctx, &data) < 0)
    return NULL;
  if (dav1d_get_picture(d->ctx, &pic) < 0)
    return NULL;
  if (pic.p.layout != DAV1D_PIXEL_LAYOUT_I420 || pic.p.bpc != 8)
    return NULL;
  djs_frame *frame = malloc(sizeof(djs_frame));
  if (!frame)
    return NULL;
  frame->width = pic.p.w;
  frame->height = pic.p.h;
  int ret = fmt == DJS_FORMAT_BMP ? create_bmp(&pic, frame)
                                  : create_yuv(&pic, frame);
  dav1d_picture_unref(&pic);
  if (ret < 0) {
    free(frame);
    return NULL;
  }
  return frame;
}

/** Free allocated frame. */
EMSCRIPTEN_KEEPALIVE
void djs_free_frame(djs_frame *frame) {
  free(frame->data);
  free(frame);
}

#ifndef __EMSCRIPTEN__
int main() {
  FILE *fin = fopen("test.obu", "rb");
  fseek(fin, 0, SEEK_END);
  long obu_len = ftell(fin);
  rewind(fin);

  /*1*/djs *d = djs_init();

  /*2*/uint8_t *obu = djs_alloc_obu(obu_len);
  size_t len = fread(obu, 1, obu_len, fin);
  assert(len == obu_len);
  clock_t t = clock();
  /*3*/djs_frame *frame = djs_decode_obu(d, obu, obu_len, DJS_FORMAT_BMP);
  t = clock() - t;
  printf("decoded %ux%u frame (%u bytes) in %.3fms\n",
         frame->width, frame->height, frame->size, (double)t/CLOCKS_PER_SEC*1000);
  FILE *fout = fopen("test.bmp", "wb");
  fwrite(frame->data, frame->size, 1, fout);
  fclose(fout);
  fclose(fin);
  /*4*/djs_free_frame(frame);

  /*5*/djs_free(d);

  return 0;
}
#endif
