import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  isReviewRequest,
  pendingRequirements,
  resolve,
  prepare,
} = require('../../.github/scripts/request-maintainer-review.cjs');

function fixture() {
  const pull = {
    number: 464,
    state: 'open',
    draft: false,
    base: { ref: 'main' },
    head: { sha: 'new-head', ref: '408' },
    user: { login: 'contributor', type: 'User' },
    requested_reviewers: [] as { login: string }[],
  };
  const checks = ['Quality checks', 'Verify linked issue assignment'].map(
    (name, index) => ({
      id: index + 1,
      name,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
    }),
  );
  const statuses = [{ id: 1, context: 'CLA / signed', state: 'success' }];
  const reviews: any[] = [];
  const comments: any[] = [];
  const rest = {
    pulls: {
      get: vi.fn(async () => ({ data: pull })),
      list: vi.fn(),
      listReviews: vi.fn(),
      createReview: vi.fn(async () => ({})),
      requestReviewers: vi.fn(async () => ({})),
    },
    issues: {
      listComments: vi.fn(),
      createComment: vi.fn(async () => ({})),
      updateComment: vi.fn(async () => ({})),
    },
    checks: { listForRef: vi.fn() },
    repos: {
      listCommitStatusesForRef: vi.fn(),
      getCollaboratorPermissionLevel: vi.fn(async () => ({
        data: { permission: 'read' },
      })),
    },
  };
  const github = {
    rest,
    paginate: vi.fn(async (method: unknown) => {
      if (method === rest.pulls.list) return [pull];
      if (method === rest.pulls.listReviews) return reviews;
      if (method === rest.issues.listComments) return comments;
      if (method === rest.checks.listForRef) return checks;
      if (method === rest.repos.listCommitStatusesForRef) return statuses;
      throw new Error('Unexpected API method');
    }),
  };
  const core = {
    notice: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
    summary: {
      addHeading: vi.fn().mockReturnThis(),
      addList: vi.fn().mockReturnThis(),
      write: vi.fn(),
    },
  };
  const context = {
    repo: { owner: 'rohanmalhotracodes', repo: 'GSoC-Organizations' },
    eventName: 'issue_comment',
    payload: {
      issue: { number: 464, pull_request: {} },
      comment: { body: '/review', user: pull.user },
    } as any,
  };
  return { github, core, context, pull, checks, statuses, reviews, comments };
}

describe('review comment commands', () => {
  it.each([
    '/review',
    ' /REQUEST-REVIEW\n',
    'please review',
    'request for review',
    '@rohanmalhotracodes review ',
    '@rohanmalhotracodes could u take a 2nd look on this',
  ])('accepts an explicit request: %s', (body) => {
    expect(isReviewRequest(body)).toBe(true);
  });

  it.each([
    'Thanks for the review',
    '> /review',
    '```\n/review\n```',
    '/review && arbitrary-command',
    '@someone-else review',
  ])('ignores other text: %s', (body) => {
    expect(isReviewRequest(body)).toBe(false);
  });

  it('lets the contributor request a review', async () => {
    const f = fixture();
    await resolve(f);
    expect(f.core.setOutput).toHaveBeenCalledWith('pull-number', '464');
    expect(f.core.setOutput).toHaveBeenCalledWith('explicit-request', 'true');
  });

  it('ignores an unauthorized user and bot-generated commands', async () => {
    const f = fixture();
    f.context.payload.comment.user = { login: 'stranger', type: 'User' };
    await resolve(f);
    expect(f.core.setOutput).not.toHaveBeenCalled();
    f.context.payload.comment.user.type = 'Bot';
    await resolve(f);
    expect(f.core.setOutput).not.toHaveBeenCalled();
  });

  it('accepts a maintainer request and the author CLA signature', async () => {
    const f = fixture();
    f.context.payload.comment.user = { login: 'maintainer', type: 'User' };
    f.github.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'write' },
    });
    await resolve(f);
    expect(f.core.setOutput).toHaveBeenCalledWith('explicit-request', 'true');
    f.core.setOutput.mockClear();
    f.context.payload.comment.user = f.pull.user;
    f.context.payload.comment.body =
      'I have read and agree to the Contributor License Agreement';
    await resolve(f);
    expect(f.core.setOutput).toHaveBeenCalledWith('explicit-request', 'false');
  });
});

describe('fork PR discovery', () => {
  it('finds an open fork PR even when workflow_run has no pull_requests', async () => {
    const f = fixture();
    f.context.eventName = 'workflow_run';
    f.context.payload = {
      workflow_run: {
        event: 'pull_request',
        head_sha: f.pull.head.sha,
        head_branch: f.pull.head.ref,
        pull_requests: [],
      },
    };
    await resolve(f);
    expect(f.core.setOutput).toHaveBeenCalledWith('pull-number', '464');
    f.context.payload.workflow_run.head_sha = 'stale-head';
    f.core.setOutput.mockClear();
    await resolve(f);
    expect(f.core.setOutput).not.toHaveBeenCalled();
  });

  it('supports manually checking an existing PR', async () => {
    const f = fixture();
    f.context.eventName = 'workflow_dispatch';
    f.context.payload = { inputs: { pull_number: '464' } };
    await resolve(f);
    expect(f.core.setOutput).toHaveBeenCalledWith('pull-number', '464');
  });
});

describe('readiness and notifications', () => {
  it('uses the newest check and status, not an earlier successful attempt', () => {
    const f = fixture();
    const pending = pendingRequirements(
      [
        { ...f.checks[0], id: 10, conclusion: null, status: 'in_progress' },
        ...f.checks,
      ],
      [{ ...f.statuses[0], id: 10, state: 'failure' }, ...f.statuses],
    );
    expect(pending).toEqual([
      'Quality checks: in_progress',
      'CLA / signed: failure',
    ]);
  });

  it('posts a waiting message without approval or review request on failure', async () => {
    const f = fixture();
    f.checks[0].conclusion = 'failure';
    await prepare({ ...f, pullNumber: 464, explicit: true });
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(f.github.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createComment.mock.calls[0][0]).toMatchObject({
      issue_number: 464,
      body: expect.stringContaining('Quality checks: failure'),
    });
  });

  it('requires the CLA and check results from GitHub Actions', async () => {
    const f = fixture();
    f.statuses.length = 0;
    f.checks[0].app.slug = 'another-app';
    await prepare({ ...f, pullNumber: 464, explicit: true });
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createComment.mock.calls[0][0]).toMatchObject({
      body: expect.stringContaining('CLA / signed: not reported'),
    });
    expect(f.github.rest.issues.createComment.mock.calls[0][0]).toMatchObject({
      body: expect.stringContaining('Quality checks: not reported'),
    });
  });

  it('does not overwrite a contributor comment containing the bot marker', async () => {
    const f = fixture();
    f.comments.push({
      id: 100,
      user: { login: 'contributor' },
      body: '<!-- gsoc-organizations-review-request -->\nPretend bot status',
    });
    await prepare({ ...f, pullNumber: 464 });
    expect(f.github.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createComment).toHaveBeenCalled();
  });

  it('approves only the checked commit, requests review, and posts confirmation', async () => {
    const f = fixture();
    await prepare({ ...f, pullNumber: 464, explicit: true });
    expect(f.github.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ commit_id: 'new-head', event: 'APPROVE' }),
    );
    expect(f.github.rest.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: ['rohanmalhotracodes'] }),
    );
    expect(f.github.rest.issues.createComment.mock.calls[0][0]).toMatchObject({
      body: expect.stringContaining('Ready for maintainer review'),
    });
  });

  it('updates one bot comment and avoids duplicate approvals or requests', async () => {
    const f = fixture();
    f.reviews.push({
      user: { login: 'github-actions[bot]' },
      state: 'APPROVED',
      commit_id: 'new-head',
    });
    f.pull.requested_reviewers = [{ login: 'rohanmalhotracodes' }];
    f.comments.push({
      id: 101,
      user: { login: 'github-actions[bot]' },
      body: '<!-- gsoc-organizations-review-request -->\nWaiting',
    });
    await prepare({ ...f, pullNumber: 464, explicit: true });
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(f.github.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(f.github.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 101 }),
    );
    f.comments[0].body =
      f.github.rest.issues.updateComment.mock.calls[0][0].body;
    f.github.rest.issues.updateComment.mockClear();
    await prepare({ ...f, pullNumber: 464, explicit: true });
    expect(f.github.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it('continues requesting human review if GitHub denies automated approval', async () => {
    const f = fixture();
    f.github.rest.pulls.createReview.mockRejectedValue({
      status: 403,
      message: 'Approval permission disabled',
    });
    await prepare({ ...f, pullNumber: 464 });
    expect(f.github.rest.pulls.requestReviewers).toHaveBeenCalled();
    expect(f.github.rest.issues.createComment.mock.calls[0][0]).toMatchObject({
      body: expect.stringContaining('did not allow the automated approval'),
    });
  });

  it('does not approve a head that changed while checks were being read', async () => {
    const f = fixture();
    f.github.rest.pulls.get
      .mockResolvedValueOnce({ data: f.pull })
      .mockResolvedValueOnce({
        data: { ...f.pull, head: { sha: 'pushed-later', ref: '408' } },
      });
    await prepare({ ...f, pullNumber: 464 });
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(f.github.rest.pulls.requestReviewers).not.toHaveBeenCalled();
  });

  it.each(['APPROVED', 'CHANGES_REQUESTED'])(
    'respects a current maintainer review: %s',
    async (state) => {
      const f = fixture();
      f.reviews.push({
        id: 1,
        user: { login: 'rohanmalhotracodes' },
        state,
        commit_id: 'new-head',
      });
      await prepare({ ...f, pullNumber: 464 });
      expect(f.github.rest.pulls.requestReviewers).not.toHaveBeenCalled();
      if (state === 'CHANGES_REQUESTED') {
        await prepare({ ...f, pullNumber: 464, explicit: true });
        expect(f.github.rest.pulls.requestReviewers).toHaveBeenCalled();
      }
    },
  );

  it.each(['draft', 'closed', 'other-base'])(
    'ignores PRs that are not reviewable: %s',
    async (reason) => {
      const f = fixture();
      if (reason === 'draft') f.pull.draft = true;
      if (reason === 'closed') f.pull.state = 'closed';
      if (reason === 'other-base') f.pull.base.ref = 'other';
      await prepare({ ...f, pullNumber: 464 });
      expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
    },
  );
});
