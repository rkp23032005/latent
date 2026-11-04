/**
 * Subject and background editing: what was investigated, and what shipped.
 *
 * This module holds the wording that the investigation produced. The feature it
 * describes — adjusting the subject and the background of a photograph by
 * separate amounts — is **not** offered, and the reason is here so the next
 * reader does not have to redo the research.
 *
 * ## What was assessed
 *
 * Automatic separation in this app means a pretrained segmentation network
 * running in the tab. Three candidates were looked at, with the figures their
 * publishers state:
 *
 * 1. **MediaPipe Selfie Segmentation** — a binary semantic segmentation network,
 *    about 106,000 parameters, 447 KB as float32, a 256×256×3 input tensor.
 *    Small enough to ship. But it segments *a person*: the trained task is
 *    portrait pixels against everything else. Run on a ridge, a concert hall or
 *    a bowl of fruit it has nothing to say, and this catalogue's photographs are
 *    mostly not portraits.
 * 2. **U²-Net family** (the general saliency/matting models) — 176.3 MB for the
 *    full model, 4.7 MB for U²-NetP, about 43 MB for the quantised ONNX export
 *    people actually ship. The small variants are trained for the same
 *    portrait-and-camouflaged-object task, so the size problem and the scope
 *    problem arrive together.
 * 3. **BodyPix** (TensorFlow.js) — person and 24 body parts. Again: people only.
 *
 * Every one of them needs an inference runtime as well. `onnxruntime-web` is 507
 * files and 131.1 MB unpacked in its published package, of which a deployed
 * build uses a multi-megabyte WebAssembly subset; TensorFlow.js core is the same
 * class of addition. This app currently ships three runtime dependencies — react,
 * react-dom, react-router-dom — and its edit rail prints, in its own words, that
 * "nothing left the browser". A model that is fetched from a CDN at first use
 * breaks that sentence. A model that is vendored into `public/` is a binary
 * download several times the size of the entire preset catalogue.
 *
 * ## The other three problems
 *
 * - **Memory.** The pipeline holds a resized RGBA buffer for the preview and a
 *   full-resolution one for export. A 40 MB photograph near the upload limit is
 *   around 7000 × 5000 pixels: 140 MB of bytes as ImageData, and a mask upsampled
 *   to that frame as `Float32Array` is another 140 MB on top of a source that is
 *   already resident. The app has no tiling and no streaming decode to make that
 *   smaller.
 * - **Time.** The published comparison for browser matting reports WebGPU
 *   inference at about 20× a multithreaded CPU and 550× a single-threaded CPU.
 *   This app cannot assume WebGPU: it already has a Canvas2D fallback for the
 *   drivers where even WebGL is refused, and a fallback path cannot run a
 *   network. On the CPU path the honest expectation is seconds per frame, which
 *   is not an interactive knob.
 * - **Claims.** The brief for this project forbids stating a capability that has
 *   not been measured. Mask quality on this app's own photographs cannot be
 *   measured here, so no wording could honestly promise "the subject is detected"
 *   — and a segmentation that fails silently is worse than no segmentation,
 *   because the user cannot see which pixels were protected.
 *
 * ## What is a fake control, and what was built instead
 *
 * A "Subject / Background" switch that drives a blur, a slider labelled "AI
 * selection" that moves a colour threshold, or a disabled button with a tooltip
 * would each be a placeholder, which the brief rules out. So the machinery for
 * region editing is not present in the pipeline either: there is no mask texture
 * and no per-pixel recipe.
 *
 * What *is* present, and what the wording below points at, is the one kind of
 * region separation that can be done honestly with the pixels already in hand:
 * a colour band. `lib/image/skinGuard.ts` reads the *untouched* colour of each
 * pixel and damps the look's colour moves where that colour sits in a warm,
 * moderately saturated band, which is where skin lives. It is a colour mask, not
 * a person detector, and the UI says so; it is off by default; and the user sets
 * how much of it they want. The same device is what a future mask would ride on,
 * which is why the guard is written as a post-pipeline per-pixel blend rather
 * than as another knob in the chain.
 */

/**
 * The answer given whenever an instruction names one area of the frame. It is
 * long on purpose: the honest answer about a region edit is a paragraph, and a
 * one-line refusal would hide which parts are true.
 */
export const REGION_CAVEAT =
  'This editor changes the whole photograph — there is no mask and no selection, so the change lands everywhere, not only on that area. ' +
  'Region separation needs a pretrained segmentation model, and the ones small enough to run in a tab are trained to find people, ' +
  'while the general ones are tens of megabytes and seconds per frame. See lib/ai/segmentation.ts.';

/**
 * The answer given when the area named is skin, which is the one region this
 * engine can genuinely protect.
 */
export const SKIN_REGION_NOTE =
  'Skin tone protection is available: the Skin guard in the Adjust panel holds a look back from pixels whose ' +
  'untouched colour sits in a warm, moderately saturated band. It is a colour band, not a person detector — it does ' +
  'not know a face from a wall — and it cannot smooth, soften or retouch, because those need a mask and a detail stage.';

/** The same answer as the caveat above, shortened to fit under a proposal. */
export const SKIN_REGION_CAVEAT = `${REGION_CAVEAT} Skin is the one area this engine does hold a look back from: the Skin guard in the Adjust panel damps colour changes on warm, moderately saturated pixels.`;
