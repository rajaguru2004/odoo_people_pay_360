import { createCanvas } from '@napi-rs/canvas';
import { FaceDescriptorService } from './face-descriptor.service';

/**
 * Proves the recogniser actually loads and runs on this machine.
 *
 * No fixture photograph, because a committed face is a committed biometric —
 * so these cases assert the two refusals instead. Both still walk the whole
 * path: the models load from disk, the frame is decoded, a tensor is built and
 * the detector runs. A broken model path or a missing native canvas fails here
 * rather than in production, which is the regression worth guarding: the models
 * are resolved out of the HOISTED root `node_modules`, not the backend's own.
 */
describe('FaceDescriptorService', () => {
  jest.setTimeout(120_000);
  const service = new FaceDescriptorService();

  /** A flat grey frame — a real capture with nobody in it. */
  const blankFrame = () => {
    const canvas = createCanvas(400, 300);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#888888';
    ctx.fillRect(0, 0, 400, 300);
    return canvas.toDataURL('image/jpeg');
  };

  it('refuses a frame with no face in it', async () => {
    await expect(service.extract(blankFrame(), 0.6)).rejects.toThrow(
      /No face was found/i,
    );
  });

  it('refuses something that is not an image at all', async () => {
    await expect(
      service.extract(Buffer.from('not an image').toString('base64'), 0.6),
    ).rejects.toThrow(/could not be read as an image/i);
  });
});
