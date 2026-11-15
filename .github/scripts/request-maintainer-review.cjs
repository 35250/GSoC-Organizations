const MAINTAINER = 'rohanmalhotracodes';
const MARKER = '<!-- gsoc-organizations-review-request -->';
const CLA_PHRASE = 'I have read and agree to the Contributor License Agreement';
const CHECKS = ['Quality checks', 'Verify linked issue assignment'];

function isReviewRequest(body = '') {
  const command = body.trim().replace(/\s+/g, ' ').toLowerCase();
  return (
    /^\/(?:review|request-review)$/.test(command) ||
    /^(?:please )?(?:review|request (?:for )?review|ready for review|review please)[.!]?$/.test(
      command,
    ) ||
    new RegExp(
      `^@${MAINTAINER} (?:please )?(?:review|request (?:for )?review|could (?:you|u) take (?:a )?(?:second|2nd) look(?: on this)?)[.!]?$`,
    ).test(command)
  );
}

const sameLogin = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const reviewable = (pull) =>
  pull.state === 'open' &&
  pull.base.ref === 'main' &&
  !pull.draft &&
  !sameLogin(pull.user.login, MAINTAINER) &&
  pull.user.type !== 'Bot';

async function resolve({ github, context, core }) {
  const { owner, repo } = context.repo;
  const payload = context.payload;
  let pullNumber = payload.pull_request?.number;
  let explicit = false;

  if (context.eventName === 'workflow_dispatch') {
    pullNumber = Number(payload.inputs?.pull_number);
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) return;
  } else if (context.eventName === 'issue_comment') {
    const comment = payload.comment;
    if (!payload.issue?.pull_request || comment.user.type === 'Bot') return;
    explicit = isReviewRequest(comment.body);
    if (!explicit && comment.body.trim() !== CLA_PHRASE) return;
    pullNumber = payload.issue.number;
  } else if (context.eventName === 'workflow_run') {
    const run = payload.workflow_run;
    if (!['pull_request', 'pull_request_target'].includes(run.event)) return;
    // Fork CI events can omit pull_requests, and the commit association API can
    // also return no matches. Match the current SHA against open base-repo PRs.
    const pulls = await github.paginate(github.rest.pulls.list, {
      owner,
      repo,
      state: 'open',
      base: 'main',
      per_page: 100,
    });
    pullNumber = pulls.find(
      (pull) =>
        pull.head.sha === run.head_sha &&
        (!run.head_branch || pull.head.ref === run.head_branch),
    )?.number;
  }

  if (!pullNumber) {
    core.notice('No current open pull request matches this event.');
    return;
  }
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  if (!reviewable(pull)) return;

  if (context.eventName === 'issue_comment') {
    const commenter = payload.comment.user.login;
    if (!sameLogin(commenter, pull.user.login)) {
      let permission;
      try {
        const { data } = await github.rest.repos.getCollaboratorPermissionLevel(
          {
            owner,
            repo,
            username: commenter,
          },
        );
        permission = data.permission;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (!['admin', 'maintain', 'write'].includes(permission)) {
        core.notice('Only the PR author or a maintainer can request review.');
        return;
      }
    }
  }

  core.setOutput('pull-number', String(pullNumber));
  core.setOutput('explicit-request', String(explicit));
}

function pendingRequirements(checks, statuses) {
  // API results can include older attempts. A new failed or running attempt
  // must take precedence over an earlier successful check with the same name.
  const latest = (items, name) =>
    items.filter(name).sort((a, b) => b.id - a.id)[0];
  return [
    ...CHECKS.flatMap((name) => {
      const check = latest(
        checks,
        (item) => item.name === name && item.app?.slug === 'github-actions',
      );
      const state = check?.conclusion ?? check?.status ?? 'not reported';
      return state === 'success' ? [] : [`${name}: ${state}`];
    }),
    ...(() => {
      const status = latest(
        statuses,
        (item) => item.context === 'CLA / signed',
      );
      return status?.state === 'success'
        ? []
        : [`CLA / signed: ${status?.state ?? 'not reported'}`];
    })(),
  ];
}

async function prepare({
  github,
  context,
  core,
  pullNumber,
  explicit = false,
}) {
  const { owner, repo } = context.repo;
  const params = { owner, repo, pull_number: Number(pullNumber) };
  const { data: pull } = await github.rest.pulls.get(params);
  if (!reviewable(pull)) return;
  const sha = pull.head.sha;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pull.number,
    per_page: 100,
  });
  const previous = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.body?.startsWith(MARKER),
  );
  async function reply(message) {
    const body = `${MARKER}\n${message}\n\nCommit: \`${sha}\`.`;
    if (previous?.body === body) return;
    if (previous) {
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: previous.id,
        body,
      });
    } else {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: pull.number,
        body,
      });
    }
  }

  const [checks, statuses] = await Promise.all([
    github.paginate(github.rest.checks.listForRef, {
      owner,
      repo,
      ref: sha,
      filter: 'latest',
      per_page: 100,
    }),
    github.paginate(github.rest.repos.listCommitStatusesForRef, {
      owner,
      repo,
      ref: sha,
      per_page: 100,
    }),
  ]);
  const pending = pendingRequirements(checks, statuses);
  if (pending.length) {
    await reply(
      `⏳ Review is waiting for the following checks:\n\n${pending.map((item) => `- ${item}`).join('\n')}\n\nI’ll request maintainer review automatically when all checks pass. After fixing any failures or signing the CLA, you can also comment \`/review\` to check again.`,
    );
    return;
  }

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...params,
    per_page: 100,
  });
  const maintainerReview = reviews
    .filter(
      (review) =>
        sameLogin(review.user?.login, MAINTAINER) &&
        review.commit_id === sha &&
        ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state),
    )
    .sort((a, b) => b.id - a.id)[0];
  if (maintainerReview?.state === 'APPROVED') {
    if (explicit || previous) {
      await reply('✅ The maintainer has already approved this commit.');
    }
    return;
  }
  if (maintainerReview?.state === 'CHANGES_REQUESTED' && !explicit) {
    await reply(
      '🛠️ Automated checks passed, but the maintainer requested changes to this commit. Address the review feedback, then comment `/review` when you are ready for another look.',
    );
    return;
  }

  // Re-read before writing a review: a push may have happened during API calls.
  async function stillCurrent() {
    const { data: current } = await github.rest.pulls.get(params);
    if (!reviewable(current) || current.head.sha !== sha) {
      core.notice('The pull request changed; a new check run will handle it.');
      return false;
    }
    return current;
  }
  if (!(await stillCurrent())) return;

  let approvalRecorded = reviews.some(
    (review) =>
      review.user?.login === 'github-actions[bot]' &&
      review.state === 'APPROVED' &&
      review.commit_id === sha,
  );
  if (!approvalRecorded) {
    try {
      await github.rest.pulls.createReview({
        ...params,
        commit_id: sha,
        event: 'APPROVE',
        body: 'Automated checks passed for this commit. This approval records automated checks only; a separate maintainer review is required before merging.',
      });
      approvalRecorded = true;
    } catch (error) {
      if (![403, 422].includes(error.status)) throw error;
      core.warning(
        `Automated approval could not be recorded: ${error.message}`,
      );
    }
  }

  const current = await stillCurrent();
  if (!current) return;
  if (
    !current.requested_reviewers.some((user) =>
      sameLogin(user.login, MAINTAINER),
    )
  ) {
    await github.rest.pulls.requestReviewers({
      ...params,
      reviewers: [MAINTAINER],
    });
  }
  await reply(
    `✅ Ready for maintainer review. All required automated checks passed, and review has been requested from @${MAINTAINER}.\n\n${approvalRecorded ? 'The automated checks approval is recorded.' : 'GitHub did not allow the automated approval; the maintainer review request was still sent.'} A human approval is still required before merging.`,
  );
  await core.summary
    .addHeading(`Pull request #${pull.number} is ready for maintainer review`)
    .addList([
      `Checks passed for ${sha}.`,
      `Review requested from @${MAINTAINER}.`,
      `Automated approval recorded: ${approvalRecorded}.`,
    ])
    .write();
}

module.exports = { isReviewRequest, pendingRequirements, resolve, prepare };
