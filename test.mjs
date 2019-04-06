import dav1d from "./dav1d.mjs";

(async () => {

  const isNode = typeof global !== "undefined";
  let wasmData = null;
  let obu = null;
  let fs = null;

  if (isNode) {
    fs = await import("fs");
    wasmData = fs.readFileSync("dav1d.wasm");
    obu = fs.readFileSync("test.obu");
  } else {
    wasmData = await fetch("dav1d.wasm").then(res => res.arrayBuffer());
    obu = await fetch("test.obu").then(res => res.arrayBuffer());
  }
  const d = await dav1d.create({wasmData});

  console.time("bmp copy");
  const {width, height, data} = d.decodeFrameAsBMP(obu);
  console.timeEnd("bmp copy");
  console.log("decoded "+width+"x"+height+" frame ("+data.byteLength+" bytes)");
  if (isNode) {
    fs.writeFileSync("test.bmp", data);
  }

  console.time("bmp ref");
  const data2 = d.unsafeDecodeFrameAsBMP(obu);
  console.timeEnd("bmp ref");
  console.log("decoded frame ("+data2.byteLength+" bytes)");
  if (isNode) {
    fs.writeFileSync("test2.bmp", data2);
  } else {
    const blob = new Blob([data2], {type: "image/bmp"});
    const blobURL = URL.createObjectURL(blob);
    const img = document.createElement("img");
    img.src = blobURL;
    document.body.appendChild(img);
  }
  d.unsafeCleanup();

})().catch(err => {
  console.error(err);
  if (isNode) {
    process.exit(1);
  }
});
