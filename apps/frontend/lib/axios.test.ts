import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';

/**
 * The single axios instance every service call passes through.
 *
 * Four behaviours are encoded in its interceptors, and each one has already
 * caused a bug:
 *
 *  - `X-Branch-Id` is a *view selector*, and sending it for a role that is
 *    pinned server-side produces "You do not have access to the selected
 *    branch" on every request — including `/auth/me`, which locks the user out.
 *  - `X-Dev-Token` is a second credential with its own lifetime.
 *  - `/dev-mode/` responses must be exempt from the 401/403 handlers, or a typo
 *    in the developer password signs the admin out of the whole app.
 *  - The error path rejects with a FLAT object, so `err.response.data.message`
 *    is always `undefined` for callers. That trap is pinned here deliberately.
 *
 * No jsdom: the module only needs `window` to exist and a `localStorage` to
 * read, both stubbed below, plus an adapter that never opens a socket. Globals
 * are installed before the dynamic import because zustand's `persist` reads
 * storage at module-evaluation time.
 */

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
  key: (i: number) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size;
  },
};

const locationStub = { pathname: '/dashboard', href: '' };

vi.mock('@/lib/permissionError', () => ({
  triggerPermissionError: vi.fn(),
}));

let axiosInstance: AxiosInstance;
let triggerPermissionError: ReturnType<typeof vi.fn>;
let useBranchStore: typeof import('@/store/branchStore')['useBranchStore'];
let useDevModeStore: typeof import('@/store/devModeStore')['useDevModeStore'];

beforeAll(async () => {
  vi.stubGlobal('localStorage', localStorageStub);
  vi.stubGlobal('window', { localStorage: localStorageStub, location: locationStub });

  // Analytics is off unless a measurement id is configured, and `config.ts`
  // reads it at module scope — so it has to be set before axios is imported,
  // otherwise the interceptor's tracking is a no-op and proves nothing.
  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = 'G-TEST123456';

  axiosInstance = (await import('@/lib/axios')).default;
  triggerPermissionError = (await import('@/lib/permissionError'))
    .triggerPermissionError as unknown as ReturnType<typeof vi.fn>;
  useBranchStore = (await import('@/store/branchStore')).useBranchStore;
  useDevModeStore = (await import('@/store/devModeStore')).useDevModeStore;
});

/** Captures the config the adapter was handed, then answers with `body`. */
function respondWith(body: unknown, status = 200) {
  const seen: { config?: Record<string, unknown> } = {};
  axiosInstance.defaults.adapter = async (config) => {
    seen.config = config as unknown as Record<string, unknown>;
    return {
      data: body,
      status,
      statusText: 'OK',
      headers: {},
      config,
    } as never;
  };
  return seen;
}

/** Answers with an AxiosError-shaped rejection, as a real transport would. */
function failWith(status: number, data: unknown = {}, message = 'Request failed') {
  axiosInstance.defaults.adapter = async (config) => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw Object.assign(new Error(message), {
      isAxiosError: true,
      config,
      response: { status, data, statusText: '', headers: {}, config },
    });
  };
}

/** The headers the request interceptor actually produced. */
function headersOf(seen: { config?: Record<string, unknown> }): Record<string, unknown> {
  const raw = seen.config?.headers as { toJSON?: () => Record<string, unknown> } | undefined;
  return (raw?.toJSON ? raw.toJSON() : (raw as Record<string, unknown>)) ?? {};
}

function setUserRole(role: string | null) {
  if (role === null) storage.delete('user');
  else storage.set('user', JSON.stringify({ id: 'u1', role }));
}

beforeEach(() => {
  storage.clear();
  locationStub.pathname = '/dashboard';
  locationStub.href = '';
  useBranchStore.setState({ selectedBranchId: null });
  useDevModeStore.getState().clear();
  vi.mocked(triggerPermissionError).mockClear();
});

describe('request interceptor — Authorization', () => {
  it('attaches the bearer token when one is stored', async () => {
    storage.set('accessToken', 'tok-123');
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/employees');

    expect(headersOf(seen).Authorization).toBe('Bearer tok-123');
  });

  it('sends no Authorization header when no token is stored', async () => {
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/employees');

    expect(headersOf(seen).Authorization).toBeUndefined();
  });
});

describe('request interceptor — X-Branch-Id', () => {
  it('sends the selected branch for an ADMIN', async () => {
    setUserRole('ADMIN');
    useBranchStore.setState({ selectedBranchId: 'br-42' });
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/employees');

    expect(headersOf(seen)['X-Branch-Id']).toBe('br-42');
  });

  it('sends it for an HR_MANAGER too', async () => {
    setUserRole('HR_MANAGER');
    useBranchStore.setState({ selectedBranchId: 'br-42' });
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/employees');

    expect(headersOf(seen)['X-Branch-Id']).toBe('br-42');
  });

  it.each(['MANAGER', 'EMPLOYEE'])('withholds it from a %s, who is pinned server-side', async (role) => {
    // The regression this guards: a stale selection outliving an admin's
    // session, inherited by the next user, who then 403s on every request.
    setUserRole(role);
    useBranchStore.setState({ selectedBranchId: 'br-42' });
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/employees');

    expect(headersOf(seen)['X-Branch-Id']).toBeUndefined();
  });

  it('sends nothing when no branch is selected — absent means "server default"', async () => {
    setUserRole('ADMIN');
    useBranchStore.setState({ selectedBranchId: null });
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/employees');

    expect(headersOf(seen)['X-Branch-Id']).toBeUndefined();
  });

  it('survives a corrupt user blob without sending the header or throwing', async () => {
    storage.set('user', '{not json');
    useBranchStore.setState({ selectedBranchId: 'br-42' });
    const seen = respondWith({ success: true, data: null });

    await expect(axiosInstance.get('/employees')).resolves.toBeDefined();
    expect(headersOf(seen)['X-Branch-Id']).toBeUndefined();
  });

  it('sends nothing when the user blob is absent entirely', async () => {
    setUserRole(null);
    useBranchStore.setState({ selectedBranchId: 'br-42' });
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/employees');

    expect(headersOf(seen)['X-Branch-Id']).toBeUndefined();
  });
});

describe('request interceptor — X-Dev-Token', () => {
  it('attaches a live elevation token', async () => {
    useDevModeStore.getState().elevate('dev-tok', new Date(Date.now() + 60_000).toISOString());
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/system-settings');

    expect(headersOf(seen)['X-Dev-Token']).toBe('dev-tok');
  });

  it('sends nothing while locked', async () => {
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/system-settings');

    expect(headersOf(seen)['X-Dev-Token']).toBeUndefined();
  });

  it('sends nothing once the token has expired', async () => {
    // `currentDevToken()` re-checks expiry on every request, so an expired
    // elevation stops being sent even before the force-lock timer fires.
    useDevModeStore.setState({ devToken: 'stale', expiresAt: Date.now() - 1 });
    const seen = respondWith({ success: true, data: null });

    await axiosInstance.get('/system-settings');

    expect(headersOf(seen)['X-Dev-Token']).toBeUndefined();
  });
});

describe('response interceptor — success', () => {
  it('unwraps the envelope, so callers receive { success, data }', async () => {
    respondWith({ success: true, data: { id: 'e1' }, message: 'ok' });

    const result = (await axiosInstance.get('/employees/e1')) as unknown as {
      success: boolean;
      data: { id: string };
    };

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 'e1' });
  });

  it('passes a blob response through untouched, keeping .data for the caller', async () => {
    // File downloads (payslips, the WPS wage file) rely on this bypass; the
    // unwrap would hand the caller the blob's *contents* rather than the
    // response, losing the headers a download needs.
    respondWith('binary-ish');

    const response = (await axiosInstance.get('/wps/files/1/download', {
      responseType: 'blob',
    })) as unknown as { data: string; status: number };

    expect(response.status).toBe(200);
    expect(response.data).toBe('binary-ish');
  });
});

describe('response interceptor — the flat error shape', () => {
  it('rejects with a flat object carrying statusCode and message', async () => {
    failWith(400, { message: 'Employee code already exists', errors: { employeeCode: 'taken' } });

    await expect(axiosInstance.post('/employees', {})).rejects.toMatchObject({
      success: false,
      statusCode: 400,
      message: 'Employee code already exists',
      errors: { employeeCode: 'taken' },
    });
  });

  it('has NO .response — which is why err.response.data.message reads undefined', async () => {
    // The documented trap. Callers written against an AxiosError silently fall
    // through to their generic fallback string and hide the real reason.
    failWith(400, { message: 'Employee code already exists' });

    const err = await axiosInstance.post('/employees', {}).catch((e) => e);

    expect(err.response).toBeUndefined();
    expect(err.message).toBe('Employee code already exists');
  });

  it('preserves the whole body under .details so nothing is lost to flattening', async () => {
    // WPS pre-flight returns its findings in the error body; the screen
    // re-renders them from here.
    const body = { message: 'Pre-flight failed', findings: [{ code: 'NO_IBAN', severity: 'BLOCKING' }] };
    failWith(422, body);

    const err = await axiosInstance.post('/wps/generate', {}).catch((e) => e);

    expect(err.details).toEqual(body);
    expect(err.statusCode).toBe(422);
  });

  it('falls back to the transport message when the body has none', async () => {
    failWith(500, {}, 'Network Error');

    const err = await axiosInstance.get('/employees').catch((e) => e);

    expect(err.message).toBe('Network Error');
    expect(err.statusCode).toBe(500);
  });

  it('records the request path', async () => {
    failWith(404, { message: 'Not found' });

    const err = await axiosInstance.get('/employees/missing').catch((e) => e);

    expect(err.path).toBe('/employees/missing');
  });
});

describe('response interceptor — 401', () => {
  it('clears the session and redirects to login', async () => {
    storage.set('accessToken', 'tok');
    storage.set('refreshToken', 'tok');
    storage.set('user', '{}');
    failWith(401, { message: 'Unauthorized' });

    await axiosInstance.get('/employees').catch(() => {});

    expect(storage.has('accessToken')).toBe(false);
    expect(storage.has('refreshToken')).toBe(false);
    expect(storage.has('user')).toBe(false);
    expect(locationStub.href).toBe('/login');
  });

  it('does not redirect when already on the login page', async () => {
    // Avoids a reload loop when the login request itself 401s on bad credentials.
    locationStub.pathname = '/login';
    failWith(401, { message: 'Invalid credentials' });

    await axiosInstance.post('/auth/login', {}).catch(() => {});

    expect(locationStub.href).toBe('');
  });

  it('leaves the session alone for a /dev-mode/ 401', async () => {
    // A wrong developer password must not sign the admin out of the app.
    storage.set('accessToken', 'tok');
    storage.set('user', '{}');
    failWith(401, { message: 'Wrong developer password' });

    await axiosInstance.post('/dev-mode/elevate', {}).catch(() => {});

    expect(storage.get('accessToken')).toBe('tok');
    expect(storage.has('user')).toBe(true);
    expect(locationStub.href).toBe('');
  });
});

describe('response interceptor — 403', () => {
  it('raises the permission-denied modal with the server’s message', async () => {
    failWith(403, { message: 'You do not have access to the selected branch' });

    await axiosInstance.get('/payrolls').catch(() => {});

    expect(triggerPermissionError).toHaveBeenCalledWith('You do not have access to the selected branch');
  });

  it('stays silent for a /dev-mode/ 403, which the dialog reports itself', async () => {
    // Otherwise the generic Access Denied modal pops over settings tabs that
    // are hidden deliberately.
    failWith(403, { message: 'Not elevated' });

    await axiosInstance.get('/dev-mode/status').catch(() => {});

    expect(triggerPermissionError).not.toHaveBeenCalled();
  });

  it('still rejects with the flat error after raising the modal', async () => {
    failWith(403, { message: 'Forbidden' });

    await expect(axiosInstance.get('/payrolls')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Forbidden',
    });
  });
});

/**
 * Analytics on the mutation path.
 *
 * This interceptor is the ONLY place ESS actions are measured, so the two
 * things that matter are that a write is recorded at all and that nothing
 * about the record travels with it.
 */
describe('response interceptor — analytics', () => {
  /** Every gtag command that reached the queue, as `[name, ...args]`. */
  function commands(): unknown[][] {
    const queue = (globalThis.window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
    return queue.map((entry) => Array.from(entry as ArrayLike<unknown>));
  }

  function events(): Array<[string, Record<string, unknown>]> {
    return commands()
      .filter((c) => c[0] === 'event')
      .map((c) => [c[1] as string, (c[2] ?? {}) as Record<string, unknown>]);
  }

  beforeEach(() => {
    (globalThis.window as unknown as { dataLayer?: unknown[] }).dataLayer = [];
  });

  it('names the journeys product asks about, with no id in the endpoint', async () => {
    respondWith({ success: true, data: null });

    await axiosInstance.post('/leave-requests/3f9a1c2e-1b44-4d0a-9e77-2b6f9c1d5a10/approve', {
      comment: 'Approved by manager',
    });

    expect(events()).toEqual([
      [
        'leave_request_decided',
        {
          module: 'leave',
          endpoint: '/leave-requests/:id/approve',
          method: 'POST',
          status: 200,
          outcome: 'success',
        },
      ],
    ]);
  });

  it('falls back to a generic api_action for an unnamed write', async () => {
    respondWith({ success: true, data: null });

    await axiosInstance.patch('/employees/42', { position: 'Analyst' });

    expect(events()[0][0]).toBe('api_action');
    expect(events()[0][1]).toMatchObject({ module: 'people', endpoint: '/employees/:id' });
  });

  it('records a failed write, which is where a journey breaks', async () => {
    failWith(422, { message: 'Overlapping leave' });

    await axiosInstance.post('/leave-requests', {}).catch(() => {});

    expect(events()[0]).toEqual([
      'leave_request_submitted',
      {
        module: 'leave',
        endpoint: '/leave-requests',
        method: 'POST',
        status: 422,
        outcome: 'failure',
      },
    ]);
  });

  it('ignores reads — page_view already counts those', async () => {
    respondWith({ success: true, data: [] });

    await axiosInstance.get('/employees?search=Jane%20Doe');

    expect(events()).toEqual([]);
  });

  it('never carries the request body, however sensitive', async () => {
    respondWith({ success: true, data: null });

    await axiosInstance.post('/payrolls', {
      employeeName: 'Jane Doe',
      netPay: 4200,
      iban: 'GB29NWBK60161331926819',
    });

    const payload = JSON.stringify(commands());
    expect(payload).not.toContain('Jane Doe');
    expect(payload).not.toContain('4200');
    expect(payload).not.toContain('GB29NWBK60161331926819');
  });

  it('does not fail the request when the analytics queue throws', async () => {
    (globalThis.window as unknown as { dataLayer?: unknown }).dataLayer = {
      push: () => {
        throw new Error('blocked by extension');
      },
    };
    respondWith({ success: true, data: { id: 'p1' } });

    await expect(axiosInstance.post('/payrolls', {})).resolves.toMatchObject({
      success: true,
    });
  });
});
