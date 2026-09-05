import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import ProjectSprints from './ProjectSprints';
import type { ProjectAccess, Sprint } from '@/types/project';

/**
 * The sprint tab's state machine and its backlog sweep.
 *
 * Two findings meet on this screen and neither is visible from a screenshot:
 *
 * **R37** — `CANCELLED` was near-dead. It was reachable only through the generic
 * `PATCH /sprints/:id`, where it carried no message and no side effects, so
 * cancelling was indistinguishable from renaming and a CANCELLED sprint could be
 * started again. It is a real verb now (`PATCH /sprints/:id/cancel`, terminal),
 * and the client half of that is which buttons this tab offers in which state —
 * the cases below walk all four.
 *
 * **R39/R37** — closing a sprint detaches its still-open tasks in the same
 * transaction, and reports how many as `tasksReturnedToBacklog`, a SIBLING of
 * `data` on the envelope. A count read off `.data` reads `undefined` and the
 * sentence silently becomes "Sprint completed." — which is exactly the outcome
 * the finding is about: work moved and nobody was told. So the assertions here
 * are on the rendered sentence, not on the call.
 *
 * Stubs `@/lib/axios` rather than the services, because the envelope shape IS
 * the thing under test: stubbing `sprintService.complete` would let the test
 * hand the component a number that the real unwrap might never produce.
 */

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import axiosInstance from '@/lib/axios';

const get = vi.mocked(axiosInstance.get);
const patch = vi.mocked(axiosInstance.patch);

const PROJECT_ID = 'p-1';

const MANAGE: ProjectAccess = {
  isGlobalAdmin: false,
  isOwner: true,
  roleSlug: 'owner',
  permissions: ['SPRINT_MANAGE'],
};
const READ_ONLY: ProjectAccess = {
  isGlobalAdmin: false,
  isOwner: false,
  roleSlug: 'viewer',
  permissions: [],
};

const sprint = (id: string, status: Sprint['status'], name = `Sprint ${id}`): Sprint => ({
  id,
  name,
  status,
  isDefault: false,
  isArchived: false,
  projectId: PROJECT_ID,
  _count: { tasks: 4 },
});

/** Routes the two GETs the tab fires on mount: the roster's permissions and the list. */
function routeGets(sprints: Sprint[], access: ProjectAccess = MANAGE) {
  get.mockImplementation((url: string) => {
    if (url === `/projects/${PROJECT_ID}/my-permissions`) {
      return Promise.resolve({ success: true, data: access }) as never;
    }
    if (url === '/sprints') {
      return Promise.resolve({ success: true, data: sprints }) as never;
    }
    return Promise.resolve({ success: true, data: [] }) as never;
  });
}

/** The close envelope, with the count where the server actually puts it. */
function routeClose(tasksReturnedToBacklog: number, next: Sprint) {
  patch.mockResolvedValue({
    success: true,
    message: 'Sprint closed',
    data: next,
    tasksReturnedToBacklog,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the transitions the tab offers', () => {
  it('a PLANNING sprint offers Start and Cancel, and not Complete', async () => {
    routeGets([sprint('s-1', 'PLANNING')]);
    renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    expect(await screen.findByTestId('sprint-start-s-1')).toBeInTheDocument();
    expect(screen.getByTestId('sprint-cancel-s-1')).toBeInTheDocument();
    expect(screen.queryByTestId('sprint-complete-s-1')).not.toBeInTheDocument();
  });

  it('an ACTIVE sprint offers Complete and Cancel, and not Start', async () => {
    routeGets([sprint('s-2', 'ACTIVE')]);
    renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    expect(await screen.findByTestId('sprint-complete-s-2')).toBeInTheDocument();
    expect(screen.getByTestId('sprint-cancel-s-2')).toBeInTheDocument();
    expect(screen.queryByTestId('sprint-start-s-2')).not.toBeInTheDocument();
  });

  it('R37 — a CANCELLED sprint renders its state and offers no transition at all', async () => {
    routeGets([sprint('s-3', 'CANCELLED')]);
    renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    // The state is on screen: terminal is not the same as absent, and a sprint
    // that simply disappeared would be the old bug wearing a new coat.
    const badge = await screen.findByTestId('sprint-status-s-3');
    expect(badge).toHaveTextContent(/Cancelled/i);

    expect(screen.queryByTestId('sprint-start-s-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sprint-complete-s-3')).not.toBeInTheDocument();
    // Not re-cancellable either — CANCELLED is terminal exactly as COMPLETED is.
    expect(screen.queryByTestId('sprint-cancel-s-3')).not.toBeInTheDocument();
  });

  it('a COMPLETED sprint offers no transition, cancel included', async () => {
    routeGets([sprint('s-4', 'COMPLETED')]);
    renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    expect(await screen.findByTestId('sprint-status-s-4')).toHaveTextContent(/Completed/i);
    expect(screen.queryByTestId('sprint-start-s-4')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sprint-complete-s-4')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sprint-cancel-s-4')).not.toBeInTheDocument();
  });

  it('without SPRINT_MANAGE no verb is offered, cancel least of all', async () => {
    routeGets([sprint('s-5', 'ACTIVE')], READ_ONLY);
    renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    expect(await screen.findByTestId('sprint-row-s-5')).toBeInTheDocument();
    expect(screen.queryByTestId('sprint-cancel-s-5')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sprint-complete-s-5')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sprint-create')).not.toBeInTheDocument();
  });
});

describe('cancelling is confirmed before it is sent', () => {
  it('the Cancel button asks first and sends nothing on its own', async () => {
    routeGets([sprint('s-6', 'ACTIVE')]);
    const { user } = renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    await user.click(await screen.findByTestId('sprint-cancel-s-6'));
    expect(screen.getByTestId('sprint-cancel-confirm-s-6')).toBeInTheDocument();
    // The click that opens the confirmation is not the click that cancels.
    expect(patch).not.toHaveBeenCalled();
  });

  it('backing out of the confirmation cancels nothing', async () => {
    routeGets([sprint('s-7', 'PLANNING')]);
    const { user } = renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    await user.click(await screen.findByTestId('sprint-cancel-s-7'));
    await user.click(screen.getByTestId('sprint-cancel-no-s-7'));

    expect(screen.queryByTestId('sprint-cancel-confirm-s-7')).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it('confirming sends the cancel VERB, not a generic PATCH of the status', async () => {
    routeGets([sprint('s-8', 'ACTIVE')]);
    routeClose(0, sprint('s-8', 'CANCELLED'));
    const { user } = renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    await user.click(await screen.findByTestId('sprint-cancel-s-8'));
    await user.click(screen.getByTestId('sprint-cancel-yes-s-8'));

    // R37 in one assertion: the old route to CANCELLED was `PATCH /sprints/:id`
    // with a body, which the server now rejects outright.
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/sprints/s-8/cancel'));
  });
});

describe('R39/R37 — the backlog sweep is reported, not merely done', () => {
  it('completing names the number of open tasks that went back', async () => {
    routeGets([sprint('s-9', 'ACTIVE')]);
    routeClose(3, sprint('s-9', 'COMPLETED'));
    const { user } = renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    await user.click(await screen.findByTestId('sprint-complete-s-9'));

    const notice = await screen.findByTestId('sprint-close-notice');
    expect(notice).toHaveTextContent('3 open tasks returned to the backlog');
  });

  it('cancelling names it too — an abandoned sprint strands work exactly as a closed one does', async () => {
    routeGets([sprint('s-10', 'PLANNING')]);
    routeClose(1, sprint('s-10', 'CANCELLED'));
    const { user } = renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    await user.click(await screen.findByTestId('sprint-cancel-s-10'));
    await user.click(screen.getByTestId('sprint-cancel-yes-s-10'));

    const notice = await screen.findByTestId('sprint-close-notice');
    // Singular, because "1 open tasks" is how a user learns not to trust a screen.
    expect(notice).toHaveTextContent('1 open task returned to the backlog');
  });

  it('a sprint that finished everything says so without inventing a count', async () => {
    routeGets([sprint('s-11', 'ACTIVE')]);
    routeClose(0, sprint('s-11', 'COMPLETED'));
    const { user } = renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    await user.click(await screen.findByTestId('sprint-complete-s-11'));

    const notice = await screen.findByTestId('sprint-close-notice');
    expect(notice).toHaveTextContent('Sprint completed.');
    expect(notice).not.toHaveTextContent(/backlog/i);
  });

  it('the notice survives the reload and clears only when dismissed', async () => {
    routeGets([sprint('s-12', 'ACTIVE')]);
    routeClose(2, sprint('s-12', 'COMPLETED'));
    const { user } = renderWithProviders(<ProjectSprints projectId={PROJECT_ID} />);

    await user.click(await screen.findByTestId('sprint-complete-s-12'));
    const notice = await screen.findByTestId('sprint-close-notice');

    // The list refetches straight after the close — the sentence has to outlive
    // that, because the tasks disappear from the screen on the same render.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect(notice).toBeInTheDocument();

    await user.click(screen.getByTestId('sprint-close-notice-dismiss'));
    expect(screen.queryByTestId('sprint-close-notice')).not.toBeInTheDocument();
  });
});
