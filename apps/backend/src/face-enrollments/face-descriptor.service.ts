import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as path from 'path';
import { createCanvas, loadImage, Image as NImage } from '@napi-rs/canvas';
import { DESCRIPTOR_LENGTH } from './dto/create-face-enrollment.dto';

/** Just enough of TensorFlow to build an input tensor and pick a backend. */
interface TensorFlow {
  setBackend(name: string): Promise<boolean>;
  ready(): Promise<void>;
  getBackend(): string;
  tensor3d(
    values: Uint8Array,
    shape: [number, number, number],
    dtype: 'int32',
  ): { dispose(): void };
}

interface FaceDetection {
  detection: { score: number };
  descriptor: Float32Array;
}

/**
 * The surface of face-api this file actually uses.
 *
 * Hand-written because the package ships no types for its node-wasm entry
 * point. Narrow on purpose: the alternative is `any`, and an `any` here would
 * silently accept a renamed net or a changed return shape on an upgrade,
 * turning a compile error into a runtime one on the enrolment path.
 */
interface FaceApi {
  tf: TensorFlow;
  env: {
    monkeyPatch(patch: { Canvas: unknown; Image: unknown }): void;
  };
  nets: {
    ssdMobilenetv1: { loadFromDisk(path: string): Promise<void> };
    faceLandmark68Net: { loadFromDisk(path: string): Promise<void> };
    faceRecognitionNet: { loadFromDisk(path: string): Promise<void> };
  };
  detectSingleFace(input: unknown): {
    withFaceLandmarks(): {
      withFaceDescriptor(): Promise<FaceDetection | undefined>;
    };
  };
}

/*
 * The WASM build, not the native one. `face-api.node.js` links against
 * tfjs-node, which needs a compiler and a matching libtensorflow on every
 * machine that runs the API; the WASM variant is the same model with no build
 * step, and enrolment is not a hot path.
 *
 * `require` rather than `import`: this entry point is CommonJS with no type
 * declarations, and it must be loaded before the monkey-patch below runs.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const faceapi =
  require('@vladmandic/face-api/dist/face-api.node-wasm.js') as FaceApi;

/**
 * TensorFlow, reached through face-api rather than required separately.
 *
 * The node-wasm build does not bundle tfjs — it `require`s it, which is why
 * `@tensorflow/tfjs` and `@tensorflow/tfjs-backend-wasm` are real dependencies
 * here and removing them breaks the import outright. Taking the handle back off
 * `faceapi.tf` guarantees the tensor passed to `detectSingleFace` was made by
 * the very instance face-api resolved, whatever a future hoist does to the
 * dependency tree.
 */
const tf: TensorFlow = faceapi.tf;

// Registers the WASM kernels on that same instance. `faceapi.tf` exposes the
// module but not this side effect, and `setBackend('wasm')` fails without it.
require('@tensorflow/tfjs-backend-wasm');
/* eslint-enable @typescript-eslint/no-require-imports */

faceapi.env.monkeyPatch({
  Canvas:
    (createCanvas as unknown as { constructor: unknown }).constructor ?? Object,
  Image: NImage ?? Object,
});

/**
 * Where face-api ships its own weights. Nothing is fetched over the network.
 *
 * Resolved through `require.resolve` rather than built from `process.cwd()`:
 * npm workspaces hoists the package to the MONOREPO root, so
 * `apps/backend/node_modules/@vladmandic/...` does not exist and a cwd-relative
 * path finds no models on a machine where the install worked perfectly.
 */
const MODEL_PATH = path.join(
  path.dirname(require.resolve('@vladmandic/face-api/package.json')),
  'model',
);

/**
 * The recogniser, and the reason it lives on the server.
 *
 * The portal cannot compute a template: the models are tens of megabytes, and a
 * descriptor produced by a different model than the one doing the matching
 * enrols a face that can never be recognised. So the browser sends a photo and
 * this turns it into the {@link DESCRIPTOR_LENGTH}-float embedding — one model,
 * one calibration, every capture comparable with every other.
 *
 * The photo is used and dropped here. Only {@link FaceEnrollmentsService}
 * decides whether a copy is kept for the enrolment gallery.
 */
@Injectable()
export class FaceDescriptorService {
  private readonly logger = new Logger(FaceDescriptorService.name);
  /** In-flight load, so N concurrent captures on a cold API trigger one. */
  private loading: Promise<void> | null = null;
  private loaded = false;

  /**
   * Load the weights once, lazily.
   *
   * Deliberately NOT in `onModuleInit`: this is ~15s and tens of megabytes of
   * WASM on a path nobody may ever walk, and paying it at boot delays every
   * other route in the API behind a feature most requests never touch.
   */
  private async ready(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      await tf.setBackend('wasm');
      await tf.ready();

      await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH);

      this.loaded = true;
      this.logger.log(`Face recogniser ready (backend: ${tf.getBackend()})`);
    })().catch((error) => {
      // Cleared so a later capture retries rather than being refused forever by
      // one bad start — a half-written node_modules, a transient OOM.
      this.loading = null;
      this.logger.error('Face recogniser failed to load', error as Error);
      throw new ServiceUnavailableException(
        'The face recogniser is not available on this server.',
      );
    });

    return this.loading;
  }

  /**
   * Turn a captured frame into a template.
   *
   * @param image  A `data:image/...;base64,` URI or bare base64.
   * @param minQuality The detector confidence an enrolment has to clear.
   */
  async extract(
    image: string,
    minQuality: number,
  ): Promise<{ descriptor: number[]; quality: number }> {
    await this.ready();

    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    let bitmap: Awaited<ReturnType<typeof loadImage>>;
    try {
      bitmap = await loadImage(Buffer.from(base64, 'base64'));
    } catch {
      throw new BadRequestException('That file could not be read as an image.');
    }

    const canvas = createCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);

    // The WASM build will not take a @napi-rs/canvas Canvas, so the pixels go
    // in as a tensor instead. RGBA out, RGB in — face-api wants three channels.
    const { width, height } = bitmap;
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = rgba[i * 4];
      rgb[i * 3 + 1] = rgba[i * 4 + 1];
      rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }

    const tensor = tf.tensor3d(rgb, [height, width, 3], 'int32');
    let detection: FaceDetection | undefined;
    try {
      detection = await faceapi
        .detectSingleFace(tensor)
        .withFaceLandmarks()
        .withFaceDescriptor();
    } finally {
      tensor.dispose();
    }

    if (!detection) {
      throw new BadRequestException(
        'No face was found in that photo. Face the camera in even light and try again.',
      );
    }

    const quality = detection.detection.score;
    if (quality < minQuality) {
      throw new BadRequestException(
        `That capture is too weak (${Math.round(quality * 100)}%). At least ${Math.round(
          minQuality * 100,
        )}% is needed — find better light and take it again.`,
      );
    }

    const descriptor = Array.from(detection.descriptor);
    if (
      descriptor.length !== DESCRIPTOR_LENGTH ||
      descriptor.some((n) => !Number.isFinite(n))
    ) {
      throw new BadRequestException(
        `The recogniser returned an unusable template (${descriptor.length} values).`,
      );
    }

    return { descriptor, quality };
  }
}
