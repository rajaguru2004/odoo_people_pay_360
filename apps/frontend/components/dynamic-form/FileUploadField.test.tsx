import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { FileUploadField } from './FileUploadField';

/**
 * The control behind a template FILE field.
 *
 * The field stores a URL, and the whole point of this widget is that the user
 * no longer has to produce that URL themselves. Two failures matter: an upload
 * that reports success without writing a URL into the form (the record then
 * saves with an empty file), and a size guard that lets a 40MB scan go up as a
 * multipart body before the server rejects it.
 *
 * The service and the toast are stubbed — this is about the control's own
 * behaviour, not about HTTP.
 */

vi.mock('@/services/uploadService', () => ({
  default: { uploadFile: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import uploadService from '@/services/uploadService';
import { toast } from '@/lib/toast';

const uploadFile = vi.mocked(uploadService.uploadFile);
const toastError = vi.mocked(toast.error);

/** jsdom needs a real File to populate an <input type="file">. */
function makeFile(name = 'scan.pdf', bytes = 1024, type = 'application/pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function setup(props: Partial<React.ComponentProps<typeof FileUploadField>> = {}) {
  const onChange = vi.fn();
  const result = renderWithProviders(
    <FileUploadField value="" onChange={onChange} {...props} />,
  );
  return { ...result, onChange };
}

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

beforeEach(() => {
  uploadFile.mockReset();
  toastError.mockReset();
});

describe('empty state', () => {
  it('offers a dropzone rather than a URL text box', () => {
    // The old renderer showed a text input labelled "URL", which asked whoever
    // was filling in a photo to go find a hosting service first.
    setup();
    expect(screen.getByText('Click to upload, or drop a file here')).toBeInTheDocument();
    expect(fileInput()).toBeInTheDocument();
  });

  it('describes the accepted image formats for an image field', () => {
    setup({ variant: 'image' });
    expect(screen.getByText('PNG, JPG, WebP or SVG · up to 5MB')).toBeInTheDocument();
  });

  it('describes the accepted document formats for a file field', () => {
    setup({ variant: 'file' });
    expect(screen.getByText('PDF, image or Word document · up to 10MB')).toBeInTheDocument();
  });

  it('prefers a supplied hint over the default blurb', () => {
    setup({ hint: 'Passport bio page only' });
    expect(screen.getByText('Passport bio page only')).toBeInTheDocument();
  });

  it('restricts the accept list by variant', () => {
    const { unmount } = setup({ variant: 'image' });
    expect(fileInput()).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/svg+xml');
    unmount();

    setup({ variant: 'file' });
    expect(fileInput()).toHaveAttribute('accept', 'image/png,image/jpeg,application/pdf,.doc,.docx');
  });
});

describe('uploading', () => {
  it('writes the returned URL into the form value', async () => {
    uploadFile.mockResolvedValue({ url: 'https://cdn.test/scan.pdf' } as never);
    const { user, onChange } = setup();

    await user.upload(fileInput(), makeFile());

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('https://cdn.test/scan.pdf'));
  });

  it('accepts the URL nested under data, as the envelope sends it', async () => {
    // The response interceptor unwraps to { success, data }, so both shapes
    // reach this component depending on the caller.
    uploadFile.mockResolvedValue({ data: { url: 'https://cdn.test/a.pdf' } } as never);
    const { user, onChange } = setup();

    await user.upload(fileInput(), makeFile());

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('https://cdn.test/a.pdf'));
  });

  it('reports an error and stores nothing when the server returns no URL', async () => {
    // The quiet failure that matters: without this the field looks uploaded and
    // the record saves with an empty file.
    uploadFile.mockResolvedValue({} as never);
    const { user, onChange } = setup();

    await user.upload(fileInput(), makeFile());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a failed upload and stores nothing', async () => {
    uploadFile.mockRejectedValue({ message: 'Storage unavailable' });
    const { user, onChange } = setup();

    await user.upload(fileInput(), makeFile());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Storage unavailable'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sends an image field to the profile folder', async () => {
    uploadFile.mockResolvedValue({ url: 'u' } as never);
    const { user } = setup({ variant: 'image' });

    await user.upload(fileInput(), makeFile('face.png', 1024, 'image/png'));

    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(expect.any(File), 'profile'));
  });

  it('sends a document field to the documents folder', async () => {
    uploadFile.mockResolvedValue({ url: 'u' } as never);
    const { user } = setup({ variant: 'file' });

    await user.upload(fileInput(), makeFile());

    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(expect.any(File), 'documents'));
  });

  it('honours an explicit folder override', async () => {
    // An image field pointed at the documents folder. The uploaded file has to
    // be an image, because the control narrows `accept` by variant and the
    // browser (and user-event) filter on it.
    uploadFile.mockResolvedValue({ url: 'u' } as never);
    const { user } = setup({ folder: 'documents', variant: 'image' });

    await user.upload(fileInput(), makeFile('face.png', 1024, 'image/png'));

    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(expect.any(File), 'documents'));
  });

  it('filters a file the field does not accept', async () => {
    // Worth pinning: the `accept` list is the first line of defence, and a
    // widened variant would silently start letting other types through.
    const { user } = setup({ variant: 'image' });

    await user.upload(fileInput(), makeFile('scan.pdf', 1024, 'application/pdf'));

    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe('the size guard', () => {
  it('rejects an oversized image before any request is made', async () => {
    // Checked client-side so the common mistake costs a toast rather than a
    // multi-megabyte round trip that fails anyway.
    const { user } = setup({ variant: 'image' });

    await user.upload(fileInput(), makeFile('huge.png', 6 * 1024 * 1024, 'image/png'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('File is too large. Maximum 5MB.'));
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects an oversized document at the higher 10MB limit', async () => {
    const { user } = setup({ variant: 'file' });

    await user.upload(fileInput(), makeFile('huge.pdf', 11 * 1024 * 1024));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('File is too large. Maximum 10MB.'));
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('allows a document that an image field would have refused', async () => {
    // The limits differ by variant; a 6MB scan is fine as a document.
    uploadFile.mockResolvedValue({ url: 'u' } as never);
    const { user } = setup({ variant: 'file' });

    await user.upload(fileInput(), makeFile('scan.pdf', 6 * 1024 * 1024));

    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('filled state', () => {
  it('shows the file name and a remove control', () => {
    setup({ value: 'https://cdn.test/folder/passport.pdf' });
    expect(screen.getByText('passport.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove file')).toBeInTheDocument();
  });

  it('clears the value when removed', async () => {
    const { user, onChange } = setup({ value: 'https://cdn.test/passport.pdf' });

    await user.click(screen.getByLabelText('Remove file'));

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('previews an image variant as a picture', () => {
    setup({ value: 'https://cdn.test/face.png', variant: 'image' });
    expect(document.querySelector('img')).toBeInTheDocument();
  });

  it('shows a paperclip rather than a picture for a document', () => {
    setup({ value: 'https://cdn.test/scan.pdf', variant: 'file' });
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('offers to replace the existing file', async () => {
    uploadFile.mockResolvedValue({ url: 'https://cdn.test/new.pdf' } as never);
    const { user, onChange } = setup({ value: 'https://cdn.test/old.pdf' });

    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    await user.upload(fileInput(), makeFile('new.pdf'));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('https://cdn.test/new.pdf'));
  });
});

describe('link mode', () => {
  it('can switch to pasting a URL, for files hosted elsewhere', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: /Use a link instead/ }));

    expect(screen.getByPlaceholderText('https://…')).toBeInTheDocument();
  });

  it('stores a typed URL directly', async () => {
    const { user, onChange } = setup();

    await user.click(screen.getByRole('button', { name: /Use a link instead/ }));
    await user.type(screen.getByPlaceholderText('https://…'), 'x');

    expect(onChange).toHaveBeenCalledWith('x');
  });

  it('can switch back to uploading', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: /Use a link instead/ }));
    await user.click(screen.getByRole('button', { name: 'Upload a file instead' }));

    expect(screen.getByText('Click to upload, or drop a file here')).toBeInTheDocument();
  });
});

describe('disabled', () => {
  it('hides the remove control so a read-only field cannot be emptied', () => {
    setup({ value: 'https://cdn.test/passport.pdf', disabled: true });
    expect(screen.queryByLabelText('Remove file')).not.toBeInTheDocument();
  });

  it('hides the link-mode toggle', () => {
    setup({ disabled: true });
    expect(screen.queryByRole('button', { name: /Use a link instead/ })).not.toBeInTheDocument();
  });

  it('disables the dropzone', () => {
    setup({ disabled: true });
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
